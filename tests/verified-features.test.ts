/**
 * Independent adversarial verification of feature #1 (Retry-After driven
 * cooldown + cooldown persistence) and feature #2 (search-result cache).
 *
 * Written from the CLAIM LIST, not from the authors' tests: every assertion
 * here encodes an externally observable promise, driven through the real
 * modules with fake clocks, injected results and real temp directories.
 *
 * Safety contract of this file:
 * - No network. `fetch` is stubbed per test and unstubbed afterwards; the
 *   Tavily transport is mocked at the SDK boundary.
 * - No live state. Every persistence test passes its OWN `mkdtempSync`
 *   directory into `writeState`/`readState`/`saveBoard`/`loadBoard`.
 *   `resolveStateDir` is never called and the live home is never addressed.
 * - The `writesDisabled` latch in `core/state.ts` is process-wide, so the
 *   "unwritable directory" probe runs against a FRESH module graph obtained
 *   with `vi.resetModules()` + dynamic import, leaving the statically imported
 *   modules (and every other test) unaffected.
 * - One test is deliberately RED: it encodes the documented claim "a hit
 *   carries no attempts[]" for the case where the cached fetch was itself a
 *   failover success. See the report: docs/verification-2026-09-27.md (F2).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { WebError, type WebSearchResult } from "@deepseek-ai/dsh-web";
import {
	CooldownBoard,
	DEFAULT_COOLDOWN_BASE_MS,
	DEFAULT_COOLDOWN_CAP_MS,
	loadBoard,
	markRetryAfter,
	parseRetryAfter,
	retryAfterMsOf,
	RETRY_AFTER_FLOOR_MS,
	saveBoard,
} from "../src/core/cooldown.js";
import { readState, writeState } from "../src/core/state.js";
import { cacheKey, ResultCache, canonicalize } from "../src/core/cache.js";
import { chainOf } from "../src/core/chain.js";
import { ExtensibleWebSearchProvider, type ResolvedOptions } from "../src/core/provider.js";
import { DeepSeekAdapter } from "../src/adapters/deepseek.js";
import { TavilyAdapter } from "../src/adapters/tavily.js";
import type { AdapterRuntime, SearchAdapter } from "../src/types.js";
import { TavilyKeylessLimitError } from "@tavily/core";

/** Tavily transport control; `tavily()` is the only SDK entry the adapter calls. */
const tavilyMock = vi.hoisted(() => ({
	search: undefined as undefined | ((query: string, params: unknown) => Promise<unknown>),
}));

vi.mock("@tavily/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tavily/core")>();
	return {
		...actual,
		tavily: () => ({
			search: (query: string, params: unknown) => tavilyMock.search!(query, params),
		}),
	};
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

/** A private temp directory; never the live state directory. */
function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vfeat-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

/** Monotonic fake clock the test moves by hand. */
function fakeClock(start = 1_000_000) {
	let now = start;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
		set: (value: number) => {
			now = value;
		},
	};
}

function stubAdapter(
	id: string,
	impl: (request: { query: string; maxResults?: number }, runtime: AdapterRuntime) => Promise<WebSearchResult>,
	overrides: Partial<SearchAdapter> = {},
): SearchAdapter {
	return {
		id,
		label: `stub ${id}`,
		requiresApiKey: false,
		defaultApiKeyEnv: `${id.toUpperCase()}_KEY`,
		baseURLEnv: `${id.toUpperCase()}_BASE_URL`,
		defaultBaseURL: `https://${id}.test`,
		available: () => true,
		search: impl,
		...overrides,
	};
}

function resolved(overrides: Partial<ResolvedOptions> & Pick<ResolvedOptions, "adapter">): ResolvedOptions {
	return {
		provider: overrides.adapter?.id ?? "stub",
		apiKeyEnv: "STUB_KEY",
		baseURL: "https://stub.test",
		settings: {},
		...overrides,
	};
}

/** Await a rejection and hand back the thrown value for inspection. */
async function rejection<T>(promise: Promise<T>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject, but it resolved");
}

function hasOwn(value: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

/** The additive degradation trail the chain and the cache attach to a result. */
interface TrailedResult extends WebSearchResult {
	readonly attempts?: readonly { adapterId: string; outcome: string }[];
	readonly warnings?: readonly string[];
}

function trail(result: WebSearchResult): TrailedResult {
	return result as TrailedResult;
}

afterEach(() => {
	vi.unstubAllGlobals();
	tavilyMock.search = undefined;
});

afterAll(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Claim 1 — Retry-After overrides the exponential estimate
// ---------------------------------------------------------------------------

describe("claim 1: Retry-After parsing (both RFC 9110 forms)", () => {
	const now = Date.UTC(2026, 8, 27, 12, 0, 0);

	it("delta-seconds becomes milliseconds", () => {
		expect(parseRetryAfter("120", now)).toBe(120_000);
		expect(parseRetryAfter("0", now)).toBe(0);
		expect(parseRetryAfter("  90  ", now)).toBe(90_000);
	});

	it("an HTTP-date becomes the remaining milliseconds", () => {
		const future = new Date(now + 75_000).toUTCString();
		expect(parseRetryAfter(future, now)).toBe(75_000);
	});

	it("edge (a): elapsed HTTP-date, negative delta and unparseable text", () => {
		const past = new Date(now - 60_000).toUTCString();
		expect(parseRetryAfter(past, now)).toBe(0);
		expect(parseRetryAfter("-5", now)).toBe(0);
		expect(parseRetryAfter("abc", now)).toBeUndefined();
		expect(parseRetryAfter("", now)).toBeUndefined();
		expect(parseRetryAfter("   ", now)).toBeUndefined();
		expect(parseRetryAfter(null, now)).toBeUndefined();
	});

	it("edge (a): an absurd delta stays finite and is left to the cap", () => {
		const parsed = parseRetryAfter("999999999999", now);
		expect(parsed).toBe(999_999_999_999_000);
		expect(parseRetryAfter(new Date(now + 10 * 365 * 86_400_000).toUTCString(), now)).toBeGreaterThan(DEFAULT_COOLDOWN_CAP_MS);
	});

	it("the signal carrier round-trips and rejects unusable values", () => {
		const error = new WebError("quota", "WEB_PROVIDER_ERROR");
		expect(retryAfterMsOf(error)).toBeUndefined();
		markRetryAfter(error, 4_000);
		expect(retryAfterMsOf(error)).toBe(4_000);
		markRetryAfter(error, undefined);
		expect(retryAfterMsOf(error)).toBe(4_000);
		expect(retryAfterMsOf({ retryAfterMs: Number.NaN })).toBeUndefined();
		expect(retryAfterMsOf({ retryAfterMs: -9 })).toBe(0);
		expect(retryAfterMsOf("nope")).toBeUndefined();
		expect(retryAfterMsOf(null)).toBeUndefined();
	});
});

describe("claim 1: the window the board records", () => {
	it("a server delay becomes the window, clamped to the 1 s floor and the cap", () => {
		const clock = fakeClock();
		const board = new CooldownBoard({ clock: clock.now });

		expect(board.onQuotaError("a", 0)).toBe(clock.now() + RETRY_AFTER_FLOOR_MS);
		expect(board.onQuotaError("b", 250)).toBe(clock.now() + RETRY_AFTER_FLOOR_MS);
		expect(board.onQuotaError("c", 120_000)).toBe(clock.now() + 120_000);
		expect(board.onQuotaError("d", DEFAULT_COOLDOWN_CAP_MS + 1)).toBe(clock.now() + DEFAULT_COOLDOWN_CAP_MS);
		expect(board.onQuotaError("e", Number.POSITIVE_INFINITY)).toBe(clock.now() + DEFAULT_COOLDOWN_BASE_MS);
	});

	it("without a signal the old base * 2^prior schedule is unchanged, cap included", () => {
		const clock = fakeClock();
		const board = new CooldownBoard({ clock: clock.now });
		expect(board.onQuotaError("x")).toBe(clock.now() + DEFAULT_COOLDOWN_BASE_MS);
		expect(board.onQuotaError("x")).toBe(clock.now() + 2 * DEFAULT_COOLDOWN_BASE_MS);
		expect(board.onQuotaError("x")).toBe(clock.now() + 4 * DEFAULT_COOLDOWN_BASE_MS);
		for (let i = 0; i < 20; i += 1) board.onQuotaError("x");
		expect(board.onQuotaError("x")).toBe(clock.now() + DEFAULT_COOLDOWN_CAP_MS);
	});

	it("a server window never rewrites the failure streak", () => {
		const clock = fakeClock();
		const board = new CooldownBoard({ clock: clock.now });
		expect(board.onQuotaError("x")).toBe(clock.now() + DEFAULT_COOLDOWN_BASE_MS);
		expect(board.onQuotaError("x", 5_000)).toBe(clock.now() + 5_000);
		// priorFailures is 2 here, so the estimate must be 4x base, not 2x.
		expect(board.onQuotaError("x")).toBe(clock.now() + 4 * DEFAULT_COOLDOWN_BASE_MS);
	});

	it("a success wipes both the streak and the window", () => {
		const clock = fakeClock();
		const board = new CooldownBoard({ clock: clock.now });
		board.onQuotaError("x", 60_000);
		board.onSuccess("x");
		expect(board.isCooling("x")).toBe(false);
		expect(board.onQuotaError("x")).toBe(clock.now() + DEFAULT_COOLDOWN_BASE_MS);
	});
});

describe("claim 1: the header is read at a real response site", () => {
	const runtime: AdapterRuntime = {
		apiKey: "k",
		apiKeyEnv: "DEEPSEEK_API_KEY",
		baseURL: "https://api.deepseek.test",
		settings: {},
	};

	it("deepseek turns a 429 Retry-After header into the error signal", async () => {
		vi.stubGlobal("fetch", async () =>
			new Response(JSON.stringify({ error: { message: "slow down" } }), {
				status: 429,
				headers: { "retry-after": "120" },
			}),
		);
		const error = await rejection(DeepSeekAdapter.search({ query: "q" }, runtime));
		expect(error).toBeInstanceOf(WebError);
		expect((error as WebError).code).toBe("WEB_PROVIDER_ERROR");
		expect(retryAfterMsOf(error)).toBe(120_000);
	});

	it("deepseek accepts the HTTP-date form too, and leaves the signal unset when absent", async () => {
		vi.stubGlobal("fetch", async () =>
			new Response("{}", { status: 503, headers: { "retry-after": new Date(Date.now() + 30_000).toUTCString() } }),
		);
		const withDate = await rejection(DeepSeekAdapter.search({ query: "q" }, runtime));
		expect(retryAfterMsOf(withDate)).toBeGreaterThan(29_000);
		expect(retryAfterMsOf(withDate)).toBeLessThanOrEqual(30_000);

		vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
		const withoutHeader = await rejection(DeepSeekAdapter.search({ query: "q" }, runtime));
		expect(retryAfterMsOf(withoutHeader)).toBeUndefined();
	});

	it("chain reads the signal at the member boundary, so the board gets the server window", async () => {
		vi.stubGlobal("fetch", async () => new Response("{}", { status: 429, headers: { "retry-after": "120" } }));
		const clock = fakeClock(500_000);
		const board = new CooldownBoard({ clock: clock.now });
		const backup = stubAdapter("backup", async () => ({ sources: [{ url: "https://backup.test/1" }], truncated: false }));
		const chain = chainOf([DeepSeekAdapter, backup], { cooldowns: board });
		expect(chain).toBeDefined();

		const result = await chain!.search({ query: "q" }, { ...runtime, apiKey: "k" });
		// The estimate would have been base (60 s); the server said 120 s.
		expect(board.coolingUntil("deepseek")).toBe(clock.now() + 120_000);
		expect((result as { attempts?: unknown[] }).attempts).toHaveLength(2);
	});

	it("deepseek still estimates when the header is missing, through the same boundary", async () => {
		vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
		const clock = fakeClock(500_000);
		const board = new CooldownBoard({ clock: clock.now });
		const backup = stubAdapter("backup", async () => ({ sources: [], truncated: false }));
		const chain = chainOf([DeepSeekAdapter, backup], { cooldowns: board })!;
		await chain.search({ query: "q" }, runtime);
		expect(board.coolingUntil("deepseek")).toBe(clock.now() + DEFAULT_COOLDOWN_BASE_MS);
	});
});

describe("claim 1: Tavily's body-derived retryAfter reaches the same signal", () => {
	const runtime: AdapterRuntime = {
		apiKey: undefined,
		apiKeyEnv: "TAVILY_API_KEY",
		baseURL: "https://api.tavily.test",
		settings: {},
	};

	function keylessLimit(retryAfter: number | null): TavilyKeylessLimitError {
		return new TavilyKeylessLimitError({
			message: "keyless limit",
			capType: "keyless_limit",
			retryAfter,
			bonusEligible: false,
			continuationPaths: [],
		});
	}

	it("maps seconds onto retryAfterMs and keeps the WebError taxonomy", async () => {
		tavilyMock.search = async () => {
			throw keylessLimit(45);
		};
		const error = await rejection(TavilyAdapter.search({ query: "q" }, runtime));
		expect(error).toBeInstanceOf(WebError);
		expect((error as WebError).code).toBe("WEB_PROVIDER_ERROR");
		expect(retryAfterMsOf(error)).toBe(45_000);
	});

	it("a null retryAfter leaves the estimate in charge", async () => {
		tavilyMock.search = async () => {
			throw keylessLimit(null);
		};
		const error = await rejection(TavilyAdapter.search({ query: "q" }, runtime));
		expect(retryAfterMsOf(error)).toBeUndefined();
	});

	it("the mapped window is what the board records, end to end", async () => {
		tavilyMock.search = async () => {
			throw keylessLimit(90);
		};
		const clock = fakeClock(700_000);
		const board = new CooldownBoard({ clock: clock.now });
		const backup = stubAdapter("backup", async () => ({ sources: [{ url: "https://b.test" }], truncated: false, warnings: [] }));
		const chain = chainOf([TavilyAdapter, backup], { cooldowns: board })!;
		await chain.search({ query: "q" }, runtime);
		expect(board.coolingUntil("tavily")).toBe(clock.now() + 90_000);
	});

	it("a plain SDK failure keeps whatever signal it carried", async () => {
		const plain = Object.assign(new Error("boom"), { retryAfter: 12 });
		tavilyMock.search = async () => {
			throw plain;
		};
		const error = await rejection(TavilyAdapter.search({ query: "q" }, runtime));
		expect(error).toBe(plain);
		expect(retryAfterMsOf(error)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Claim 2 — cooldown persistence across a restart
// ---------------------------------------------------------------------------

describe("claim 2: persist then load", () => {
	it("keeps a cooling adapter cooling for the remaining time", () => {
		const dir = tempDir("cooldown-roundtrip");
		const clock = fakeClock(2_000_000);
		const board = new CooldownBoard({ clock: clock.now });
		board.onQuotaError("tavily", 120_000);
		saveBoard(dir, board);

		const restarted = loadBoard(dir, { clock: () => clock.now() + 30_000 });
		expect(restarted.isCooling("tavily")).toBe(true);
		expect(restarted.coolingUntil("tavily")).toBe(2_000_000 + 120_000);
	});

	it("an expired window is dropped while the streak survives", () => {
		const dir = tempDir("cooldown-expired");
		const clock = fakeClock(3_000_000);
		const board = new CooldownBoard({ clock: clock.now });
		board.onQuotaError("tavily");
		saveBoard(dir, board);

		const restartedNow = clock.now() + DEFAULT_COOLDOWN_BASE_MS + 1;
		const restarted = loadBoard(dir, { clock: () => restartedNow });
		expect(restarted.isCooling("tavily")).toBe(false);
		expect(restarted.coolingUntil("tavily")).toBeUndefined();
		// The surviving streak rounds the NEXT window up: 2x base, not 1x.
		expect(restarted.onQuotaError("tavily")).toBe(restartedNow + 2 * DEFAULT_COOLDOWN_BASE_MS);
	});

	it("edge (c): an until beyond the cap is dropped, at the cap it is kept", () => {
		const dir = tempDir("cooldown-cap");
		const clock = fakeClock(4_000_000);
		const board = new CooldownBoard({ clock: clock.now });
		board.onQuotaError("a", DEFAULT_COOLDOWN_CAP_MS);
		board.onQuotaError("b", DEFAULT_COOLDOWN_CAP_MS);
		writeState(dir, { version: 1, cooldown: board.toState() });

		const raw = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
		raw.cooldown.adapters.a.until = clock.now() + DEFAULT_COOLDOWN_CAP_MS;
		raw.cooldown.adapters.b.until = clock.now() + DEFAULT_COOLDOWN_CAP_MS + 1;
		fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(raw));

		const restarted = loadBoard(dir, { clock: clock.now });
		expect(restarted.coolingUntil("a")).toBe(clock.now() + DEFAULT_COOLDOWN_CAP_MS);
		expect(restarted.coolingUntil("b")).toBeUndefined();
	});

	it("edge (c): an adapter id that no longer exists is inert", () => {
		const dir = tempDir("cooldown-stale-id");
		const clock = fakeClock(5_000_000);
		const board = new CooldownBoard({ clock: clock.now });
		board.onQuotaError("retired-vendor", 60_000);
		board.onQuotaError("tavily", 60_000);
		saveBoard(dir, board);

		const restarted = loadBoard(dir, { clock: clock.now });
		expect(restarted.isCooling("retired-vendor")).toBe(true);
		expect(restarted.isCooling("tavily")).toBe(true);
		// A chain that no longer contains the retired id is unaffected by it.
		const live = stubAdapter("tavily", async () => ({ sources: [], truncated: false }));
		const backup = stubAdapter("backup", async () => ({ sources: [{ url: "https://b.test" }], truncated: false }));
		const chain = chainOf([live, backup], { cooldowns: restarted })!;
		return chain.search({ query: "q" }, { apiKeyEnv: "X", settings: {} } as AdapterRuntime).then(() => {
			expect(restarted.isCooling("retired-vendor")).toBe(true);
		});
	});

	it("a restored board makes the chain skip the cooling member after a restart", async () => {
		const dir = tempDir("cooldown-chain");
		const clock = fakeClock(6_000_000);
		const first = new CooldownBoard({ clock: clock.now });
		first.onQuotaError("primary", 60_000);
		saveBoard(dir, first);

		const restarted = loadBoard(dir, { clock: () => clock.now() + 1_000 });
		let primaryCalls = 0;
		const primary = stubAdapter("primary", async () => {
			primaryCalls += 1;
			return { sources: [{ url: "https://primary.test" }], truncated: false };
		});
		const backup = stubAdapter("backup", async () => ({ sources: [{ url: "https://backup.test" }], truncated: false }));
		const chain = chainOf([primary, backup], { cooldowns: restarted })!;

		const result = (await chain.search({ query: "q" }, { apiKeyEnv: "X", settings: {} } as AdapterRuntime)) as WebSearchResult & {
			attempts?: { adapterId: string; outcome: string }[];
			warnings?: string[];
		};
		expect(primaryCalls).toBe(0);
		expect(result.sources[0]?.url).toBe("https://backup.test");
		expect(result.attempts?.some((attempt) => attempt.outcome === "skipped")).toBe(true);
		expect(result.warnings?.some((warning) => warning.includes("primary cooling until"))).toBe(true);
	});
});

describe("claim 2: damaged state degrades to memory-only", () => {
	it("an absent document starts cold", () => {
		expect(loadBoard(tempDir("absent")).isCooling("tavily")).toBe(false);
	});

	it("edge (b): a document truncated mid-JSON starts cold", () => {
		const dir = tempDir("truncated");
		fs.writeFileSync(path.join(dir, "state.json"), '{"version":1,"cooldown":{"adapters":{"tavily":{"failures":3,"unt');
		expect(readState(dir)).toBeUndefined();
		expect(loadBoard(dir).isCooling("tavily")).toBe(false);
	});

	it("edge (b): valid JSON of the wrong shape starts cold", () => {
		// Documents whose root is not an object are refused outright.
		const nonObjects: string[] = ['"just a string"', "123", "null", "true", "[1,2,3]"];
		for (const [index, body] of nonObjects.entries()) {
			const dir = tempDir(`non-object-${index}`);
			fs.writeFileSync(path.join(dir, "state.json"), body);
			expect(readState(dir), `non-object ${index}: ${body}`).toBeUndefined();
			expect(loadBoard(dir).isCooling("tavily"), `non-object ${index}: ${body}`).toBe(false);
		}

		// Object roots without the promised versioned shape are also refused, and
		// an object WITH a version but an unusable cooldown slice still loads cold.
		const objects: string[] = [
			'{"cooldown":{"adapters":{"tavily":{"failures":1}}}}',
			'{"version":"1","cooldown":{"adapters":{"tavily":{"failures":1,"until":9999999999999}}}}',
			'{"version":1,"cooldown":"nope"}',
			'{"version":1,"cooldown":{"adapters":[]}}',
			'{"version":1,"cooldown":{"adapters":{"tavily":"nope"}}}',
			'{"version":1,"cooldown":{"adapters":{"tavily":{"failures":"3","until":9999999999999}}}}',
			'{"version":1,"cooldown":{"adapters":{"tavily":{"failures":-2,"until":9999999999999}}}}',
		];
		for (const [index, body] of objects.entries()) {
			const dir = tempDir(`shape-${index}`);
			fs.writeFileSync(path.join(dir, "state.json"), body);
			expect(loadBoard(dir).isCooling("tavily"), `case ${index}: ${body}`).toBe(false);
		}
	});

	it("edge (b): a non-numeric failures value drops the entry but keeps its siblings", () => {
		const dir = tempDir("bad-failures");
		const clock = fakeClock(7_000_000);
		writeState(dir, {
			version: 1,
			cooldown: {
				adapters: {
					broken: { failures: "3", until: clock.now() + 60_000 },
					valid: { failures: 1, until: clock.now() + 60_000 },
					alsoBroken: { failures: Number.NaN, until: clock.now() + 60_000 },
				},
			},
		});
		const board = loadBoard(dir, { clock: clock.now });
		expect(board.isCooling("broken")).toBe(false);
		expect(board.isCooling("alsoBroken")).toBe(false);
		expect(board.coolingUntil("valid")).toBe(clock.now() + 60_000);
		// `broken` keeps no streak either, so its next window is the base one.
		expect(board.onQuotaError("broken")).toBe(clock.now() + DEFAULT_COOLDOWN_BASE_MS);
	});

	it("a state document that cannot be written leaves the search working", async () => {
		// Fresh module graph: the writesDisabled latch must not leak into the
		// other tests (or into the statically imported modules above).
		vi.resetModules();
		const stateMod = await import("../src/core/state.js");
		const cooldownMod = await import("../src/core/cooldown.js");

		const blockedParent = path.join(tempDir("unwritable"), "a-file");
		fs.writeFileSync(blockedParent, "not a directory");
		const blocked = path.join(blockedParent, "state");
		const writable = tempDir("writable-after-latch");

		const clock = fakeClock(8_000_000);
		const board = new cooldownMod.CooldownBoard({ clock: clock.now });
		board.onQuotaError("tavily", 60_000);

		expect(() => cooldownMod.saveBoard(blocked, board)).not.toThrow();
		expect(stateMod.readState(blocked)).toBeUndefined();
		expect(fs.existsSync(path.join(blockedParent, "state"))).toBe(false);

		// The documented latch: one failed write disables persistence for the
		// whole process, even towards a directory that IS writable.
		stateMod.writeState(writable, { version: 1, cooldown: board.toState() });
		expect(stateMod.readState(writable)).toBeUndefined();

		// ...and a search still succeeds with the board/cache in memory only.
		const adapter = stubAdapter("tavily", async () => ({ sources: [{ url: "https://fresh.test/1" }], truncated: false }));
		const cache = new (await import("../src/core/cache.js")).ResultCache({ clock: clock.now });
		const provider = new ExtensibleWebSearchProvider(
			() => resolved({ adapter, provider: "tavily" }),
			cache,
			() => cooldownMod.saveBoard(blocked, board),
		);
		const result = await provider.search({ query: "still works" });
		expect(result.sources[0]?.url).toBe("https://fresh.test/1");
		expect(fs.existsSync(path.join(blockedParent, "state"))).toBe(false);
	});

	it("publishing the cooldown slice keeps the cache slice (read-modify-write)", () => {
		const dir = tempDir("rmw");
		const clock = fakeClock(9_000_000);
		const cache = new ResultCache({ clock: clock.now });
		cache.set("k", { sources: [], truncated: false });
		writeState(dir, { version: 1, cache: cache.toState() });

		const board = new CooldownBoard({ clock: clock.now });
		board.onQuotaError("tavily", 60_000);
		saveBoard(dir, board);

		const after = readState(dir);
		expect(after?.cooldown).toBeDefined();
		expect(after?.cache).toBeDefined();
		const restoredCache = ResultCache.fromState(after?.cache, { clock: clock.now });
		expect(restoredCache.get("k")).toEqual({ sources: [], truncated: false });
	});
});

describe("state document writes (temp file naming)", () => {
	it("survives concurrent writers in separate processes and stays a single valid document", async () => {
		const dir = tempDir("multiproc");
		const modulePath = path.resolve(__dirname, "..", "src", "core", "state.ts");
		const children = 6;
		const writes = 25;

		const run = (index: number) =>
			new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
				const script = `
import { writeState, readState } from ${JSON.stringify(modulePath)};
const dir = ${JSON.stringify(dir)};
const writer = "w${index}";
const pad = writer.repeat(4000);
for (let i = 0; i < ${writes}; i += 1) writeState(dir, { version: 1, cache: { version: 1, entries: [], pad }, cooldown: { adapters: { [writer]: { failures: i } } } });
const doc = readState(dir);
if (doc === undefined) { console.log("INVALID"); process.exit(1); }
const ids = Object.keys(doc.cooldown.adapters);
const consistent = ids.length === 1 && doc.cache.pad === ids[0].repeat(4000);
console.log(consistent ? "consistent" : "MIXED");
if (!consistent) process.exit(2);
`;
				const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (chunk) => {
					stdout += String(chunk);
				});
				child.stderr.on("data", (chunk) => {
					stderr += String(chunk);
				});
				child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr }));
			});

		const results = await Promise.all(Array.from({ length: children }, (_, index) => run(index)));
		expect(results.map((result) => result.stdout)).toEqual(Array(children).fill("consistent"));
		expect(results.map((result) => result.code)).toEqual(Array(children).fill(0));
		expect(fs.readdirSync(dir).filter((file) => file.endsWith(".tmp"))).toEqual([]);
		expect(readState(dir)).toBeDefined();
	}, 60_000);
});

// ---------------------------------------------------------------------------
// Claim 3 — cache identity, TTL, LRU
// ---------------------------------------------------------------------------

describe("claim 3: cache identity", () => {
	it("an identical request plus config hits; the adapter runs once", async () => {
		let calls = 0;
		const adapter = stubAdapter("tavily", async () => {
			calls += 1;
			return { sources: [{ url: "https://a.test/1" }], truncated: false };
		});
		const cache = new ResultCache();
		const provider = new ExtensibleWebSearchProvider(() => resolved({ adapter, provider: "tavily" }), cache);
		await provider.search({ query: "same", maxResults: 3 });
		const second = await provider.search({ query: "same", maxResults: 3 });
		expect(calls).toBe(1);
		expect(trail(second).warnings).toContain("cache hit (age 0s)");
	});

	it("a changed top-level setting misses", async () => {
		let calls = 0;
		const adapter = stubAdapter("tavily", async () => {
			calls += 1;
			return { sources: [], truncated: false };
		});
		const cache = new ResultCache();
		let maxResults = 5;
		const provider = new ExtensibleWebSearchProvider(() => resolved({ adapter, provider: "tavily", settings: { maxResults } }), cache);
		await provider.search({ query: "same" });
		maxResults = 9;
		await provider.search({ query: "same" });
		expect(calls).toBe(2);
	});

	it("a changed request misses (key order is irrelevant, array order is not)", async () => {
		let calls = 0;
		const adapter = stubAdapter("tavily", async () => {
			calls += 1;
			return { sources: [], truncated: false };
		});
		const options = resolved({ adapter, provider: "tavily" });
		const cache = new ResultCache();
		// Request objects only carry `query`/`maxResults`, so drive cacheKey directly
		// for the canonicalisation claims and keep the provider for the identity claim.
		await providerWith(cache, options).search({ query: "one" });
		await providerWith(cache, options).search({ query: "two" });
		expect(calls).toBe(2);

		// `maxResults` is the one request field that changes the answer.
		await providerWith(cache, options).search({ query: "bounded", maxResults: 3 });
		await providerWith(cache, options).search({ query: "bounded", maxResults: 5 });
		expect(calls).toBe(4);

		const base = { op: "search", providerId: "tavily", signature: "s" };
		expect(cacheKey({ ...base, request: { b: 2, a: 1 } })).toBe(cacheKey({ ...base, request: { a: 1, b: 2 } }));
		expect(cacheKey({ ...base, request: { urls: ["a", "b"] } })).not.toBe(cacheKey({ ...base, request: { urls: ["b", "a"] } }));
		// A field boundary must not be forgeable by concatenation.
		expect(cacheKey({ op: "ab", providerId: "c", signature: "s", request: 1 })).not.toBe(
			cacheKey({ op: "a", providerId: "bc", signature: "s", request: 1 }),
		);
		expect(cacheKey({ ...base, signature: "other", request: 1 })).not.toBe(cacheKey({ ...base, request: 1 }));
	});

	it("edge (d): two providers with byte-identical requests never share an answer", async () => {
		const cache = new ResultCache();
		let alphaCalls = 0;
		let betaCalls = 0;
		const alpha = stubAdapter("alpha", async () => {
			alphaCalls += 1;
			return { sources: [{ url: "https://alpha.test/1" }], truncated: false, content: "alpha answer" };
		});
		const beta = stubAdapter("beta", async () => {
			betaCalls += 1;
			return { sources: [{ url: "https://beta.test/1" }], truncated: false, content: "beta answer" };
		});
		const request = { query: "identical query bytes", maxResults: 4 };
		const fromAlpha = await providerWith(cache, resolved({ adapter: alpha, provider: "alpha" })).search(request);
		const fromBeta = await providerWith(cache, resolved({ adapter: beta, provider: "beta" })).search(request);
		expect(fromAlpha.content).toBe("alpha answer");
		expect(fromBeta.content).toBe("beta answer");
		expect(alphaCalls).toBe(1);
		expect(betaCalls).toBe(1);
	});

	it("edge (e): identical adapter ids with different settings never share an answer", async () => {
		const cache = new ResultCache();
		let calls = 0;
		const adapter = stubAdapter("tavily", async (_request, runtime) => {
			calls += 1;
			return { sources: [{ url: `https://tavily.test/${String(runtime.settings.searchDepth)}` }], truncated: false };
		});
		const request = { query: "same" };
		const basic = await providerWith(cache, resolved({ adapter, provider: "tavily", settings: { searchDepth: "basic" } })).search(request);
		const advanced = await providerWith(cache, resolved({ adapter, provider: "tavily", settings: { searchDepth: "advanced" } })).search(request);
		expect(basic.sources[0]?.url).toBe("https://tavily.test/basic");
		expect(advanced.sources[0]?.url).toBe("https://tavily.test/advanced");
		expect(calls).toBe(2);
	});

	it("[F1 fixed] a nested settings change is a different cache identity", async () => {
		// Regression guard for the array-replacer bug: JSON.stringify(value,
		// Object.keys(settings).sort()) treats that array as a whitelist at EVERY
		// depth, so a nested object encoded as `{}` and a change inside it kept
		// serving the old answer. The signature now goes through canonicalize.
		const settings = { maxResults: 5, limits: { perPageChars: 20_000 } };
		const signature = canonicalize(["tavily", "tavily", "https://x", settings]);
		expect(signature).toContain('"perPageChars":20000');
		expect(signature).not.toContain('"limits":{}');

		// Observable consequence: changing a nested value now MISSES.
		let calls = 0;
		const adapter = stubAdapter("tavily", async () => {
			calls += 1;
			return { sources: [], truncated: false };
		});
		const cache = new ResultCache();
		await providerWith(cache, resolved({ adapter, provider: "tavily", settings: { maxResults: 5, limits: { perPageChars: 20_000 } } })).search({
			query: "nested",
		});
		await providerWith(cache, resolved({ adapter, provider: "tavily", settings: { maxResults: 5, limits: { perPageChars: 1 } } })).search({
			query: "nested",
		});
		expect(calls).toBe(2);
	});

	it("a request that cannot be canonicalised still produces a stable key", () => {
		const cyclic: Record<string, unknown> = { query: "q" };
		cyclic.self = cyclic;
		const key = cacheKey({ op: "search", providerId: "tavily", signature: "s", request: cyclic });
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		expect(cacheKey({ op: "search", providerId: "tavily", signature: "s", request: cyclic })).toBe(key);
	});
});

function providerWith(cache: ResultCache, options: ResolvedOptions): ExtensibleWebSearchProvider {
	return new ExtensibleWebSearchProvider(() => options, cache);
}

describe("claim 3: TTL and LRU", () => {
	it("an entry expires exactly at the TTL boundary", () => {
		const clock = fakeClock(0);
		const cache = new ResultCache({ ttlMs: 1_000, clock: clock.now });
		cache.set("k", { value: 1 });
		clock.set(999);
		expect(cache.getWithAge("k")?.ageMs).toBe(999);
		clock.set(1_000);
		expect(cache.get("k")).toBeUndefined();
		expect(cache.stats().misses).toBe(1);
		expect(cache.stats().evicted).toBe(0);
	});

	it("the sink evicts the least recently used entry, and a read refreshes recency", () => {
		const clock = fakeClock(0);
		const cache = new ResultCache({ maxEntries: 2, clock: clock.now });
		cache.set("a", "A");
		clock.advance(1);
		cache.set("b", "B");
		clock.advance(1);
		expect(cache.get("a")).toBe("A");
		clock.advance(1);
		cache.set("c", "C");
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toBe("A");
		expect(cache.get("c")).toBe("C");
		expect(cache.stats().evicted).toBe(1);
	});

	it("edge (d): a deeply nested result round-trips through set/get and through state", () => {
		const clock = fakeClock(0);
		const nested = {
			sources: [{ url: "https://x.test", meta: { deep: { level: 3, list: [1, 2, { z: "z" }] } } }],
			truncated: false,
			extra: { list: [1, 2, { z: "z" }], nullable: null },
		};
		const cache = new ResultCache({ clock: clock.now });
		cache.set("deep", nested);
		expect(cache.get("deep")).toEqual(nested);
		// Observation O1: the store aliases its argument (the provider layer, not
		// the cache, is what clones); a direct caller would share the entry.
		expect(cache.get("deep")).toBe(nested);

		const restored = ResultCache.fromState(cache.toState(), { clock: clock.now });
		expect(restored.get("deep")).toEqual(nested);

		const withGap = { sources: [{ url: "u", title: undefined }], truncated: false } as unknown;
		cache.set("gap", withGap);
		expect(cache.get("gap")).toEqual(withGap);
	});

	it("refuses values that cannot survive persistence", () => {
		const cache = new ResultCache();
		cache.set("fn", { no: () => 1 });
		cache.set("big", { no: BigInt(1) });
		cache.set("sym", { no: Symbol("s") });
		cache.set("undefined", undefined);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		cache.set("cyclic", cyclic);
		expect(cache.stats().entries).toBe(0);
	});

	it("fromState drops entries past their TTL and unrecognized versions", () => {
		const clock = fakeClock(10_000);
		const state = {
			version: 1,
			entries: [
				{ key: "fresh", value: 1, storedAt: 10_000 },
				{ key: "stale", value: 2, storedAt: 0 },
				{ key: "no-stamp", value: 3 },
				"nope",
				{ key: "fn", value: () => 1, storedAt: 10_000 },
			],
		};
		const cache = ResultCache.fromState(state, { ttlMs: 5_000, clock: clock.now });
		expect(cache.get("fresh")).toBe(1);
		expect(cache.get("stale")).toBeUndefined();
		expect(cache.get("no-stamp")).toBeUndefined();
		expect(cache.get("fn")).toBeUndefined();
		expect(ResultCache.fromState({ version: 99, entries: [{ key: "a", value: 1, storedAt: 10_000 }] }, { clock: clock.now }).stats().entries).toBe(0);
		expect(ResultCache.fromState(null, { clock: clock.now }).stats().entries).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Claim 4 — hit visibility, attempts hygiene, mutation isolation
// ---------------------------------------------------------------------------

describe("claim 4: a hit is visible and metadata-shaped", () => {
	it("reports its age and a direct success carries neither trail", async () => {
		const clock = fakeClock(0);
		const adapter = stubAdapter("tavily", async () => ({ sources: [{ url: "https://a.test/1" }], truncated: false }));
		const cache = new ResultCache({ clock: clock.now });
		const provider = providerWith(cache, resolved({ adapter, provider: "tavily" }));

		const first = await provider.search({ query: "q" });
		expect(trail(first).warnings).toBeUndefined();
		expect(hasOwn(first, "attempts")).toBe(false);
		expect(hasOwn(first, "warnings")).toBe(false);

		clock.advance(5_000);
		const hit = await provider.search({ query: "q" });
		expect(trail(hit).warnings).toEqual(["cache hit (age 5s)"]);
		expect(hasOwn(hit, "attempts")).toBe(false);
	});

	it("two consecutive hits do not stack markers on the stored entry", async () => {
		const clock = fakeClock(0);
		const adapter = stubAdapter("tavily", async () => ({ sources: [], truncated: false }));
		const cache = new ResultCache({ clock: clock.now });
		const provider = providerWith(cache, resolved({ adapter, provider: "tavily" }));
		await provider.search({ query: "q" });
		const firstHit = await provider.search({ query: "q" });
		clock.advance(3_000);
		const secondHit = await provider.search({ query: "q" });
		expect(trail(firstHit).warnings).toEqual(["cache hit (age 0s)"]);
		expect(trail(secondHit).warnings).toEqual(["cache hit (age 3s)"]);
	});

	it("the write-through hook fires once per stored result, never on a hit", async () => {
		let writes = 0;
		const adapter = stubAdapter("tavily", async () => ({ sources: [], truncated: false }));
		const cache = new ResultCache();
		const provider = new ExtensibleWebSearchProvider(() => resolved({ adapter, provider: "tavily" }), cache, () => {
			writes += 1;
		});
		await provider.search({ query: "q" });
		await provider.search({ query: "q" });
		expect(writes).toBe(1);
	});

	it("mutating a handed-out result cannot reach the stored entry", async () => {
		const adapter = stubAdapter("tavily", async () => ({
			content: "original",
			sources: [{ url: "https://a.test/1", title: "original title" }],
			truncated: false,
		}));
		const cache = new ResultCache();
		const provider = providerWith(cache, resolved({ adapter, provider: "tavily" }));

		const first = await provider.search({ query: "q" });
		expect(first).not.toBe(await provider.search({ query: "q" }));

		(first.sources as { url: string }[]).push({ url: "https://evil.test/2" });
		(first.sources as unknown as { url: string }[])[0]!.url = "https://mutated.test/1";
		(first as { content?: string }).content = "mutated";
		(first as { truncated: boolean }).truncated = true;

		const hit = await provider.search({ query: "q" });
		expect(hit.sources).toHaveLength(1);
		expect(hit.sources[0]?.url).toBe("https://a.test/1");
		expect(hit.content).toBe("original");
		expect(hit.truncated).toBe(false);
	});

	it("[FINDING F2] a hit carries no attempts[], even after a failover success", async () => {
		// Documented rule (AGENTS.md, provider.ts comment): a hit must carry NO
		// attempts[] — not [], which reads as "a member ran". copyResult() spreads
		// the cached object, and chain.ts stamps `attempts` onto a failover
		// success, so this case is expected to be broken.
		const cache = new ResultCache();
		const failing = stubAdapter("primary", async () => {
			throw new WebError("quota", "WEB_PROVIDER_ERROR");
		});
		const backup = stubAdapter("backup", async () => ({ sources: [{ url: "https://backup.test/1" }], truncated: false }));
		const chain = chainOf([failing, backup])!;
		const provider = providerWith(cache, resolved({ adapter: chain, provider: "primary" }));

		const first = await provider.search({ query: "q" });
		expect((first as { attempts?: unknown[] }).attempts).toHaveLength(2);

		const hit = await provider.search({ query: "q" });
		expect(trail(hit).warnings).toContain("cache hit (age 0s)");
		// One assertion carrying the whole observed shape, so a failure prints it:
		// the cached failover trail is replayed to a caller that ran no member.
		expect({ ownKeys: Object.keys(hit).sort(), attempts: trail(hit).attempts }).toEqual({
			ownKeys: ["sources", "truncated", "warnings"],
			attempts: undefined,
		});
		expect(hasOwn(hit, "attempts")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Claim 5 — no secrets reaching disk (the state document)
// ---------------------------------------------------------------------------

describe("claim 5: no key material and no raw request text", () => {
	const SECRET = "SUPERSECRET-KEY-do-not-persist-abc123";
	const QUERY = "RAW-QUERY-TEXT-do-not-persist-xyz789";

	it("the state document carries neither the secret nor the query", async () => {
		const dir = tempDir("secrets");
		const clock = fakeClock(0);
		const cache = new ResultCache({ clock: clock.now });
		const board = new CooldownBoard({ clock: clock.now });
		let seenApiKey: string | undefined;
		const adapter = stubAdapter("tavily", async (_request, runtime) => {
			seenApiKey = runtime.apiKey;
			return { content: "answer", sources: [{ url: "https://a.test/1", snippet: "snippet" }], truncated: false };
		});
		const provider = new ExtensibleWebSearchProvider(
			() => resolved({ adapter, provider: "tavily", apiKey: SECRET, settings: { searchDepth: "basic" } }),
			cache,
			() => writeState(dir, { version: 1, cooldown: board.toState(), cache: cache.toState() }),
		);

		await provider.search({ query: QUERY });
		board.onQuotaError("tavily", 60_000);
		await provider.search({ query: QUERY });

		expect(seenApiKey).toBe(SECRET);
		const raw = fs.readFileSync(path.join(dir, "state.json"), "utf8");
		expect(raw).not.toContain(SECRET);
		expect(raw).not.toContain(QUERY);
		expect(raw).not.toContain("do-not-persist");
		// The only credential-shaped thing that reaches disk is a hashed cache key;
		// the key VALUE lives in the adapter's runtime and nowhere else.
		expect(raw).not.toMatch(/authorization|bearer|x-api-key/i);
	});

	it("emits the evidence artifact the report greps (never a repo path)", async () => {
		const evidence = path.join(os.tmpdir(), "vfeat-evidence");
		fs.rmSync(evidence, { recursive: true, force: true });
		fs.mkdirSync(evidence, { recursive: true });

		const clock = fakeClock(0);
		const cache = new ResultCache({ clock: clock.now });
		const board = new CooldownBoard({ clock: clock.now });
		const adapter = stubAdapter("tavily", async () => ({
			content: "answer body",
			sources: [{ url: "https://a.test/1", snippet: "snippet text" }],
			truncated: false,
		}));
		const provider = new ExtensibleWebSearchProvider(
			() => resolved({ adapter, provider: "tavily", apiKey: SECRET, settings: { searchDepth: "basic" } }),
			cache,
			() => writeState(evidence, { version: 1, cooldown: board.toState(), cache: cache.toState() }),
		);
		await provider.search({ query: QUERY });
		board.onQuotaError("tavily", 60_000);
		await provider.search({ query: QUERY });

		expect(fs.existsSync(path.join(evidence, "state.json"))).toBe(true);
	});

	it("the state document stores hashed keys and payloads, not request text", async () => {
		const dir = tempDir("hashed");
		const cache = new ResultCache();
		const key = cacheKey({ op: "search", providerId: "tavily", signature: "s", request: { query: QUERY } });
		cache.set(key, { sources: [{ url: "https://a.test/1" }], truncated: false });
		writeState(dir, { version: 1, cache: cache.toState() });
		const raw = fs.readFileSync(path.join(dir, "state.json"), "utf8");
		expect(raw).toContain(key);
		expect(raw).not.toContain(QUERY);
		expect(raw).not.toContain('"signature"');
		expect(raw).not.toContain('"op"');
	});
});

// ---------------------------------------------------------------------------
// Observations outside the claim list (documented, not refutations)
// ---------------------------------------------------------------------------

describe("observation O2: two writers publishing whole documents from memory", () => {
	it("a stale publish drops the slice another writer just stored", () => {
		const dir = tempDir("two-writers");
		const clock = fakeClock(0);

		// Both writers boot from the same (empty) document, exactly as two dsh
		// processes sharing one harness home do.
		const writerA = ResultCache.fromState(readState(dir)?.cache, { clock: clock.now });
		const writerB = ResultCache.fromState(readState(dir)?.cache, { clock: clock.now });

		writerB.set("from-b", { sources: [{ url: "https://b.test" }], truncated: false });
		writeState(dir, { version: 1, cache: writerB.toState() });
		expect(ResultCache.fromState(readState(dir)?.cache, { clock: clock.now }).get("from-b")).toBeDefined();

		// index.ts publishes cooldown + cache together from memory (saveState), so
		// writer A re-publishes its own view and B's entry disappears.
		writerA.set("from-a", { sources: [{ url: "https://a.test" }], truncated: false });
		writeState(dir, { version: 1, cache: writerA.toState() });
		const merged = ResultCache.fromState(readState(dir)?.cache, { clock: clock.now });
		expect(merged.get("from-a")).toBeDefined();
		expect(merged.get("from-b")).toBeUndefined();
	});
});

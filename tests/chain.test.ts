import { describe, expect, it, vi } from "vitest";
import { WebError } from "@deepseek-ai/dsh-web";
import { chainOf, resolveChain, type WithAttempts } from "../src/core/chain.js";
import { AdapterRegistry } from "../src/core/registry.js";
import { capabilitiesOf } from "../src/core/capabilities.js";
import { CooldownBoard, DEFAULT_COOLDOWN_BASE_MS } from "../src/core/cooldown.js";
import type { ExtractResult, SearchAdapter } from "../src/types.js";

/** Minimal scripted adapter: `over.search`/`over.extract` replace the defaults. */
function fakeAdapter(id: string, over: Partial<SearchAdapter> = {}): SearchAdapter {
	return {
		id,
		label: id,
		requiresApiKey: false,
		defaultApiKeyEnv: `${id.toUpperCase()}_API_KEY`,
		baseURLEnv: `${id.toUpperCase()}_BASE_URL`,
		defaultBaseURL: `https://${id}.test`,
		available: () => true,
		search: (request) => {
			const scripted = (over as { search?: (request: { query: string }) => unknown }).search;
			const outcome = scripted?.(request) ?? { sources: [{ url: `https://${id}.test/hit` }], truncated: false };
			return Promise.resolve(outcome) as ReturnType<SearchAdapter["search"]>;
		},
		...over,
	} as SearchAdapter;
}

const quotaError = () => new WebError("quota exhausted", "WEB_PROVIDER_ERROR");
const abortError = () => new WebError("Search aborted", "WEB_ABORTED");
const unsupportedError = () => new WebError("nope", "WEB_OP_UNSUPPORTED");

const okResult = (id: string) => ({ sources: [{ url: `https://${id}.test/hit` }], truncated: false });

/** Result shape with the additive degradation trail attached. */
type TrailedResult = Awaited<ReturnType<SearchAdapter["search"]>> & WithAttempts;

function runtimeOf(adapter: SearchAdapter) {
	return { apiKeyEnv: adapter.defaultApiKeyEnv, baseURL: adapter.defaultBaseURL, settings: {} };
}

describe("failover on switchable errors", () => {
	it("falls through a WEB_PROVIDER_ERROR quota failure to the fallback that serves, LOUDLY", async () => {
		const chain = chainOf([fakeAdapter("primary", { search: () => Promise.reject(quotaError()) }), fakeAdapter("fallback")])!;
		const result = (await chain.search({ query: "q" }, runtimeOf(chain))) as TrailedResult;
		expect(result).toMatchObject(okResult("fallback"));
		expect(result.warnings).toEqual(["fell back primary -> fallback"]);
		expect(result.attempts).toEqual([
			{ adapterId: "primary", outcome: "failed", durationMs: expect.any(Number), errorCode: "WEB_PROVIDER_ERROR" },
			{ adapterId: "fallback", outcome: "ok", durationMs: expect.any(Number) },
		]);
	});

	it("treats an unresolvable credential as switchable so a keyless fallback serves", async () => {
		const primary = fakeAdapter("primary", {
			search: () => Promise.reject(new WebError("no key", "WEB_PROVIDER_CREDENTIAL_MISSING")),
		});
		const chain = chainOf([primary, fakeAdapter("keyless")])!;
		await expect(chain.search({ query: "q" }, runtimeOf(chain))).resolves.toMatchObject(okResult("keyless"));
	});

	it("rethrows the ORIGINAL last error after every member fails switchably, trail attached", async () => {
		const first = fakeAdapter("first", { search: () => Promise.reject(new WebError("first down", "WEB_PROVIDER_ERROR")) });
		const second = fakeAdapter("second", { search: () => Promise.reject(new WebError("second down", "WEB_PROVIDER_ERROR")) });
		const error = await chainOf([first, second])!.search({ query: "q" }, runtimeOf(first)).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(WebError);
		expect((error as WebError).message).toBe("second down");
		expect((error as WithAttempts).attempts).toEqual([
			{ adapterId: "first", outcome: "failed", durationMs: expect.any(Number), errorCode: "WEB_PROVIDER_ERROR" },
			{ adapterId: "second", outcome: "failed", durationMs: expect.any(Number), errorCode: "WEB_PROVIDER_ERROR" },
		]);
	});
});

describe("non-switchable errors abort immediately", () => {
	it.each([
		["WEB_ABORTED", abortError],
		["WEB_OP_UNSUPPORTED", unsupportedError],
	])("does not try the fallback on %s", async (_code, makeError) => {
		const fallbackSearch = vi.fn(() => Promise.resolve(okResult("fallback")));
		const primary = fakeAdapter("primary", { search: () => Promise.reject(makeError()) });
		const chain = chainOf([primary, fakeAdapter("fallback", { search: fallbackSearch })])!;
		const error = await chain.search({ query: "q" }, runtimeOf(primary)).catch((e: unknown) => e);
		expect((error as WebError).code).toBe(makeError().code);
		expect(fallbackSearch).not.toHaveBeenCalled();
		expect((error as WithAttempts).attempts).toEqual([
			{ adapterId: "primary", outcome: "failed", durationMs: expect.any(Number), errorCode: makeError().code },
		]);
	});

	it("lets non-WebError failures pass through unswitched and untraced", async () => {
		const plain = new Error("socket hung up");
		const fallbackSearch = vi.fn(() => Promise.resolve(okResult("fallback")));
		const primary = fakeAdapter("primary", { search: () => Promise.reject(plain) });
		const chain = chainOf([primary, fakeAdapter("fallback", { search: fallbackSearch })])!;
		await expect(chain.search({ query: "q" }, runtimeOf(primary))).rejects.toBe(plain);
		expect(fallbackSearch).not.toHaveBeenCalled();
	});
});

describe("per-op native capability", () => {
	it("extract skips members without native extract and runs capable ones in order", async () => {
		const calls: string[] = [];
		const throwingExtractor = fakeAdapter("extractor-1", {
			extract: (): Promise<ExtractResult> => {
				calls.push("extractor-1");
				return Promise.reject(new WebError("extractor-1 quota", "WEB_PROVIDER_ERROR"));
			},
		} as Partial<SearchAdapter>);
		const servingExtractor = fakeAdapter("extractor-2", {
			extract: (): Promise<ExtractResult> => {
				calls.push("extractor-2");
				return Promise.resolve({ pages: [], truncated: false });
			},
		} as Partial<SearchAdapter>);
		const chain = chainOf([fakeAdapter("search-only"), throwingExtractor, servingExtractor])!;
		const runtime = runtimeOf(chain);
		const extracted = (await chain.extract!({ urls: ["https://a.example/1"] }, runtime)) as ExtractResult & WithAttempts;
		expect(extracted).toMatchObject({ pages: [], truncated: false });
		expect(extracted.warnings).toEqual(["fell back extractor-1 -> extractor-2"]);
		expect(extracted.attempts).toHaveLength(2);
		expect(calls).toEqual(["extractor-1", "extractor-2"]);
		expect(capabilitiesOf(chain)).toContain("extract");
	});

	it("omits an op entirely when no member supports it natively", () => {
		const chain = chainOf([fakeAdapter("a"), fakeAdapter("b")])!;
		expect(chain.extract).toBeUndefined();
		expect(chain.crawl).toBeUndefined();
		expect(chain.map).toBeUndefined();
		expect([...capabilitiesOf(chain)]).toEqual(["search"]);
	});

	it("delegates research to the FIRST complete member without cross-member failover", async () => {
		const secondSubmit = vi.fn(() => Promise.resolve({ requestId: "r-2", status: "pending" as const }));
		const first = fakeAdapter("research-first", {
			submitResearch: () => Promise.reject(new WebError("research-first quota", "WEB_PROVIDER_ERROR")),
			pollResearch: () => Promise.resolve({ requestId: "r-1", status: "completed" }),
		} as Partial<SearchAdapter>);
		const second = fakeAdapter("research-second", {
			submitResearch: secondSubmit,
			pollResearch: () => Promise.resolve({ requestId: "r-2", status: "completed" }),
		} as Partial<SearchAdapter>);
		const chain = chainOf([first, second])!;
		expect(capabilitiesOf(chain)).toContain("research");
		await expect(chain.submitResearch!("topic", runtimeOf(chain))).rejects.toMatchObject({ code: "WEB_PROVIDER_ERROR" });
		expect(secondSubmit).not.toHaveBeenCalled();
		await expect(chain.pollResearch!("r-1", runtimeOf(chain))).resolves.toMatchObject({ requestId: "r-1" });
	});
});

describe("resolveChain validation (D3)", () => {
	it("reports unknown ids, duplicates, and self-reference while keeping valid members in order", () => {
		const registry = new AdapterRegistry();
		registry.register(fakeAdapter("primary"));
		registry.register(fakeAdapter("fb-one"));
		const resolution = resolveChain(registry, "primary", ["fb-one", "ghost", "primary", "fb-one"]);
		expect(resolution.members.map((member) => member.id)).toEqual(["primary", "fb-one"]);
		expect(resolution.problems).toEqual([
			'fallbacks: unknown adapter "ghost"',
			'fallbacks: "primary" is the active provider and cannot be its own fallback',
			'fallbacks: "fb-one" is duplicated',
		]);
	});

	it("drops an unregistered primary from members for the runtime guard to surface", () => {
		const registry = new AdapterRegistry();
		registry.register(fakeAdapter("other"));
		expect(resolveChain(registry, "missing", []).members).toEqual([]);
		expect(resolveChain(registry, "missing", []).problems).toEqual([]);
	});

	it("chainOf returns undefined for fewer than two effective members", () => {
		const solo = fakeAdapter("solo");
		expect(chainOf([])).toBeUndefined();
		expect(chainOf([solo])).toBeUndefined();
	});
});

describe("aggregated metadata", () => {
	it("ORs availability, ANDS requiresApiKey, and takes identity fields from the primary", () => {
		const keyedDown = fakeAdapter("keyed-down", { requiresApiKey: true, available: () => false });
		const chain = chainOf([keyedDown, fakeAdapter("keyless-up")])!;
		expect(chain.requiresApiKey).toBe(false);
		expect(chain.available(runtimeOf(chain))).toBe(true);
		expect(chain.id).toBe("keyed-down");
		expect(chain.defaultApiKeyEnv).toBe("KEYED-DOWN_API_KEY");
		expect(chain.label).toBe("Chain(keyed-down -> keyless-up)");
		const allKeyed = chainOf([
			fakeAdapter("a", { requiresApiKey: true }),
			fakeAdapter("b", { requiresApiKey: true }),
		])!;
		expect(allKeyed.requiresApiKey).toBe(true);
	});

	it("serves directly from the primary without contacting the fallback", async () => {
		const fallbackSearch = vi.fn(() => Promise.resolve(okResult("fallback")));
		const chain = chainOf([fakeAdapter("primary"), fakeAdapter("fallback", { search: fallbackSearch })])!;
		await expect(chain.search({ query: "q" }, runtimeOf(chain))).resolves.toEqual(okResult("primary"));
		expect(fallbackSearch).not.toHaveBeenCalled();
	});
});

describe("injected attempt sink (Step 5 seam)", () => {
	it("streams every settled attempt, ok and failed, to onAttempt in order", async () => {
		const sink = vi.fn();
		const chain = chainOf(
			[fakeAdapter("primary", { search: () => Promise.reject(quotaError()) }), fakeAdapter("fallback")],
			{ onAttempt: sink },
		)!;
		await chain.search({ query: "q" }, runtimeOf(chain));
		expect(sink.mock.calls.map(([attempt]) => attempt)).toEqual([
			{ adapterId: "primary", outcome: "failed", durationMs: expect.any(Number), errorCode: "WEB_PROVIDER_ERROR" },
			{ adapterId: "fallback", outcome: "ok", durationMs: expect.any(Number) },
		]);
	});

	it("defaults to a no-op sink when no options are passed", async () => {
		const chain = chainOf([
			fakeAdapter("a", { search: () => Promise.reject(quotaError()) }),
			fakeAdapter("b", { search: () => Promise.reject(quotaError()) }),
		])!;
		await expect(chain.search({ query: "q" }, runtimeOf(chain))).rejects.toMatchObject({ message: "quota exhausted" });
	});
});

describe("cooldown integration (D2 memory-only board)", () => {
	const quota = () => new WebError("keyless monthly credit quota exhausted (HTTP 402)", "WEB_PROVIDER_ERROR");

	it("skips a cooling member and serves with the next one", async () => {
		let now = 0;
		const cooldowns = new CooldownBoard({ clock: () => now });
		cooldowns.onQuotaError("primary");
		const primarySearch = vi.fn(() => Promise.resolve(okResult("primary")));
		const chain = chainOf([fakeAdapter("primary", { search: primarySearch }), fakeAdapter("fallback")], { cooldowns })!;
		const degraded = (await chain.search({ query: "q" }, runtimeOf(chain))) as TrailedResult;
		expect(degraded).toMatchObject(okResult("fallback"));
		expect(degraded.warnings).toEqual([expect.stringMatching(/^primary cooling until /u)]);
		expect(primarySearch).not.toHaveBeenCalled();
		now = DEFAULT_COOLDOWN_BASE_MS + 1;
		await expect(chain.search({ query: "q" }, runtimeOf(chain))).resolves.toEqual(okResult("primary"));
	});

	it("tries cooling members last-resort when EVERYTHING capable is cooling", async () => {
		const cooldowns = new CooldownBoard({ clock: () => 0 });
		cooldowns.onQuotaError("a");
		cooldowns.onQuotaError("b");
		const sink = vi.fn();
		const chain = chainOf(
			[fakeAdapter("a", { search: () => Promise.reject(new WebError("a quota", "WEB_PROVIDER_ERROR")) }), fakeAdapter("b", { search: () => Promise.reject(new WebError("b quota", "WEB_PROVIDER_ERROR")) })],
			{ cooldowns, onAttempt: sink },
		)!;
		await expect(chain.search({ query: "q" }, runtimeOf(chain))).rejects.toMatchObject({ message: "b quota" });
		expect(sink.mock.calls.map(([attempt]) => attempt)).toEqual([
			{ adapterId: "a", outcome: "skipped", durationMs: 0 },
			{ adapterId: "b", outcome: "skipped", durationMs: 0 },
			{ adapterId: "a", outcome: "failed", durationMs: expect.any(Number), errorCode: "WEB_PROVIDER_ERROR" },
			{ adapterId: "b", outcome: "failed", durationMs: expect.any(Number), errorCode: "WEB_PROVIDER_ERROR" },
		]);
	});

	it("records a quota failure into the board so the NEXT call skips that member", async () => {
		const cooldowns = new CooldownBoard({ clock: () => 0 });
		let calls = 0;
		const primarySearch = vi.fn(() => {
			calls += 1;
			return calls === 1
				? Promise.reject(new WebError("primary quota (HTTP 402)", "WEB_PROVIDER_ERROR"))
				: Promise.resolve(okResult("primary"));
		});
		const chain = chainOf(
			[fakeAdapter("primary", { search: primarySearch }), fakeAdapter("fallback")],
			{ cooldowns },
		)!;
		// First call: primary fails switchably on quota, fallback serves.
		await expect(chain.search({ query: "q" }, runtimeOf(chain))).resolves.toMatchObject(okResult("fallback"));
		expect(primarySearch).toHaveBeenCalledTimes(1);
		// Second call: that quota failure put the primary on cooldown.
		await expect(chain.search({ query: "q" }, runtimeOf(chain))).resolves.toMatchObject(okResult("fallback"));
		expect(primarySearch).toHaveBeenCalledTimes(1);
	});

	it("a last-resort success clears the cooldown window immediately", async () => {
		let now = 0;
		const cooldowns = new CooldownBoard({ clock: () => now });
		cooldowns.onQuotaError("a");
		cooldowns.onQuotaError("b");
		const chain = chainOf(
			[fakeAdapter("a"), fakeAdapter("b", { search: () => Promise.reject(new WebError("b quota (HTTP 402)", "WEB_PROVIDER_ERROR")) })],
			{ cooldowns },
		)!;
		// Both cooling -> both tried last-resort; a serves and clears itself.
		const degraded = (await chain.search({ query: "q" }, runtimeOf(chain))) as TrailedResult;
		expect(degraded).toMatchObject(okResult("a"));
		expect(degraded.warnings).toEqual([
			expect.stringMatching(/^a cooling until /u),
			expect.stringMatching(/^b cooling until /u),
		]);
		expect(cooldowns.isCooling("a")).toBe(false);
		expect(cooldowns.isCooling("b")).toBe(true);
		// Next call: normal order for a again, b still skipped while cooling.
		const sink = vi.fn();
		const secondChain = chainOf([fakeAdapter("a"), fakeAdapter("b")], { cooldowns, onAttempt: sink })!;
		await expect(secondChain.search({ query: "q" }, runtimeOf(secondChain))).resolves.toMatchObject(okResult("a"));
		expect(sink.mock.calls.map(([attempt]) => attempt)).toEqual([
			{ adapterId: "b", outcome: "skipped", durationMs: 0 },
			{ adapterId: "a", outcome: "ok", durationMs: expect.any(Number) },
		]);
	});

	it("non-quota switchable failures do NOT trigger cooldown bookkeeping", async () => {
		const cooldowns = new CooldownBoard({ clock: () => 0 });
		const chain = chainOf(
			[fakeAdapter("primary", { search: () => Promise.reject(new WebError("no key", "WEB_PROVIDER_CREDENTIAL_MISSING")) }), fakeAdapter("fallback")],
			{ cooldowns },
		)!;
		await expect(chain.search({ query: "q" }, runtimeOf(chain))).resolves.toMatchObject(okResult("fallback"));
		expect(cooldowns.isCooling("primary")).toBe(false);
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebError } from "@deepseek-ai/dsh-web";
import {
	CooldownBoard,
	DEFAULT_COOLDOWN_BASE_MS,
	DEFAULT_COOLDOWN_CAP_MS,
	RETRY_AFTER_FLOOR_MS,
	markRetryAfter,
	parseRetryAfter,
	retryAfterMsOf,
} from "../src/core/cooldown.js";
import { DeepSeekAdapter } from "../src/adapters/deepseek.js";
import type { AdapterRuntime } from "../src/types.js";

const RFC_DATE = "Wed, 21 Oct 2026 07:28:00 GMT";
const RFC_DATE_MS = Date.UTC(2026, 9, 21, 7, 28, 0);

describe("Retry-After parsing (RFC 9110: delta-seconds and HTTP-date)", () => {
	it("reads delta-seconds as a delay from now", () => {
		expect(parseRetryAfter("120")).toBe(120_000);
		expect(parseRetryAfter("1")).toBe(1_000);
		expect(parseRetryAfter("  30  ")).toBe(30_000);
		expect(parseRetryAfter("0")).toBe(0);
	});

	it("reads an HTTP-date as the difference to now", () => {
		expect(parseRetryAfter(RFC_DATE, RFC_DATE_MS - 60_000)).toBe(60_000);
		expect(parseRetryAfter(RFC_DATE, RFC_DATE_MS)).toBe(0);
	});

	it("clamps a moment that already passed to 0 instead of going negative", () => {
		expect(parseRetryAfter(RFC_DATE, RFC_DATE_MS + 60_000)).toBe(0);
		expect(parseRetryAfter("-5")).toBe(0);
	});

	it("rejects absent, empty, unparsable, and non-finite values", () => {
		expect(parseRetryAfter(null)).toBeUndefined();
		expect(parseRetryAfter("")).toBeUndefined();
		expect(parseRetryAfter("   ")).toBeUndefined();
		expect(parseRetryAfter("soon-ish")).toBeUndefined();
		expect(parseRetryAfter("1e400")).toBeUndefined();
		expect(parseRetryAfter("1".repeat(400))).toBeUndefined();
	});
});

describe("error carrier (WebError is mutable, so the signal rides beside it)", () => {
	it("round-trips a stamped delay and pins the wire property name", () => {
		const error = markRetryAfter(new WebError("HTTP 429 too many requests", "WEB_PROVIDER_ERROR"), 5_000);
		expect(retryAfterMsOf(error)).toBe(5_000);
		expect((error as { retryAfterMs?: number }).retryAfterMs).toBe(5_000);
	});

	it("leaves clean errors and non-objects without a signal", () => {
		expect(retryAfterMsOf(new WebError("HTTP 500", "WEB_PROVIDER_ERROR"))).toBeUndefined();
		expect(Object.hasOwn(markRetryAfter(new WebError("HTTP 500", "WEB_PROVIDER_ERROR"), undefined), "retryAfterMs")).toBe(false);
		expect(retryAfterMsOf(undefined)).toBeUndefined();
		expect(retryAfterMsOf(null)).toBeUndefined();
		expect(retryAfterMsOf("120")).toBeUndefined();
		expect(retryAfterMsOf(120)).toBeUndefined();
		expect(retryAfterMsOf({ retryAfterMs: "120" })).toBeUndefined();
	});

	it("rejects NaN/Infinity and clamps a negative read back to 0", () => {
		expect(retryAfterMsOf(markRetryAfter(new WebError("x", "WEB_PROVIDER_ERROR"), Number.NaN))).toBeUndefined();
		expect(retryAfterMsOf(markRetryAfter(new WebError("x", "WEB_PROVIDER_ERROR"), Number.POSITIVE_INFINITY))).toBeUndefined();
		expect(retryAfterMsOf({ retryAfterMs: -1 })).toBe(0);
	});
});

describe("server-supplied delay wins over the estimate (fake clock)", () => {
	it("uses the server's window verbatim", () => {
		let now = 1_000;
		const board = new CooldownBoard({ clock: () => now });
		expect(board.onQuotaError("a", 5_000)).toBe(6_000);
		expect(board.coolingUntil("a")).toBe(6_000);
		now = 6_000;
		expect(board.isCooling("a")).toBe(false);
	});

	it("floors a degenerate delay so the next dispatch still skips the adapter", () => {
		const board = new CooldownBoard({ clock: () => 0 });
		expect(board.onQuotaError("zero", 0)).toBe(RETRY_AFTER_FLOOR_MS);
		expect(board.onQuotaError("short", 250)).toBe(RETRY_AFTER_FLOOR_MS);
	});

	it("caps the server's window at the board cap", () => {
		const board = new CooldownBoard({ clock: () => 0 });
		expect(board.onQuotaError("long", 2 * 60 * 60_000)).toBe(DEFAULT_COOLDOWN_CAP_MS);
	});

	it("lets an explicit cap win over the floor", () => {
		const board = new CooldownBoard({ clock: () => 0, capMs: 500 });
		expect(board.onQuotaError("a", 100)).toBe(500);
	});

	it("keeps counting failures behind a server-supplied window", () => {
		let now = 0;
		const board = new CooldownBoard({ clock: () => now });
		board.onQuotaError("a", 5_000);
		board.onQuotaError("a", 5_000);
		now = 10_000;
		expect(board.onQuotaError("a")).toBe(now + 4 * DEFAULT_COOLDOWN_BASE_MS);
	});

	it("falls back to the exponential schedule for unusable delays", () => {
		let now = 0;
		const board = new CooldownBoard({ clock: () => now });
		expect(board.onQuotaError("nan", Number.NaN)).toBe(DEFAULT_COOLDOWN_BASE_MS);
		expect(board.onQuotaError("inf", Number.POSITIVE_INFINITY)).toBe(DEFAULT_COOLDOWN_BASE_MS);
		expect(board.onQuotaError("neg", -1)).toBe(DEFAULT_COOLDOWN_BASE_MS);
		expect(board.onQuotaError("none")).toBe(DEFAULT_COOLDOWN_BASE_MS);
		now = 1_000;
		expect(board.onQuotaError("none")).toBe(1_000 + 2 * DEFAULT_COOLDOWN_BASE_MS);
	});

	it("resets the count and the server window on success", () => {
		const board = new CooldownBoard({ clock: () => 0 });
		board.onQuotaError("a", 5_000);
		board.onSuccess("a");
		expect(board.isCooling("a")).toBe(false);
		expect(board.onQuotaError("a")).toBe(DEFAULT_COOLDOWN_BASE_MS);
	});
});

describe("DeepSeek adapter: the one transport whose headers we can see", () => {
	const runtime: AdapterRuntime = { apiKey: "test-key", apiKeyEnv: "DEEPSEEK_API_KEY", baseURL: "https://api.example", settings: {} };

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const failWith = (status: number, headers: Record<string, string>) =>
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "upstream refused" } }), { status, headers }));

	const thrownBy = async (): Promise<unknown> => DeepSeekAdapter.search({ query: "anything" }, runtime).catch((error: unknown) => error);

	it("stamps the delta-seconds header onto the error the chain will cool on", async () => {
		failWith(429, { "content-type": "application/json", "retry-after": "120" });
		const error = await thrownBy();
		expect(error).toBeInstanceOf(WebError);
		expect((error as WebError).message).toBe("upstream refused");
		expect(retryAfterMsOf(error)).toBe(120_000);
	});

	it("stamps an HTTP-date header too, and a 503 as readily as a 429", async () => {
		const at = Date.now() + 90_000;
		failWith(503, { "retry-after": new Date(at).toUTCString() });
		const ms = retryAfterMsOf(await thrownBy());
		expect(ms).toBeGreaterThan(85_000);
		expect(ms).toBeLessThanOrEqual(90_000);
	});

	it("leaves a headerless failure on the exponential estimate", async () => {
		failWith(500, { "content-type": "application/json" });
		expect(retryAfterMsOf(await thrownBy())).toBeUndefined();
	});
});

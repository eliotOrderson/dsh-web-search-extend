import { describe, expect, it } from "vitest";
import { WebError } from "@deepseek-ai/dsh-web";
import { CooldownBoard, DEFAULT_COOLDOWN_BASE_MS, DEFAULT_COOLDOWN_CAP_MS, isQuotaError } from "../src/core/cooldown.js";

const quotaError = () => new WebError("Firecrawl keyless monthly credit quota exhausted (HTTP 402)", "WEB_PROVIDER_ERROR");
const rateLimitError = () => new WebError("Tavily keyless rate limit reached", "WEB_PROVIDER_ERROR");
const networkError = () => new WebError("DeepSeek search request failed: TypeError: socket hung up", "WEB_PROVIDER_ERROR");

describe("quota classification (chain switchable set, captain ruling)", () => {
	it("accepts every WEB_PROVIDER_ERROR: quota, rate limit, 402/429, 5xx, network", () => {
		expect(isQuotaError(quotaError())).toBe(true);
		expect(isQuotaError(rateLimitError())).toBe(true);
		expect(isQuotaError(new WebError("HTTP 429 too many requests", "WEB_PROVIDER_ERROR"))).toBe(true);
		expect(isQuotaError(new WebError("upstream exploded (HTTP 500)", "WEB_PROVIDER_ERROR"))).toBe(true);
		expect(isQuotaError(networkError())).toBe(true);
	});

	it("rejects credential-missing, cancellation, other codes, and non-WebErrors", () => {
		expect(isQuotaError(new WebError("no key", "WEB_PROVIDER_CREDENTIAL_MISSING"))).toBe(false);
		expect(isQuotaError(new WebError("Search aborted", "WEB_ABORTED"))).toBe(false);
		expect(isQuotaError(new Error("quota"))).toBe(false);
	});
});

describe("exponential backoff schedule (fake clock)", () => {
	it("doubles the window per consecutive failure and caps it", () => {
		let now = 0;
		const board = new CooldownBoard({ clock: () => now });
		const id = "firecrawl-keyless";

		now = 1_000;
		expect(board.isCooling(id)).toBe(false);
		expect(board.onQuotaError(id)).toBe(1_000 + DEFAULT_COOLDOWN_BASE_MS);
		expect(board.coolingUntil(id)).toBe(61_000);

		now = 61_000;
		expect(board.isCooling(id)).toBe(false);
		expect(board.onQuotaError(id)).toBe(61_000 + 2 * DEFAULT_COOLDOWN_BASE_MS);

		now = 181_000;
		expect(board.onQuotaError(id)).toBe(181_000 + 4 * DEFAULT_COOLDOWN_BASE_MS);
		expect(board.onQuotaError(id)).toBe(181_000 + 8 * DEFAULT_COOLDOWN_BASE_MS);
		expect(board.isCooling(id)).toBe(true);

		let lastUntil = 0;
		for (let round = 0; round < 10; round += 1) lastUntil = board.onQuotaError(id);
		expect(lastUntil - now).toBe(DEFAULT_COOLDOWN_CAP_MS);
	});

	it("expires windows by clock passage without touching counters", () => {
		let now = 0;
		const board = new CooldownBoard({ clock: () => now });
		board.onQuotaError("a");
		now = DEFAULT_COOLDOWN_BASE_MS;
		expect(board.isCooling("a")).toBe(false);
	});

	it("tracks adapter ids independently", () => {
		const board = new CooldownBoard({ clock: () => 0 });
		board.onQuotaError("a");
		expect(board.isCooling("a")).toBe(true);
		expect(board.isCooling("b")).toBe(false);
	});
});

describe("reset on success", () => {
	it("clears the failure count so the next error starts back at base", () => {
		let now = 0;
		const board = new CooldownBoard({ clock: () => now });
		board.onQuotaError("a");
		board.onQuotaError("a");
		expect(board.onQuotaError("a") - now).toBe(4 * DEFAULT_COOLDOWN_BASE_MS);

		now = 999_999_999;
		board.onSuccess("a");
		now += 1_000;
		expect(board.onQuotaError("a") - now).toBe(DEFAULT_COOLDOWN_BASE_MS);
	});

	it("success also ends an active cooldown window immediately", () => {
		const board = new CooldownBoard({ clock: () => 0 });
		board.onQuotaError("a");
		expect(board.isCooling("a")).toBe(true);
		board.onSuccess("a");
		expect(board.isCooling("a")).toBe(false);
		expect(board.coolingUntil("a")).toBeUndefined();
	});
});

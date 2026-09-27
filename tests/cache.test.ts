import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_ENTRIES, DEFAULT_TTL_MS, ResultCache, cacheKey } from "../src/core/cache.js";

const request = { query: "x", options: { maxResults: 5, lang: "en" }, tags: ["a", "b"] };
const keyOf = (overrides: Partial<Parameters<typeof cacheKey>[0]> = {}) =>
	cacheKey({ op: "search", providerId: "firecrawl-keyless", signature: "sig", request, ...overrides });

describe("cacheKey", () => {
	it("is stable when the same logical request is built in a different key order at any depth", () => {
		const shuffled = cacheKey({
			op: "search",
			providerId: "firecrawl-keyless",
			signature: "sig",
			request: { tags: ["a", "b"], options: { lang: "en", maxResults: 5 }, query: "x" },
		});
		expect(shuffled).toBe(keyOf());
		expect(shuffled).toMatch(/^[0-9a-f]{64}$/);
	});

	it("keeps array order significant and distinguishes structure from content", () => {
		expect(keyOf({ request: { tags: ["b", "a"] } })).not.toBe(keyOf({ request: { tags: ["a", "b"] } }));
		expect(keyOf({ request: { a: 1, b: 2 } })).not.toBe(keyOf({ request: [{ a: 1 }, { b: 2 }] }));
		expect(keyOf({ request: { a: null } })).not.toBe(keyOf({ request: {} }));
	});

	it("separates op, providerId, signature and request", () => {
		const keys = [
			keyOf(),
			keyOf({ op: "crawl" }),
			keyOf({ providerId: "tavily-keyless" }),
			keyOf({ signature: "sig2" }),
			keyOf({ request: { query: "y" } }),
		];
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("reads the request without mutating it, and a later mutation is a different key", () => {
		const mutable = { query: "x", options: { maxResults: 5, nested: { deep: true } } };
		const snapshot = structuredClone(mutable);
		const input = { op: "search", providerId: "firecrawl-keyless", signature: "sig", request: mutable };
		const first = cacheKey(input);

		expect(mutable).toEqual(snapshot);
		expect(Object.keys(mutable)).toEqual(["query", "options"]);

		mutable.options.nested.deep = false;
		expect(cacheKey(input)).not.toBe(first);
	});

	it("encodes values JSON cannot represent instead of throwing", () => {
		const unrepresentable = () =>
			cacheKey({
				op: "search",
				providerId: "firecrawl-keyless",
				signature: "sig",
				request: { query: "x", missing: undefined, fn: () => 1, big: 7n, when: new Date(0), ratio: Number.NaN },
			});
		expect(unrepresentable()).toMatch(/^[0-9a-f]{64}$/);
		expect(unrepresentable()).toBe(unrepresentable());
	});

	it("survives a cyclic request", () => {
		const define = () => {
			const cyclic: Record<string, unknown> = { query: "x" };
			cyclic.self = cyclic;
			return cyclic;
		};
		expect(keyOf({ request: define() })).toMatch(/^[0-9a-f]{64}$/);
		expect(keyOf({ request: define() })).toBe(keyOf({ request: define() }));
	});
});

describe("TTL expiry against the injected clock", () => {
	it("serves inside the window and expires on read at the boundary", () => {
		let now = 1_000;
		const cache = new ResultCache({ clock: () => now, ttlMs: 100 });
		cache.set("k", { answer: "a" });

		now = 1_099;
		expect(cache.get("k")).toEqual({ answer: "a" });
		now = 1_100;
		expect(cache.get("k")).toBeUndefined();
		expect(cache.stats().entries).toBe(0);
	});

	it("reports an expiry as a miss, never as an eviction", () => {
		let now = 0;
		const cache = new ResultCache({ clock: () => now, ttlMs: 100 });
		cache.set("k", 1);
		now = 100;
		cache.get("k");
		expect(cache.stats()).toEqual({ entries: 0, hits: 0, misses: 1, evicted: 0 });
	});

	it("sweeps expired entries in stats() without counting a lookup", () => {
		let now = 0;
		const cache = new ResultCache({ clock: () => now, ttlMs: 100 });
		cache.set("k", 1);
		now = 500;
		expect(cache.stats()).toEqual({ entries: 0, hits: 0, misses: 0, evicted: 0 });
	});

	it("restarts the age when a key is written again", () => {
		let now = 0;
		const cache = new ResultCache({ clock: () => now, ttlMs: 100 });
		cache.set("k", 1);
		now = 90;
		cache.set("k", 2);
		now = 150;
		expect(cache.get("k")).toBe(2);
		expect(cache.getWithAge("k")?.ageMs).toBe(60);
	});
});

describe("LRU eviction", () => {
	it("caps capacity and drops the least recently used entry", () => {
		const cache = new ResultCache({ clock: () => 0, maxEntries: 2 });
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("c", 3);

		expect(cache.stats()).toEqual({ entries: 2, hits: 0, misses: 0, evicted: 1 });
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBe(2);
		expect(cache.get("c")).toBe(3);
	});

	it("a hit refreshes recency, so the untouched entry is evicted first", () => {
		const cache = new ResultCache({ clock: () => 0, maxEntries: 2 });
		cache.set("a", 1);
		cache.set("b", 2);
		expect(cache.get("a")).toBe(1);
		cache.set("c", 3);

		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toBe(1);
		expect(cache.get("c")).toBe(3);
	});

	it("defaults to 15 minutes and 200 entries", () => {
		expect(DEFAULT_TTL_MS).toBe(900_000);
		expect(DEFAULT_MAX_ENTRIES).toBe(200);

		const cache = new ResultCache({ clock: () => 0 });
		for (let i = 0; i < DEFAULT_MAX_ENTRIES + 5; i += 1) cache.set(`k${i}`, i);
		expect(cache.stats().entries).toBe(DEFAULT_MAX_ENTRIES);
		expect(cache.get("k0")).toBeUndefined();
		expect(cache.get(`k${DEFAULT_MAX_ENTRIES + 4}`)).toBe(DEFAULT_MAX_ENTRIES + 4);
	});

	it("clear() empties both the store and the counters", () => {
		const cache = new ResultCache({ clock: () => 0, maxEntries: 1 });
		cache.set("a", 1);
		cache.get("a");
		cache.set("b", 2);
		cache.clear();
		expect(cache.stats()).toEqual({ entries: 0, hits: 0, misses: 0, evicted: 0 });
		expect(cache.get("a")).toBeUndefined();
	});
});

describe("get/set robustness", () => {
	it("returns the stored reference, nested objects included", () => {
		const cache = new ResultCache({ clock: () => 0 });
		const value = { items: [{ title: "t" }], answer: "a" };
		cache.set("k", value);
		const hit = cache.get<typeof value>("k");
		expect(hit).toBe(value);
		expect(hit?.items[0]?.title).toBe("t");
	});

	it("does not cache undefined", () => {
		const cache = new ResultCache({ clock: () => 0 });
		expect(() => cache.set("k", undefined)).not.toThrow();
		expect(cache.stats().entries).toBe(0);
		expect(cache.get("k")).toBeUndefined();
	});

	it("does not cache values that cannot survive persistence, without throwing", () => {
		const cache = new ResultCache({ clock: () => 0 });
		const cyclic: Record<string, unknown> = { ok: 1 };
		cyclic.self = cyclic;
		const bad = [() => 1, Symbol("s"), 10n, cyclic, { ok: 1, fn: () => 1 }];

		for (const value of bad) {
			expect(() => cache.set("bad", value)).not.toThrow();
			expect(cache.get("bad")).toBeUndefined();
		}
		expect(cache.stats().entries).toBe(0);

		// A nested undefined is dropped by JSON exactly as an optional field expects.
		cache.set("ok", { present: 1, missing: undefined });
		expect(cache.stats().entries).toBe(1);
	});
});

describe("persistence", () => {
	const reload = (cache: ResultCache, options: ConstructorParameters<typeof ResultCache>[0] = {}) =>
		ResultCache.fromState(JSON.parse(JSON.stringify(cache.toState())), options);

	it("round-trips payloads, ages and counters through JSON", () => {
		let now = 1_000;
		const cache = new ResultCache({ clock: () => now, ttlMs: 10_000, maxEntries: 5 });
		cache.set("k", { items: [{ title: "t" }], answer: "a" });
		now = 4_000;
		cache.get("k");

		const restored = reload(cache, { clock: () => now, ttlMs: 10_000, maxEntries: 5 });
		expect(restored.getWithAge("k")).toEqual({ value: { items: [{ title: "t" }], answer: "a" }, ageMs: 3_000 });
		expect(restored.stats()).toEqual({ entries: 1, hits: 1, misses: 0, evicted: 0 });
	});

	it("restores LRU order so the reloaded cache evicts the right entry", () => {
		let now = 0;
		const cache = new ResultCache({ clock: () => now, ttlMs: 10_000, maxEntries: 2 });
		cache.set("a", 1);
		now = 1;
		cache.set("b", 2);
		cache.get("a");

		const restored = reload(cache, { clock: () => now, ttlMs: 10_000, maxEntries: 2 });
		restored.set("c", 3);
		expect(restored.get("b")).toBeUndefined();
		expect(restored.get("a")).toBe(1);
		expect(restored.get("c")).toBe(3);
	});

	it("drops entries that expired while the process was down", () => {
		const cache = new ResultCache({ clock: () => 0, ttlMs: 1_000 });
		cache.set("k", 1);

		expect(reload(cache, { clock: () => 999, ttlMs: 1_000 }).stats().entries).toBe(1);
		expect(reload(cache, { clock: () => 1_000, ttlMs: 1_000 }).stats().entries).toBe(0);
		expect(reload(cache, { clock: () => 50, ttlMs: 10 }).stats().entries).toBe(0);
	});

	it("trims an over-capacity state and counts the refused entries as evictions", () => {
		const state = {
			version: 1,
			entries: [
				{ key: "a", value: 1, storedAt: 0 },
				{ key: "b", value: 2, storedAt: 0 },
				{ key: "c", value: 3, storedAt: 0 },
			],
		};
		const cache = ResultCache.fromState(state, { clock: () => 0, maxEntries: 2 });
		expect(cache.stats()).toEqual({ entries: 2, hits: 0, misses: 0, evicted: 1 });
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBe(2);
		expect(cache.get("c")).toBe(3);
	});

	it("yields an empty cache for garbage input, never a throw", () => {
		const cyclic: Record<string, unknown> = { version: 1 };
		cyclic.entries = [cyclic];
		const garbage = [
			undefined,
			null,
			42,
			"junk",
			[],
			{},
			{ version: 2, entries: [] },
			{ version: "1", entries: [] },
			{ version: 1, entries: "nope" },
			{ version: 1, entries: [null, 7, "x", {}, { key: "k" }, { key: 7, value: 1, storedAt: 0 }] },
			{ version: 1, entries: [{ key: "k", value: 1, storedAt: "0" }] },
			{ version: 1, entries: [{ key: "k", value: 1, storedAt: Number.NaN }] },
			{ version: 1, entries: [{ key: "k", value: undefined, storedAt: 0 }] },
			{ version: 1, entries: [{ key: "k", value: 1n, storedAt: 0 }] },
			{ version: 1, entries: [{ key: "k", value: () => 1, storedAt: 0 }] },
			cyclic,
		];

		for (const input of garbage) {
			expect(() => ResultCache.fromState(input, { clock: () => 0 })).not.toThrow();
			const cache = ResultCache.fromState(input, { clock: () => 0 });
			expect(cache.stats().entries).toBe(0);
			expect(cache.get("k")).toBeUndefined();
		}
	});

	it("keeps only hashed keys, payloads and timestamps — never the raw request", () => {
		const cache = new ResultCache({ clock: () => 0 });
		const secretive = { query: "top-secret-query", apiKey: "sk-live-abcdef" };
		const key = cacheKey({ op: "search", providerId: "firecrawl-keyless", signature: "sig", request: secretive });
		cache.set(key, { items: [{ title: "t" }] });

		const state = cache.toState() as { version: number; entries: { key: string; value: unknown; storedAt: number }[] };
		expect(Object.keys(state).sort()).toEqual(["entries", "version"]);
		expect(Object.keys(state.entries[0]!).sort()).toEqual(["key", "storedAt", "value"]);
		expect(state.entries[0]!.key).toBe(key);

		const serialized = JSON.stringify(state);
		expect(serialized).not.toContain("top-secret-query");
		expect(serialized).not.toContain("sk-live-abcdef");
	});
});

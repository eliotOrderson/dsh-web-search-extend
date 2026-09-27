/**
 * Integration coverage for the cache tier's mount point: the seam provider.
 * The store itself is pinned by cache.test.ts; what is verified here is the
 * wiring the Lead owns — a repeat query must not reach the adapter, a hit must
 * be visible on the degradation trail, and nothing about a served result may
 * leak back into what the next hit replays.
 */
import { describe, expect, it, vi } from "vitest";
import { ResultCache } from "../src/core/cache.js";
import { ExtensibleWebSearchProvider, type ResolvedOptions } from "../src/core/provider.js";
import type { WithAttempts } from "../src/core/chain.js";
import type { SearchAdapter } from "../src/types.js";

/** Scripted adapter that records every dispatch. */
function fakeAdapter(over: Partial<SearchAdapter> = {}) {
	const calls: string[] = [];
	const adapter: SearchAdapter = {
		id: "primary",
		label: "primary",
		requiresApiKey: false,
		defaultApiKeyEnv: "PRIMARY_API_KEY",
		baseURLEnv: "PRIMARY_BASE_URL",
		defaultBaseURL: "https://primary.test",
		available: () => true,
		search: (request) => {
			calls.push(request.query);
			return Promise.resolve({ sources: [{ url: `https://primary.test/${request.query}`, title: "hit" }], truncated: false }) as ReturnType<
				SearchAdapter["search"]
			>;
		},
		...over,
	} as SearchAdapter;
	return { adapter, calls };
}

function optionsFor(adapter: SearchAdapter, over: Partial<ResolvedOptions> = {}): () => ResolvedOptions {
	return () => ({
		provider: "primary",
		apiKeyEnv: "PRIMARY_API_KEY",
		baseURL: "https://primary.test",
		adapter,
		settings: { maxResults: 5 },
		...over,
	});
}

type Trailed = Awaited<ReturnType<ExtensibleWebSearchProvider["search"]>> & WithAttempts;

describe("cache tier at the provider seam", () => {
	it("serves a repeat query without dispatching and marks the hit", async () => {
		const { adapter, calls } = fakeAdapter();
		const provider = new ExtensibleWebSearchProvider(optionsFor(adapter), new ResultCache());

		const first = (await provider.search({ query: "q" })) as Trailed;
		expect(calls).toEqual(["q"]);
		// A first-fetch result is a DIRECT success: it must stay metadata-free so
		// "silence means nothing degraded" keeps holding.
		expect(first.warnings).toBeUndefined();
		expect(first.attempts).toBeUndefined();

		const second = (await provider.search({ query: "q" })) as Trailed;
		expect(calls).toEqual(["q"]);
		expect(second.warnings?.join(" ")).toMatch(/cache hit \(age \d+s\)/);
		expect(second.sources).toEqual(first.sources);
	});

	it("keeps a cache hit free of fabricated attempts", async () => {
		const { adapter } = fakeAdapter();
		const provider = new ExtensibleWebSearchProvider(optionsFor(adapter), new ResultCache());
		await provider.search({ query: "q" });
		const hit = (await provider.search({ query: "q" })) as Trailed;
		// Not [] — a member never ran, and an empty trail would read as one that did.
		expect(hit.attempts).toBeUndefined();
	});

	it("separates keys by query and by answer-affecting config", async () => {
		const { adapter, calls } = fakeAdapter();
		const provider = new ExtensibleWebSearchProvider(optionsFor(adapter), new ResultCache());
		await provider.search({ query: "q" });
		await provider.search({ query: "other" });
		expect(calls).toEqual(["q", "other"]);

		// A separate store starts cold, so the retargeted provider must reach the
		// adapter once — its entry simply does not exist yet.
		const retargeted = new ExtensibleWebSearchProvider(optionsFor(adapter, { settings: { maxResults: 9 } }), new ResultCache());
		await retargeted.search({ query: "q" });
		expect(calls).toEqual(["q", "other", "q"]);
		// ...and repeats of that retargeted shape do hit.
		await retargeted.search({ query: "q" });
		expect(calls).toEqual(["q", "other", "q"]);
	});

	it("treats a settings change as a different entry rather than a stale hit", async () => {
		const { adapter, calls } = fakeAdapter();
		const cache = new ResultCache();
		const first = new ExtensibleWebSearchProvider(optionsFor(adapter), cache);
		await first.search({ query: "q" });

		// Same cache instance, different effective settings: the signature must
		// keep the old answer from being replayed under the new config.
		const second = new ExtensibleWebSearchProvider(optionsFor(adapter, { settings: { maxResults: 9 } }), cache);
		await second.search({ query: "q" });
		expect(calls).toEqual(["q", "q"]);
	});

	it("isolates the stored entry from what the caller was handed", async () => {
		const { adapter, calls } = fakeAdapter();
		const provider = new ExtensibleWebSearchProvider(optionsFor(adapter), new ResultCache());

		const first = (await provider.search({ query: "q" })) as Trailed;
		// The seam's result is readonly; the point is that a caller which mutates
		// what it was handed must not reach the stored copy.
		const mutable = first.sources as { url: string }[];
		mutable[0]!.url = "https://mutated.test/";
		mutable.push({ url: "https://extra.test/" });

		const second = (await provider.search({ query: "q" })) as Trailed;
		expect(calls).toEqual(["q"]);
		expect(second.warnings?.join(" ")).toMatch(/cache hit/);
		expect(second.sources).toHaveLength(1);
		expect(second.sources[0]!.url).toBe("https://primary.test/q");
	});

	it("publishes once per stored result and never on a hit", async () => {
		const { adapter } = fakeAdapter();
		const onCacheWrite = vi.fn();
		const provider = new ExtensibleWebSearchProvider(optionsFor(adapter), new ResultCache(), onCacheWrite);
		await provider.search({ query: "q" });
		expect(onCacheWrite).toHaveBeenCalledTimes(1);
		await provider.search({ query: "q" });
		expect(onCacheWrite).toHaveBeenCalledTimes(1);
	});

	it("stops serving hits the moment the tier is switched off", async () => {
		const { adapter, calls } = fakeAdapter();
		let enabled = true;
		const provider = new ExtensibleWebSearchProvider(optionsFor(adapter), new ResultCache(), undefined, () => enabled);
		await provider.search({ query: "q" });
		await provider.search({ query: "q" });
		expect(calls).toEqual(["q"]);

		// `enabled` is read per call, so flipping the live config must stop HITS —
		// not merely the next store, which is what latching it at mount did.
		enabled = false;
		await provider.search({ query: "q" });
		expect(calls).toEqual(["q", "q"]);
	});

	it("dispatches every time when no cache is mounted", async () => {
		const { adapter, calls } = fakeAdapter();
		const provider = new ExtensibleWebSearchProvider(optionsFor(adapter));
		await provider.search({ query: "q" });
		await provider.search({ query: "q" });
		expect(calls).toEqual(["q", "q"]);
	});

	it("does not cache a failure, so the next call re-dispenses it", async () => {
		let attempts = 0;
		const { adapter } = fakeAdapter({
			search: () => {
				attempts += 1;
				return Promise.reject(new Error("boom")) as ReturnType<SearchAdapter["search"]>;
			},
		});
		const provider = new ExtensibleWebSearchProvider(optionsFor(adapter), new ResultCache());
		await expect(provider.search({ query: "q" })).rejects.toThrow();
		await expect(provider.search({ query: "q" })).rejects.toThrow();
		expect(attempts).toBe(2);
	});
});

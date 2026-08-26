import { describe, expect, it, vi } from "vitest";
import { WebError, type WebFetchResult } from "@deepseek-ai/dsh-web";
import {
	compositeLimits,
	DEFAULT_CRAWL_MAX_PAGES,
	DEFAULT_EXTRACT_MAX_URLS,
	DEFAULT_MAP_MAX_URLS,
	DEFAULT_PER_PAGE_CHARS,
	execute,
	pollResearch,
} from "../src/core/router.js";
import type { AdapterRuntime, ExtractResult, FetchLike, WebAdapter } from "../src/types.js";

const SITEMAP_URLS = ["https://site.example/p1"];

function makeRuntime(settings: Record<string, unknown> = {}): AdapterRuntime {
	return { apiKeyEnv: "TEST_API_KEY", baseURL: "https://backend.test", settings };
}

function baseAdapter(overrides: Partial<WebAdapter> = {}): WebAdapter {
	return {
		id: "fake",
		label: "Fake",
		requiresApiKey: false,
		defaultApiKeyEnv: "FAKE_KEY",
		baseURLEnv: "FAKE_BASE_URL",
		defaultBaseURL: "https://backend.test",
		available: () => true,
		search: async () => ({ sources: [], truncated: false }),
		...overrides,
	};
}

function htmlResponse(finalUrl: string, content: string): WebFetchResult {
	return { url: finalUrl, statusCode: 200, body: { kind: "html", content }, truncated: false };
}

function textResponse(finalUrl: string, content: string): WebFetchResult {
	return { url: finalUrl, statusCode: 200, body: { kind: "text", content }, truncated: false };
}

function sitemapUrlset(locs: readonly string[]): string {
	return `<?xml version="1.0" encoding="UTF-8"?><urlset>${locs.map((loc) => `<url><loc>${loc}</loc></url>`).join("")}</urlset>`;
}

/** A fetch double that fails the test if the composite tier runs when it must not. */
const neverFetch: FetchLike = async () => {
	throw new Error("composite tier must not run");
};

function catchSync(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("router ladder: native wins", () => {
	it("routes extract to the native adapter method without touching fetch", async () => {
		const native: ExtractResult = { pages: [{ url: "https://site.example/a", content: "native body" }], truncated: false };
		const adapter = baseAdapter({ id: "native-extract", extract: async () => native });
		const result = await execute({
			op: "extract",
			request: { urls: ["https://site.example/a"] },
			adapter,
			runtime: makeRuntime(),
			fetch: neverFetch,
		});
		expect(result).toEqual(native);
	});

	it("routes search straight through to the adapter", async () => {
		const searchResult = { sources: [{ url: "https://site.example/r" }], truncated: false };
		const adapter = baseAdapter({ id: "native-search", search: async () => searchResult });
		const result = await execute({
			op: "search",
			request: { query: "hello" },
			adapter,
			runtime: makeRuntime(),
			fetch: neverFetch,
		});
		expect(result).toBe(searchResult);
	});
});

describe("router modes: provider-first vs local-only (extract/crawl/map)", () => {
	const failingExtract = (): WebAdapter =>
		baseAdapter({
			id: "tavily-like",
			extract: async () => {
				throw new WebError("keyless tier cannot extract", "WEB_PROVIDER_ERROR");
			},
		});

	const docFetch: FetchLike = async ({ url }) => {
		if (url === "https://site.example/doc") return htmlResponse(url, "<h1>Doc</h1><p>body text</p>");
		throw new Error(`unexpected fetch: ${url}`);
	};

	it("retries a failed native extract through the composite and marks the result with a warning", async () => {
		const result = (await execute({
			op: "extract",
			request: { urls: ["https://site.example/doc"] },
			adapter: failingExtract(),
			runtime: makeRuntime({ routeMode: "provider-first" }),
			fetch: docFetch,
		})) as ExtractResult & { warnings?: string[] };
		expect(result.pages[0]?.content).toContain("body text");
		expect(result.warnings?.[0]).toContain("tavily-like extract failed");
		expect(result.warnings?.[0]).toContain("fell back to local extract");
	});

	it("defaults to cascading when the flag is omitted", async () => {
		const result = await execute({
			op: "extract",
			request: { urls: ["https://site.example/doc"] },
			adapter: failingExtract(),
			runtime: makeRuntime(),
			fetch: docFetch,
		});
		expect(result.pages[0]?.content).toContain("body text");
	});

	it("local-only routes straight to the composite without calling the native method", async () => {
		let nativeCalls = 0;
		const adapter = baseAdapter({
			id: "tavily-like",
			extract: async () => {
				nativeCalls += 1;
				return { pages: [{ url: "https://site.example/doc", content: "native" }], truncated: false };
			},
		});
		const result = await execute({
			op: "extract",
			request: { urls: ["https://site.example/doc"] },
			adapter,
			runtime: makeRuntime({ routeMode: "local-only" }),
			fetch: docFetch,
		});
		expect(result.pages[0]?.content).toContain("body text");
		expect(nativeCalls).toBe(0);
	});

	it("never cascades on abort", async () => {
		const controller = new AbortController();
		controller.abort();
		const slow = baseAdapter({
			id: "slow-extract",
			extract: (_request, _runtime, signal) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
				}),
		});
		let captured: unknown;
		try {
			await execute({
				op: "extract",
				request: { urls: ["https://site.example/doc"] },
				adapter: slow,
				runtime: makeRuntime({ routeMode: "provider-first" }),
				fetch: docFetch,
				signal: controller.signal,
			});
		} catch (e) {
			captured = e;
		}
		expect(captured).toBeInstanceOf(WebError);
		expect((captured as WebError).code).toBe("WEB_ABORTED");
	});
});

describe("router ladder: composite floor for search-only adapters", () => {
	it("serves extract, map, and crawl from composites", async () => {
		const calls: string[] = [];
		const fetch: FetchLike = async ({ url }) => {
			calls.push(url);
			if (url === "https://site.example/robots.txt") return textResponse(url, "User-agent: *\nDisallow:");
			if (url === "https://site.example/sitemap.xml") return textResponse(url, sitemapUrlset(SITEMAP_URLS));
			if (url === "https://site.example/doc") return htmlResponse(url, "<h1>Doc</h1><p>body text</p>");
			throw new Error(`unexpected fetch: ${url}`);
		};
		const adapter = baseAdapter({ id: "search-only" });

		const extracted = await execute({
			op: "extract",
			request: { urls: ["https://site.example/doc"] },
			adapter,
			runtime: makeRuntime(),
			fetch,
		});
		expect(extracted.pages[0]?.url).toBe("https://site.example/doc");

		const mapped = await execute({
			op: "map",
			request: { url: "https://site.example/" },
			adapter,
			runtime: makeRuntime(),
			fetch,
		});
		expect(mapped.urls).toEqual(SITEMAP_URLS);

		const crawled = await execute({
			op: "crawl",
			request: { url: "https://site.example/doc", maxPages: 1 },
			adapter,
			runtime: makeRuntime(),
			fetch,
		});
		expect(crawled.pages.map((p) => p.url)).toEqual(["https://site.example/doc"]);
	});
});

describe("router ladder: structured unsupported", () => {
	it("rejects research on a search-only adapter with WEB_OP_UNSUPPORTED naming op and provider", async () => {
		const adapter = baseAdapter({ id: "search-only" });
		await expect(
			execute({ op: "research", request: "find things", adapter, runtime: makeRuntime(), fetch: neverFetch }),
		).rejects.toMatchObject({
			code: "WEB_OP_UNSUPPORTED",
			message: expect.stringContaining('operation "research" is not supported by provider "search-only"'),
		});
	});

	it("rejects polling when the adapter cannot poll", () => {
		const error = catchSync(() => pollResearch({ requestId: "r-1", adapter: baseAdapter(), runtime: makeRuntime() }));
		expect(error).toBeInstanceOf(WebError);
		expect((error as WebError).code).toBe("WEB_OP_UNSUPPORTED");
	});
});

describe("error normalization", () => {
	it("wraps foreign errors from the native tier as WEB_PROVIDER_ERROR", async () => {
		const adapter = baseAdapter({
			id: "exploding",
			search: async () => {
				throw new Error("socket exploded");
			},
		});
		await expect(
			execute({ op: "search", request: { query: "q" }, adapter, runtime: makeRuntime(), fetch: neverFetch }),
		).rejects.toMatchObject({
			code: "WEB_PROVIDER_ERROR",
			message: expect.stringContaining('Search via "exploding"'),
		});
	});

	it("lets WebError pass through unchanged", async () => {
		const original = new WebError("credential gone", "WEB_PROVIDER_CREDENTIAL_MISSING");
		const adapter = baseAdapter({
			search: async () => {
				throw original;
			},
		});
		await expect(
			execute({ op: "search", request: { query: "q" }, adapter, runtime: makeRuntime(), fetch: neverFetch }),
		).rejects.toBe(original);
	});
});

describe("cancellation", () => {
	it("refuses to start when the signal is already aborted", () => {
		const controller = new AbortController();
		controller.abort();
		const error = catchSync(() =>
			execute({ op: "search", request: { query: "q" }, adapter: baseAdapter(), runtime: makeRuntime(), fetch: neverFetch, signal: controller.signal }),
		);
		expect(error).toBeInstanceOf(WebError);
		expect((error as WebError).code).toBe("WEB_ABORTED");
	});

	it("aborts an in-flight native operation with WEB_ABORTED", async () => {
		const controller = new AbortController();
		const stuck = baseAdapter({ extract: () => new Promise<ExtractResult>(() => {}) });
		const pending = execute({
			op: "extract",
			request: { urls: ["https://site.example/a"] },
			adapter: stuck,
			runtime: makeRuntime(),
			fetch: neverFetch,
			signal: controller.signal,
		});
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "WEB_ABORTED" });
	});
});

describe("compositeLimits", () => {
	it("applies the spec section 10 defaults when settings omit limits", () => {
		expect(compositeLimits({})).toEqual({
			extractMaxUrls: DEFAULT_EXTRACT_MAX_URLS,
			crawlMaxPages: DEFAULT_CRAWL_MAX_PAGES,
			mapMaxUrls: DEFAULT_MAP_MAX_URLS,
			perPageChars: DEFAULT_PER_PAGE_CHARS,
		});
	});

	it("honors partial overrides over the defaults", () => {
		expect(compositeLimits({ limits: { mapMaxUrls: 7 } })).toEqual({
			extractMaxUrls: DEFAULT_EXTRACT_MAX_URLS,
			crawlMaxPages: DEFAULT_CRAWL_MAX_PAGES,
			mapMaxUrls: 7,
			perPageChars: DEFAULT_PER_PAGE_CHARS,
		});
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebError } from "@deepseek-ai/dsh-web";
import { FirecrawlKeylessAdapter } from "../src/adapters/firecrawl.js";
import { createDefaultRegistry } from "../src/adapters/index.js";
import { capabilitiesOf } from "../src/core/capabilities.js";

const mocks = vi.hoisted(() => {
	class SdkErrorMock extends Error {
		status?: number;
		code?: string;

		constructor(message: string, status?: number, code?: string) {
			super(message);
			this.status = status;
			this.code = code;
		}
	}

	class FirecrawlMock {
		constructorArgs: unknown[];

		constructor(...args: unknown[]) {
			this.constructorArgs = args;
			(FirecrawlMock as any).instances.push(this);
		}

		search(...args: unknown[]) {
			return (FirecrawlMock as any).searchMock(...args);
		}

		scrape(...args: unknown[]) {
			return (FirecrawlMock as any).scrapeMock(...args);
		}

		crawl(...args: unknown[]) {
			return (FirecrawlMock as any).crawlMock(...args);
		}

		map(...args: unknown[]) {
			return (FirecrawlMock as any).mapMock(...args);
		}
	}

	(FirecrawlMock as any).instances = [];
	(FirecrawlMock as any).searchMock = vi.fn();
	(FirecrawlMock as any).scrapeMock = vi.fn();
	(FirecrawlMock as any).crawlMock = vi.fn();
	(FirecrawlMock as any).mapMock = vi.fn();

	return { FirecrawlMock, SdkErrorMock };
});

vi.mock("firecrawl", () => ({
	Firecrawl: mocks.FirecrawlMock,
	SdkError: mocks.SdkErrorMock,
}));

const client = () => (mocks.FirecrawlMock as any).instances[0] as {
	constructorArgs: unknown[];
};

const searchMock = () => (mocks.FirecrawlMock as any).searchMock as ReturnType<typeof vi.fn>;
const scrapeMock = () => (mocks.FirecrawlMock as any).scrapeMock as ReturnType<typeof vi.fn>;
const crawlMock = () => (mocks.FirecrawlMock as any).crawlMock as ReturnType<typeof vi.fn>;
const mapMock = () => (mocks.FirecrawlMock as any).mapMock as ReturnType<typeof vi.fn>;

beforeEach(() => {
	(mocks.FirecrawlMock as any).instances.length = 0;
	vi.clearAllMocks();
});

afterEach(() => {
	vi.clearAllMocks();
});

const runtime = { apiKeyEnv: "FIRECRAWL_API_KEY", baseURL: "https://api.firecrawl.test", settings: {} };

describe("registry + capability pinning", () => {
	it("registers firecrawl-keyless as a keyless adapter with search/extract/crawl/map", () => {
		const adapter = createDefaultRegistry().get("firecrawl-keyless");
		expect(adapter).toBeDefined();
		expect(adapter?.requiresApiKey).toBe(false);
		expect([...capabilitiesOf(adapter!)].sort()).toEqual(["crawl", "extract", "map", "search"]);
	});
});

describe("available()", () => {
	it("is available keyless and with a well-shaped fc- key", () => {
		expect(FirecrawlKeylessAdapter.available(runtime)).toBe(true);
		expect(FirecrawlKeylessAdapter.available({ ...runtime, apiKey: "fc-abc123" })).toBe(true);
	});

	it("is unavailable when the ref holds a malformed key or the baseURL is unusable", () => {
		expect(FirecrawlKeylessAdapter.available({ ...runtime, apiKey: "tvly-abc123" })).toBe(false);
		expect(FirecrawlKeylessAdapter.available({ ...runtime, baseURL: "not-a-url" })).toBe(false);
	});
});

describe("search mapping", () => {
	it("maps data.web into deduped sources and passes keyless config to the SDK", async () => {
		searchMock().mockResolvedValue({
			web: [
				{ title: "One", url: "https://a.example/1", description: "first snippet" },
				{ title: "Dup", url: "https://a.example/1", description: "duplicate url" },
				{ url: "https://b.example/2", description: "" },
			],
		});
		const result = await FirecrawlKeylessAdapter.search({ query: "q", maxResults: 3 }, runtime);
		expect(result).toEqual({
			sources: [
				{ url: "https://a.example/1", title: "One", snippet: "first snippet" },
				{ url: "https://b.example/2" },
			],
			truncated: false,
		});
		expect(client().constructorArgs[0]).toEqual({ apiKey: undefined, apiUrl: "https://api.firecrawl.test" });
		expect(searchMock()).toHaveBeenCalledWith("q", { limit: 3 });
	});

	it("passes the resolved key to the SDK when one is configured (quota upgrade)", async () => {
		searchMock().mockResolvedValue({ web: [] });
		await FirecrawlKeylessAdapter.search({ query: "q" }, { ...runtime, apiKey: "fc-key-1" });
		expect(client().constructorArgs[0]).toEqual({ apiKey: "fc-key-1", apiUrl: "https://api.firecrawl.test" });
	});

	it("falls back to the default result cap when the request has no maxResults", async () => {
		searchMock().mockResolvedValue({ web: [] });
		await FirecrawlKeylessAdapter.search({ query: "q" }, runtime);
		expect(searchMock()).toHaveBeenCalledWith("q", { limit: 5 });
	});
});

describe("extract mapping", () => {
	it("maps a scraped Document into the seam page shape", async () => {
		scrapeMock().mockResolvedValue({
			markdown: "# Hello",
			metadata: { title: "Page", sourceURL: "https://a.example/1" },
		});
		const result = await FirecrawlKeylessAdapter.extract!({ urls: ["https://a.example/1"], format: "markdown" }, runtime);
		expect(result).toEqual({
			pages: [{ url: "https://a.example/1", title: "Page", content: "# Hello" }],
			truncated: false,
		});
		expect(scrapeMock()).toHaveBeenCalledWith("https://a.example/1", { formats: ["markdown"] });
	});

	it("keeps per-URL failures as page-level failure reasons", async () => {
		scrapeMock().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({
			markdown: "ok",
			metadata: { sourceURL: "https://b.example/2" },
		});
		const result = await FirecrawlKeylessAdapter.extract!({ urls: ["https://a.example/1", "https://b.example/2"] }, runtime);
		expect(result.pages).toEqual([
			{ url: "https://a.example/1", failureReason: "boom" },
			{ url: "https://b.example/2", content: "ok" },
		]);
	});
});

describe("crawl mapping", () => {
	it("maps a completed crawl job into pages", async () => {
		crawlMock().mockResolvedValue({
			status: "completed",
			data: [
				{ markdown: "# A", metadata: { title: "A", sourceURL: "https://site/a" } },
				{ html: "<p>B</p>", metadata: { sourceURL: "https://site/b" } },
			],
		});
		const result = await FirecrawlKeylessAdapter.crawl!({ url: "https://site", maxPages: 5 }, runtime);
		expect(result).toEqual({
			pages: [
				{ url: "https://site/a", title: "A", content: "# A" },
				{ url: "https://site/b", content: "<p>B</p>" },
			],
			truncated: false,
		});
		expect(crawlMock()).toHaveBeenCalledWith("https://site", expect.objectContaining({
			limit: 5,
			scrapeOptions: { formats: ["markdown"] },
			pollInterval: 2,
			timeout: 60,
		}));
	});
});

describe("map mapping", () => {
	it("dedupes mapped links into a URL list", async () => {
		mapMock().mockResolvedValue({
			links: [
				{ url: "https://site/a" },
				{ url: "https://site/a" },
				{ url: "https://site/b" },
			],
		});
		const result = await FirecrawlKeylessAdapter.map!({ url: "https://site", maxUrls: 10 }, runtime);
		expect(result).toEqual({ urls: ["https://site/a", "https://site/b"], truncated: false });
		expect(mapMock()).toHaveBeenCalledWith("https://site", { limit: 10 });
	});
});

describe("error normalization", () => {
	it("maps HTTP 402 to WEB_PROVIDER_ERROR naming the monthly quota and the credential ref", async () => {
		searchMock().mockRejectedValue(new mocks.SdkErrorMock("Payment required", 402));
		await expect(FirecrawlKeylessAdapter.search({ query: "q" }, runtime)).rejects.toMatchObject({
			code: "WEB_PROVIDER_ERROR",
			message: expect.stringContaining("FIRECRAWL_API_KEY"),
		});
		await expect(FirecrawlKeylessAdapter.search({ query: "q" }, runtime)).rejects.toBeInstanceOf(WebError);
	});

	it("maps HTTP 429 to WEB_PROVIDER_ERROR as a rate-limit failure", async () => {
		searchMock().mockRejectedValue(new mocks.SdkErrorMock("Rate limit surpassed", 429));
		await expect(FirecrawlKeylessAdapter.search({ query: "q" }, runtime)).rejects.toMatchObject({
			code: "WEB_PROVIDER_ERROR",
			message: expect.stringContaining("rate limit"),
		});
	});

	it("surfaces an SDK error without a recognized status as a provider error carrying the server text", async () => {
		searchMock().mockRejectedValue(new mocks.SdkErrorMock("Request timed out", 200));
		await expect(FirecrawlKeylessAdapter.search({ query: "q" }, runtime)).rejects.toMatchObject({
			code: "WEB_PROVIDER_ERROR",
			message: expect.stringContaining("Request timed out"),
		});
	});

	it("wraps a transport failure as WEB_PROVIDER_ERROR", async () => {
		searchMock().mockRejectedValue(new Error("socket hung up"));
		await expect(FirecrawlKeylessAdapter.search({ query: "q" }, runtime)).rejects.toMatchObject({
			code: "WEB_PROVIDER_ERROR",
		});
	});

	it("throws WEB_ABORTED before dispatch when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error("user cancelled"));
		await expect(FirecrawlKeylessAdapter.search({ query: "q" }, runtime, controller.signal)).rejects.toMatchObject({
			code: "WEB_ABORTED",
		});
		expect(searchMock()).not.toHaveBeenCalled();
	});
});
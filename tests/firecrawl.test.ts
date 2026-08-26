import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebError } from "@deepseek-ai/dsh-web";
import { FirecrawlKeylessAdapter } from "../src/adapters/firecrawl.js";
import { createDefaultRegistry } from "../src/adapters/index.js";
import { capabilitiesOf } from "../src/core/capabilities.js";

// The adapter owns the v2 search call and the response -> seam-type mapping;
// global fetch is stubbed so these tests pin both with zero network.
const fetchMock = vi.hoisted(() => vi.fn());

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

const jsonResponse = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const runtime = { apiKeyEnv: "FIRECRAWL_API_KEY", baseURL: "https://api.firecrawl.test", settings: {} };

describe("registry + capability pinning", () => {
	it("registers firecrawl-keyless as a keyless, search-only bundled adapter", () => {
		const adapter = createDefaultRegistry().get("firecrawl-keyless");
		expect(adapter).toBeDefined();
		expect(adapter?.requiresApiKey).toBe(false);
		expect([...capabilitiesOf(adapter!)].sort()).toEqual(["search"]);
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
	it("posts to /v2/search without an Authorization header and maps data.web into deduped sources", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(200, {
				success: true,
				data: {
					web: [
						{ title: "One", url: "https://a.example/1", description: "first snippet" },
						{ title: "Dup", url: "https://a.example/1", description: "duplicate url" },
						{ url: "https://b.example/2", description: "" },
					],
				},
			}),
		);
		const result = await FirecrawlKeylessAdapter.search({ query: "q", maxResults: 3 }, runtime);
		expect(result).toEqual({
			sources: [
				{ url: "https://a.example/1", title: "One", snippet: "first snippet" },
				{ url: "https://b.example/2" },
			],
			truncated: false,
		});
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string>; body: string }];
		expect(url).toBe("https://api.firecrawl.test/v2/search");
		expect(init.method).toBe("POST");
		expect(init.headers["authorization"]).toBeUndefined();
		expect(JSON.parse(init.body)).toEqual({ query: "q", limit: 3 });
	});

	it("sends the resolved key as a Bearer token when one is configured (quota upgrade)", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: { web: [] } }));
		await FirecrawlKeylessAdapter.search({ query: "q" }, { ...runtime, apiKey: "fc-key-1" });
		const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
		expect(init.headers.authorization).toBe("Bearer fc-key-1");
	});

	it("falls back to the default result cap when the request has no maxResults", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: { web: [] } }));
		await FirecrawlKeylessAdapter.search({ query: "q" }, runtime);
		const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
		expect(JSON.parse(init.body).limit).toBe(5);
	});
});

describe("error normalization", () => {
	it("maps HTTP 402 to WEB_PROVIDER_ERROR naming the monthly quota and the credential ref", async () => {
		fetchMock.mockResolvedValue(jsonResponse(402, { success: false, error: "Payment required" }));
		await expect(FirecrawlKeylessAdapter.search({ query: "q" }, runtime)).rejects.toMatchObject({
			code: "WEB_PROVIDER_ERROR",
			message: expect.stringContaining("FIRECRAWL_API_KEY"),
		});
		await expect(FirecrawlKeylessAdapter.search({ query: "q" }, runtime)).rejects.toBeInstanceOf(WebError);
	});

	it("maps HTTP 429 to WEB_PROVIDER_ERROR as a rate-limit failure", async () => {
		fetchMock.mockResolvedValue(jsonResponse(429, { success: false, error: "Rate limit surpassed" }));
		await expect(FirecrawlKeylessAdapter.search({ query: "q" }, runtime)).rejects.toMatchObject({
			code: "WEB_PROVIDER_ERROR",
			message: expect.stringContaining("rate limit"),
		});
	});

	it("surfaces a 200 envelope with success:false as a provider error carrying the server text", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { success: false, error: "Request timed out" }));
		await expect(FirecrawlKeylessAdapter.search({ query: "q" }, runtime)).rejects.toMatchObject({
			code: "WEB_PROVIDER_ERROR",
			message: expect.stringContaining("Request timed out"),
		});
	});

	it("wraps a transport failure (fetch rejection) as WEB_PROVIDER_ERROR", async () => {
		fetchMock.mockRejectedValue(new Error("socket hung up"));
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
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

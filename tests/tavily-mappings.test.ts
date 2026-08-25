import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebError, type WebSearchResult } from "@deepseek-ai/dsh-web";
import { TavilyKeylessLimitError } from "@tavily/core";
import { TavilyAdapter } from "../src/adapters/tavily.js";
import { isResearchComplete } from "../src/types.js";

// The whole @tavily/core module is mocked: the adapter owns every response
// shape -> seam-type mapping, and these tests pin it against the exact shapes
// quoted in design section 2. Zero network.
const state = vi.hoisted(() => {
	const client = {
		search: vi.fn(),
		extract: vi.fn(),
		crawl: vi.fn(),
		map: vi.fn(),
		research: vi.fn(),
		getResearch: vi.fn(),
	};
	const tavily = vi.fn(() => client);
	return { client, tavily };
});

vi.mock("@tavily/core", () => ({
	tavily: state.tavily,
	TavilyKeylessLimitError: class TavilyKeylessLimitError extends Error {},
}));

const runtime = { apiKeyEnv: "TAVILY_API_KEY", baseURL: "https://api.tavily.test", settings: {} };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("search mapping (regression)", () => {
	it("maps answer + results into sources with dedupe and optional-field omission", async () => {
		state.client.search.mockResolvedValue({
			answer: "Synthesized answer",
			query: "q",
			responseTime: 3,
			images: [],
			requestId: "req-1",
			results: [
				{ title: "One", url: "https://a.example/1", content: "first snippet", score: 1, publishedDate: "2024-01-01", id: "1" },
				{ title: "Dup", url: "https://a.example/1", content: "duplicate url", score: 0.9, publishedDate: "", id: "2" },
				{ title: "", url: "https://b.example/2", content: "", score: 0.8, publishedDate: "2024-02-02", id: "3" },
			],
		});
		const result: WebSearchResult = await TavilyAdapter.search({ query: "q" }, runtime);
		expect(result).toEqual({
			content: "Synthesized answer",
			sources: [
				{ url: "https://a.example/1", title: "One", snippet: "first snippet", publishedAt: "2024-01-01" },
				{ url: "https://b.example/2", publishedAt: "2024-02-02" },
			],
			truncated: false,
		});
		expect(state.tavily).toHaveBeenCalledWith(expect.objectContaining({ apiBaseURL: runtime.baseURL }));
		expect(state.client.search).toHaveBeenCalledWith("q", expect.objectContaining({ maxResults: 5, searchDepth: "basic" }));
	});
});

describe("extract mapping", () => {
	it("merges results and failedResults into page-level outcomes", async () => {
		state.client.extract.mockResolvedValue({
			results: [
				{ url: "https://a.example/1", title: "Doc", rawContent: "# Body" },
				{ url: "https://a.example/2", title: null, rawContent: "No title here" },
			],
			failedResults: [{ url: "https://b.example/broken", error: "extraction timed out" }],
			responseTime: 5,
			requestId: "e-1",
		});
		const result = await TavilyAdapter.extract(
			{ urls: ["https://a.example/1", "https://a.example/2", "https://b.example/broken"] },
			runtime,
		);
		expect(result).toEqual({
			pages: [
				{ url: "https://a.example/1", title: "Doc", content: "# Body" },
				{ url: "https://a.example/2", content: "No title here" },
				{ url: "https://b.example/broken", failureReason: "extraction timed out" },
			],
			truncated: false,
		});
	});
});

describe("crawl mapping", () => {
	it("projects rawContent results into pages", async () => {
		state.client.crawl.mockResolvedValue({
			responseTime: 1,
			baseUrl: "https://a.example",
			requestId: "c-1",
			results: [
				{ url: "https://a.example/1", rawContent: "page one markdown", images: [] },
				{ url: "https://a.example/2", rawContent: "page two markdown", images: [] },
			],
		});
		const result = await TavilyAdapter.crawl({ url: "https://a.example" }, runtime);
		expect(result).toEqual({
			pages: [
				{ url: "https://a.example/1", content: "page one markdown" },
				{ url: "https://a.example/2", content: "page two markdown" },
			],
			truncated: false,
		});
	});
});

describe("map mapping", () => {
	it("dedupes the string list of urls", async () => {
		state.client.map.mockResolvedValue({
			responseTime: 1,
			baseUrl: "https://a.example",
			requestId: "m-1",
			results: ["https://x.example/1", "https://x.example/2", "https://x.example/1"],
		});
		const result = await TavilyAdapter.map({ url: "https://a.example" }, runtime);
		expect(result).toEqual({ urls: ["https://x.example/1", "https://x.example/2"], truncated: false });
	});
});

describe("research mapping", () => {
	it("submits and maps requestId + status", async () => {
		state.client.research.mockResolvedValue({
			requestId: "r-42",
			createdAt: "2026-01-01T00:00:00Z",
			status: "pending",
			input: "topic",
			model: "auto",
			responseTime: 1,
		});
		await expect(TavilyAdapter.submitResearch("topic", runtime)).resolves.toEqual({
			requestId: "r-42",
			status: "pending",
		});
	});

	it("maps a completed poll with string content and sources", async () => {
		state.client.getResearch.mockResolvedValue({
			requestId: "r-42",
			createdAt: "2026-01-01T00:00:00Z",
			status: "completed",
			content: "Findings text",
			sources: [
				{ title: "Src One", url: "https://s.example/1" },
				{ title: "", url: "https://s.example/2" },
			],
			responseTime: 2,
		});
		await expect(TavilyAdapter.pollResearch("r-42", runtime)).resolves.toEqual({
			requestId: "r-42",
			status: "completed",
			content: "Findings text",
			sources: [{ url: "https://s.example/1", title: "Src One" }, { url: "https://s.example/2" }],
		});
	});

	it("stringifies object-shaped content on completion", async () => {
		const structured = { sections: [{ heading: "h", body: "b" }] };
		state.client.getResearch.mockResolvedValue({
			requestId: "r-7",
			createdAt: "2026-01-01T00:00:00Z",
			status: "completed",
			content: structured,
			sources: [],
			responseTime: 2,
		});
		const status = await TavilyAdapter.pollResearch("r-7", runtime);
		expect(status.content).toBe(JSON.stringify(structured));
		expect(status.sources).toBeUndefined();
	});

	it("keeps an incomplete poll free of content and sources keys", async () => {
		state.client.getResearch.mockResolvedValue({ requestId: "r-43", status: "pending", responseTime: 1 });
		await expect(TavilyAdapter.pollResearch("r-43", runtime)).resolves.toEqual({
			requestId: "r-43",
			status: "pending",
		});
	});

	it("collapses vendor statuses outside the closed union to unknown", async () => {
		state.client.research.mockResolvedValue({
			requestId: "r-9",
			createdAt: "",
			status: "queued",
			input: "x",
			model: "auto",
			responseTime: 1,
		});
		state.client.getResearch.mockResolvedValue({
			requestId: "r-10",
			createdAt: "",
			status: "side_effects_complete",
			content: {},
			sources: [],
			responseTime: 1,
		});
		await expect(TavilyAdapter.submitResearch("x", runtime)).resolves.toEqual({ requestId: "r-9", status: "unknown" });
		await expect(TavilyAdapter.pollResearch("r-10", runtime)).resolves.toMatchObject({ status: "unknown" });
	});
});

describe("isResearchComplete predicate", () => {
	it("treats completed and failed as terminal only", () => {
		expect(isResearchComplete("completed")).toBe(true);
		expect(isResearchComplete("failed")).toBe(true);
		expect(isResearchComplete("pending")).toBe(false);
		expect(isResearchComplete("unknown")).toBe(false);
	});
});

describe("error normalization", () => {
	it("wraps the keyless limit error as WEB_PROVIDER_ERROR naming the credential ref", async () => {
		state.client.search.mockRejectedValue(new TavilyKeylessLimitError("monthly cap reached"));
		await expect(TavilyAdapter.search({ query: "q" }, runtime)).rejects.toMatchObject({
			code: "WEB_PROVIDER_ERROR",
			message: expect.stringContaining("Set TAVILY_API_KEY"),
		});
		await expect(TavilyAdapter.search({ query: "q" }, runtime)).rejects.toBeInstanceOf(WebError);
	});

	it("lets unrelated errors pass through unchanged for the router to normalize", async () => {
		const plain = new Error("socket hung up");
		state.client.extract.mockRejectedValue(plain);
		await expect(TavilyAdapter.extract({ urls: ["https://a.example/1"] }, runtime)).rejects.toBe(plain);
	});
});

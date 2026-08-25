// Mock of @tavily/core used by the unit tests (loaded via loader hook).
// Native-op mocks follow design doc section 2 response shapes.
export class TavilyKeylessLimitError extends Error {}

function guard(method) {
	if (globalThis.__tavilyThrow) {
		throw new Error(globalThis.__tavilyThrow);
	}
	if (globalThis.__tavilyKeylessThrow) {
		throw new TavilyKeylessLimitError(`keyless limit on ${method}`);
	}
}

export function tavily(opts) {
	return {
		search: async (query, params) => {
			globalThis.__lastTavilyCall = { opts, query, params };
			guard("search");
			return {
				answer: "Tavily generated answer for: " + query,
				query,
				responseTime: 0.42,
				images: [],
				results: [
					{
						title: "Example A",
						url: "https://example.com/a",
						content: "Snippet A about the topic.",
						score: 0.91,
						publishedDate: "2024-01-01",
						id: "1",
					},
					{
						title: "Duplicate A",
						url: "https://example.com/a",
						content: "should be deduped",
						score: 0.88,
						publishedDate: "2024-02-02",
						id: "2",
					},
					{
						title: "Example B",
						url: "https://example.com/b",
						content: "Snippet B with no date.",
						score: 0.7,
						publishedDate: "",
						id: "3",
					},
				],
				requestId: "req-1",
			};
		},
		extract: async (urls, params) => {
			globalThis.__lastTavilyCall = { opts, urls, params };
			guard("extract");
			return {
				results: [
					{ url: urls[0], title: "First", rawContent: "# Extracted\n\nbody text" },
					{ url: urls[1] ?? "https://x.test/2", title: null, rawContent: "plain" },
				],
				failedResults: [{ url: "https://fail.test/", error: "EXTRACT_FAILED" }],
				responseTime: 0.5,
				requestId: "req-e",
			};
		},
		crawl: async (url, params) => {
			globalThis.__lastTavilyCall = { opts, url, params };
			guard("crawl");
			return {
				responseTime: 0.6,
				baseUrl: url,
				results: [
					{ url: "https://site.test/", rawContent: "# Home", images: [] },
					{ url: "https://site.test/about", rawContent: "About page", images: [] },
				],
				requestId: "req-c",
			};
		},
		map: async (url, params) => {
			globalThis.__lastTavilyCall = { opts, url, params };
			guard("map");
			return {
				responseTime: 0.4,
				baseUrl: url,
				results: ["https://site.test/a", "https://site.test/b", "https://site.test/a"],
				requestId: "req-m",
			};
		},
		research: async (input, params) => {
			globalThis.__lastTavilyCall = { opts, input, params };
			guard("research");
			return { requestId: "req-r", createdAt: "2024-01-01T00:00:00Z", status: "pending", input, model: params?.model ?? "auto", responseTime: 0.2 };
		},
		getResearch: async (requestId) => {
			globalThis.__lastTavilyCall = { opts, requestId };
			guard("getResearch");
			if (globalThis.__tavilyResearchIncomplete) {
				return { requestId, status: "running", responseTime: 0.1 };
			}
			return {
				requestId,
				createdAt: "2024-01-01T00:00:00Z",
				status: "completed",
				content: "Research body",
				sources: [
					{ title: "Src A", url: "https://src.test/a" },
					{ title: null, url: "https://src.test/b" },
				],
				responseTime: 1.2,
			};
		},
	};
}

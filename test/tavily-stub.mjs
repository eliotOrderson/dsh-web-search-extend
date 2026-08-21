// Mock of @tavily/core used only by the search() unit test (loaded via loader hook).
export class TavilyKeylessLimitError extends Error {}

export function tavily(opts) {
	return {
		search: async (query, params) => {
			globalThis.__lastTavilyCall = { opts, query, params };
			if (globalThis.__tavilyThrow) {
				throw new Error(globalThis.__tavilyThrow);
			}
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
	};
}

/**
 * Adapter layer — Demo backend (example, no network). It exists to prove the
 * adapter layer is pluggable and not locked to Tavily: it implements the same
 * `SearchAdapter` interface and runs with zero configuration, so the full
 * stack can be exercised without any vendor key. Add a real provider by copying
 * this shape and calling `registry.register(yourAdapter)` in `apply`.
 * @module dsh-web-search-extend/adapters/demo
 */
import type { WebSearchResult } from "@deepseek-ai/dsh-web";
import { WebError } from "@deepseek-ai/dsh-web";
import type { AdapterRuntime, SearchAdapter } from "../types.js";

export const DemoAdapter: SearchAdapter = {
	id: "demo",
	label: "Demo (no network)",
	requiresApiKey: false,
	defaultApiKeyEnv: "DSH_WEB_SEARCH_DEMO_KEY",
	baseURLEnv: "DSH_WEB_SEARCH_DEMO_BASE_URL",
	defaultBaseURL: "https://example.invalid",
	available(): boolean {
		return true;
	},
	async search(request: Parameters<SearchAdapter["search"]>[0], runtime: AdapterRuntime, signal?: AbortSignal): Promise<WebSearchResult> {
		runtime.recordRequest?.({ endpoint: "demo://local", params: { query: request.query } });
		if (signal?.aborted === true) throw new WebError("Search aborted", "WEB_ABORTED", { cause: signal.reason });
		return {
			content: `Demo adapter echoed: ${request.query}`,
			sources: [
				{
					url: "https://example.com/demo/1",
					title: `Demo result for "${request.query}"`,
					snippet: "This source proves the adapter layer is pluggable and not locked to Tavily.",
					publishedAt: "2024-01-01",
				},
				{
					url: "https://example.com/demo/2",
					title: "Another demo source",
					snippet: "Implement SearchAdapter and register it to add a real backend (Brave, SerpAPI, Exa, …).",
				},
			],
			truncated: false,
		};
	},
};

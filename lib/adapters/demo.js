import { WebError } from "@deepseek-ai/dsh-web";
export const DemoAdapter = {
    id: "demo",
    label: "Demo (no network)",
    requiresApiKey: false,
    defaultApiKeyEnv: "DSH_WEB_SEARCH_DEMO_KEY",
    baseURLEnv: "DSH_WEB_SEARCH_DEMO_BASE_URL",
    defaultBaseURL: "https://example.invalid",
    available() {
        return true;
    },
    async search(request, runtime, signal) {
        runtime.recordRequest?.({ endpoint: "demo://local", params: { query: request.query } });
        if (signal?.aborted === true)
            throw new WebError("Search aborted", "WEB_ABORTED", { cause: signal.reason });
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
//# sourceMappingURL=demo.js.map
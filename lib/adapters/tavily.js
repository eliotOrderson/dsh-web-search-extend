/**
 * Adapter layer — Tavily backend. One file, one vendor. Owns the `@tavily/core`
 * call and the Tavily-response → `WebSearchResult` mapping, including keyless
 * mode (no API key, rate-limited) so the plugin works for quick tests without
 * a credential.
 * @module dsh-web-search-extend/adapters/tavily
 */
import { tavily, TavilyKeylessLimitError } from "@tavily/core";
import { WebError } from "@deepseek-ai/dsh-web";
import { TAVILY_DEFAULT_BASE_URL } from "../config.js";
/** Attribution sent to Tavily on every request. */
const CLIENT_NAME = "deepseek-harness";
/**
 * Map a Tavily Search response to the seam's normalized result. `answer`
 * (when requested) becomes `content`; `results[]` becomes `sources[]`, mapped
 * by URL and deduped. The seam enforces `maxResults`, so `truncated` is false.
 */
function mapTavilyResponse(response) {
    const seen = new Set();
    const sources = [];
    for (const item of response.results ?? []) {
        if (item.url == null || item.url.length === 0 || seen.has(item.url))
            continue;
        seen.add(item.url);
        sources.push({
            url: item.url,
            ...(item.title != null && item.title.length > 0 ? { title: item.title } : {}),
            // Tavily `content` is the short snippet / semantic chunks for the page.
            ...(item.content != null && item.content.length > 0 ? { snippet: item.content } : {}),
            ...(item.publishedDate != null && item.publishedDate.length > 0 ? { publishedAt: item.publishedDate } : {}),
        });
    }
    return {
        ...(response.answer != null && response.answer.length > 0 ? { content: response.answer } : {}),
        sources,
        truncated: false,
    };
}
export const TavilyAdapter = {
    id: "tavily",
    label: "Tavily",
    // Tavily exposes a keyless (rate-limited) mode, so a key is optional.
    requiresApiKey: false,
    defaultApiKeyEnv: "TAVILY_API_KEY",
    baseURLEnv: "TAVILY_BASE_URL",
    defaultBaseURL: TAVILY_DEFAULT_BASE_URL,
    available(runtime) {
        return URL.canParse(runtime.baseURL);
    },
    async search(request, runtime, signal) {
        const settings = runtime.settings;
        const client = tavily({
            apiKey: runtime.apiKey,
            apiBaseURL: runtime.baseURL,
            clientName: CLIENT_NAME,
        });
        const params = {
            searchDepth: (settings.searchDepth ?? "basic"),
            topic: (settings.topic ?? "general"),
            maxResults: request.maxResults ?? settings.maxResults ?? 5,
            includeAnswer: settings.includeAnswer ?? false,
            ...(settings.timeRange && settings.timeRange.length > 0
                ? { timeRange: settings.timeRange }
                : {}),
        };
        runtime.recordRequest?.({ endpoint: `${runtime.baseURL}/search`, params });
        if (signal?.aborted === true)
            throw new WebError("Search aborted", "WEB_ABORTED", { cause: signal.reason });
        try {
            const response = await client.search(request.query, params);
            return mapTavilyResponse(response);
        }
        catch (error) {
            if (error instanceof TavilyKeylessLimitError) {
                throw new WebError(`Tavily keyless rate limit reached: ${String(error)}. Set ${runtime.apiKeyEnv} for full access.`, "WEB_PROVIDER_ERROR", { cause: error });
            }
            throw error;
        }
    },
};
//# sourceMappingURL=tavily.js.map
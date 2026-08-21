/**
 * Adapter layer — DeepSeek backend. A faithful port of the official
 * `@deepseek-ai/dsh-web-search-deepseek` provider so that after replacing the
 * official plugin nothing is lost: it calls DeepSeek's Anthropic-compatible
 * Messages API with the native `web_search_20250305` server tool and maps the
 * structured `web_search_tool_result` blocks into `WebSearchResult`.
 * @module dsh-web-search-extend/adapters/deepseek
 */
import { WebError } from "@deepseek-ai/dsh-web";
import { isAbortError } from "../core/abort.js";
import { DEEPSEEK_API_KEY_ENV, DEEPSEEK_DEFAULT_API_VERSION, DEEPSEEK_DEFAULT_BASE_URL, DEEPSEEK_DEFAULT_MAX_TOKENS, DEEPSEEK_DEFAULT_MAX_USES, DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_SEARCH_BASE_URL_ENV, } from "../config.js";
/** Attribution header sent on every request. */
const USER_AGENT = "deepseek-harness/0.0.1";
/** Build a `url → cited_text` map from every `text` block's `citations[]`. */
function citationSnippets(blocks) {
    const map = new Map();
    for (const block of blocks) {
        if (block.type !== "text")
            continue;
        for (const cite of block.citations ?? []) {
            if (cite.url != null && cite.url.length > 0 && cite.cited_text != null && cite.cited_text.length > 0 && !map.has(cite.url)) {
                map.set(cite.url, cite.cited_text);
            }
        }
    }
    return map;
}
/**
 * Map a DeepSeek Messages response to a normalized result: walk
 * `web_search_tool_result` blocks, join citation excerpts as snippets, dedupe
 * by URL. Throws `WEB_PROVIDER_ERROR` when native search produced no result
 * block (strict mode, mirroring the official provider).
 */
function mapDeepSeekResponse(response) {
    const blocks = response?.content ?? [];
    const resultBlocks = blocks.filter((block) => block.type === "web_search_tool_result");
    if (resultBlocks.length === 0) {
        throw new WebError("DeepSeek returned no web_search_tool_result blocks; the request may not have triggered native web search", "WEB_PROVIDER_ERROR");
    }
    const snippets = citationSnippets(blocks);
    const seen = new Set();
    const sources = [];
    for (const block of resultBlocks) {
        for (const item of block.content ?? []) {
            if (item.type !== "web_search_result" || item.url == null || item.url.length === 0 || seen.has(item.url))
                continue;
            seen.add(item.url);
            const snippet = snippets.get(item.url);
            sources.push({
                url: item.url,
                ...(item.title != null && item.title.length > 0 ? { title: item.title } : {}),
                ...(snippet != null && snippet.length > 0 ? { snippet } : {}),
                ...(item.page_age != null && item.page_age.length > 0 ? { publishedAt: item.page_age } : {}),
            });
        }
    }
    return { sources, truncated: false };
}
export const DeepSeekAdapter = {
    id: "deepseek",
    label: "DeepSeek (official API)",
    requiresApiKey: true,
    defaultApiKeyEnv: DEEPSEEK_API_KEY_ENV,
    baseURLEnv: DEEPSEEK_SEARCH_BASE_URL_ENV,
    defaultBaseURL: DEEPSEEK_DEFAULT_BASE_URL,
    available(runtime) {
        return URL.canParse(runtime.baseURL);
    },
    async search(request, runtime, signal) {
        if (runtime.apiKey == null || runtime.apiKey.length === 0) {
            throw new WebError(`DeepSeek search has no API key for "${runtime.apiKeyEnv}"`, "WEB_PROVIDER_CREDENTIAL_MISSING");
        }
        const settings = runtime.settings;
        const endpoint = `${runtime.baseURL}/messages`;
        const body = {
            model: settings.model ?? DEEPSEEK_DEFAULT_MODEL,
            max_tokens: settings.maxTokens ?? DEEPSEEK_DEFAULT_MAX_TOKENS,
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: `Perform a web search for the query: ${request.query}` }],
                },
            ],
            tools: [{ type: "web_search_20250305", name: "web_search", max_uses: settings.maxUses ?? DEEPSEEK_DEFAULT_MAX_USES }],
        };
        runtime.recordRequest?.({ endpoint, params: { apiVersion: settings.apiVersion ?? DEEPSEEK_DEFAULT_API_VERSION, body } });
        if (signal?.aborted === true)
            throw new WebError("Search aborted", "WEB_ABORTED", { cause: signal.reason });
        let response;
        try {
            response = await fetch(endpoint, {
                method: "POST",
                redirect: "error",
                headers: {
                    "x-api-key": runtime.apiKey,
                    authorization: `Bearer ${runtime.apiKey}`,
                    "anthropic-version": settings.apiVersion ?? DEEPSEEK_DEFAULT_API_VERSION,
                    "content-type": "application/json",
                    accept: "application/json",
                    "user-agent": USER_AGENT,
                },
                body: JSON.stringify(body),
                ...signal !== undefined ? { signal } : {},
            });
        }
        catch (error) {
            if (isAbortError(error)) {
                throw new WebError("Search aborted", "WEB_ABORTED", { cause: error });
            }
            throw new WebError(`DeepSeek search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
        }
        if (!response.ok) {
            let message = `DeepSeek API error (HTTP ${response.status})`;
            try {
                const parsed = await response.json();
                const detail = typeof parsed?.error === "string" ? parsed.error : parsed?.error?.message ?? parsed?.message;
                if (detail != null && detail.length > 0)
                    message = detail;
            }
            catch {
                /* non-JSON error body */
            }
            throw new WebError(message, "WEB_PROVIDER_ERROR");
        }
        try {
            return mapDeepSeekResponse(await response.json());
        }
        catch (error) {
            if (error instanceof WebError)
                throw error;
            throw new WebError(`DeepSeek returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
        }
    },
};
//# sourceMappingURL=deepseek.js.map
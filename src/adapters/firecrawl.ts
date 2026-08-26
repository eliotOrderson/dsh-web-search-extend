/**
 * Adapter layer — Firecrawl keyless backend. Talks to the hosted Firecrawl v2
 * search endpoint through the official `firecrawl` SDK, which serves an
 * unauthenticated keyless tier (free monthly credits capped per IP); a resolved
 * `fc-` key upgrades the quota and is then sent as a Bearer token by the SDK.
 * Search-only by design: the keyless REST surface also exposes /scrape, but
 * routing extract through it would burn the same shared monthly credits —
 * single-page fetch stays on the composite tier (zero quota), so it keeps
 * working even after search credits run out.
 * @module dsh-web-search-extend/adapters/firecrawl
 */
import { Firecrawl, SdkError, type Document, type SearchData, type SearchResultWeb } from "firecrawl";
import { WebError, type WebSearchResult, type WebSearchSource } from "@deepseek-ai/dsh-web";
import type { AdapterRuntime, SearchAdapter } from "../types.js";
import { FIRECRAWL_API_KEY_ENV, FIRECRAWL_BASE_URL_ENV, FIRECRAWL_DEFAULT_BASE_URL } from "../config.js";

/** Result cap when the request carries none (matches the tavily default). */
const DEFAULT_MAX_RESULTS = 5;

/** Firecrawl keys are `fc-`-prefixed; any other non-empty value is a mis-stored ref. */
const KEY_SHAPE = /^fc-/;

/** One web hit in the Firecrawl v2 search response. */
type FirecrawlSearchHit = SearchResultWeb | Document;

/** True for the plain search-result shape; false means a scraped Document. */
function isSearchResultWeb(item: FirecrawlSearchHit): item is SearchResultWeb {
	return "url" in item;
}

/** Map a v2 search response to the seam's normalized result (deduped by URL). */
function mapFirecrawlResponse(response: SearchData): WebSearchResult {
	const seen = new Set<string>();
	const sources: WebSearchSource[] = [];
	for (const item of response.web ?? []) {
		const url = isSearchResultWeb(item) ? item.url : item.metadata?.sourceURL ?? item.metadata?.url;
		if (url == null || url.length === 0 || seen.has(url)) continue;
		seen.add(url);
		const title = isSearchResultWeb(item) ? item.title : item.metadata?.title ?? item.metadata?.ogTitle;
		const description = isSearchResultWeb(item) ? item.description : item.metadata?.description ?? item.metadata?.ogDescription;
		sources.push({
			url,
			...(title != null && title.length > 0 ? { title } : {}),
			...(description != null && description.length > 0 ? { snippet: description } : {}),
		});
	}
	return { sources, truncated: false };
}

/** Map SDK errors to seam errors; 402/429 keep their actionable messages. */
function normalizeFirecrawlError(error: unknown, runtime: AdapterRuntime): unknown {
	if (error instanceof SdkError) {
		if (error.status === 402) {
			return new WebError(
				`Firecrawl keyless monthly credit quota exhausted: ${error.message}. Set ${runtime.apiKeyEnv ?? FIRECRAWL_API_KEY_ENV} or wait for the monthly reset.`,
				"WEB_PROVIDER_ERROR",
				{ cause: error },
			);
		}
		if (error.status === 429) {
			return new WebError(`Firecrawl rate limit exceeded: ${error.message}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		return new WebError(`Firecrawl API error: ${error.message} (HTTP ${error.status ?? "unknown"})`, "WEB_PROVIDER_ERROR", { cause: error });
	}
	return new WebError(`Firecrawl search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
}

export const FirecrawlKeylessAdapter: SearchAdapter = {
	id: "firecrawl-keyless",
	label: "Firecrawl (keyless)",
	// The keyless tier needs no key at all; a configured one only upgrades quota.
	requiresApiKey: false,
	defaultApiKeyEnv: FIRECRAWL_API_KEY_ENV,
	baseURLEnv: FIRECRAWL_BASE_URL_ENV,
	defaultBaseURL: FIRECRAWL_DEFAULT_BASE_URL,
	available(runtime: AdapterRuntime): boolean {
		if (!URL.canParse(runtime.baseURL)) return false;
		const key = runtime.apiKey?.trim();
		// Keyless runs with no key; a present-but-malformed key means a mis-stored
		// ref - fail availability loudly instead of confusing auth errors later.
		return key === undefined || key.length === 0 || KEY_SHAPE.test(key);
	},
	async search(request: Parameters<SearchAdapter["search"]>[0], runtime: AdapterRuntime, signal?: AbortSignal): Promise<WebSearchResult> {
		const limit = request.maxResults ?? DEFAULT_MAX_RESULTS;
		runtime.recordRequest?.({ endpoint: `${runtime.baseURL}/v2/search`, params: { query: request.query, limit } });
		if (signal?.aborted === true) throw new WebError("Search aborted", "WEB_ABORTED", { cause: signal.reason });
		const client = new Firecrawl({ apiKey: runtime.apiKey ?? undefined, apiUrl: runtime.baseURL });
		try {
			return mapFirecrawlResponse(await client.search(request.query, { limit }));
		} catch (error) {
			throw normalizeFirecrawlError(error, runtime);
		}
	},
};

/**
 * Adapter layer — Tavily backend. One file, one vendor. Owns the `@tavily/core`
 * call and the Tavily-response → `WebSearchResult` mapping, including keyless
 * mode (no API key, rate-limited) so the plugin works for quick tests without
 * a credential.
 * @module dsh-web-search-extend/adapters/tavily
 */
import {
	tavily,
	TavilyKeylessLimitError,
	type TavilyCrawlOptions,
	type TavilyCrawlResponse,
	type TavilyExtractOptions,
	type TavilyExtractResponse,
	type TavilyGetResearchResponse,
	type TavilyMapOptions,
	type TavilyMapResponse,
	type TavilyResearchOptions,
	type TavilyResearchResponse,
	type TavilySearchOptions,
	type TavilySearchResponse,
} from "@tavily/core";
import { WebError, type WebSearchResult, type WebSearchSource } from "@deepseek-ai/dsh-web";
import type {
	AdapterRuntime,
	CrawlRequest,
	CrawlResult,
	ExtractRequest,
	ExtractResult,
	MapRequest,
	MapResult,
	ResearchPhase,
	ResearchStatus,
	ResearchSubmission,
	SearchAdapter,
} from "../types.js";
import { TAVILY_DEFAULT_BASE_URL } from "../config.js";

/** Tavily-specific settings read from `config.tavily`. */
interface TavilySettings {
	searchDepth?: string;
	topic?: string;
	maxResults?: number;
	includeAnswer?: boolean;
	timeRange?: string;
	extractDepth?: string;
	researchModel?: string;
}

/** Attribution sent to Tavily on every request. */
const CLIENT_NAME = "deepseek-harness";

function clientFor(runtime: AdapterRuntime) {
	return tavily({
		apiKey: runtime.apiKey,
		apiBaseURL: runtime.baseURL,
		clientName: CLIENT_NAME,
	});
}

/** Pre-dispatch cancellation check, identical shape to the provider's own. */
function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted === true) throw new WebError("Search aborted", "WEB_ABORTED", { cause: signal.reason });
}

/** Keyless mode covers search ONLY: every other endpoint rejects without a key. */
function normalizeTavilyError(error: unknown, runtime: AdapterRuntime): unknown {
	if (error instanceof TavilyKeylessLimitError) {
		return new WebError(
			`Tavily keyless rate limit reached: ${String(error)}. Set ${runtime.apiKeyEnv} for full access.`,
			"WEB_PROVIDER_ERROR",
			{ cause: error },
		);
	}
	return error;
}

/** Vendor status strings outside the closed union collapse to `unknown`, never invented states. */
function researchPhase(status: string): ResearchPhase {
	return status === "pending" || status === "completed" || status === "failed" ? status : "unknown";
}

/**
 * Map a Tavily Search response to the seam's normalized result. `answer`
 * (when requested) becomes `content`; `results[]` becomes `sources[]`, mapped
 * by URL and deduped. The seam enforces `maxResults`, so `truncated` is false.
 */
function mapTavilyResponse(response: TavilySearchResponse): WebSearchResult {
	const seen = new Set<string>();
	const sources: WebSearchSource[] = [];
	for (const item of response.results ?? []) {
		if (item.url == null || item.url.length === 0 || seen.has(item.url)) continue;
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

export const TavilyAdapter: SearchAdapter = {
	id: "tavily",
	label: "Tavily",
	// Tavily exposes a keyless (rate-limited) mode, so a key is optional.
	requiresApiKey: false,
	defaultApiKeyEnv: "TAVILY_API_KEY",
	baseURLEnv: "TAVILY_BASE_URL",
	defaultBaseURL: TAVILY_DEFAULT_BASE_URL,
	available(runtime: AdapterRuntime): boolean {
		return URL.canParse(runtime.baseURL);
	},
	async search(request: Parameters<SearchAdapter["search"]>[0], runtime: AdapterRuntime, signal?: AbortSignal): Promise<WebSearchResult> {
		const settings = runtime.settings as TavilySettings;
		const client = clientFor(runtime);
		const params: TavilySearchOptions = {
			searchDepth: (settings.searchDepth ?? "basic") as TavilySearchOptions["searchDepth"],
			topic: (settings.topic ?? "general") as TavilySearchOptions["topic"],
			maxResults: request.maxResults ?? settings.maxResults ?? 5,
			includeAnswer: settings.includeAnswer ?? false,
			...(settings.timeRange && settings.timeRange.length > 0
				? { timeRange: settings.timeRange as TavilySearchOptions["timeRange"] }
				: {}),
		};
		runtime.recordRequest?.({ endpoint: `${runtime.baseURL}/search`, params });
		throwIfAborted(signal);
		try {
			return mapTavilyResponse(await client.search(request.query, params));
		} catch (error) {
			throw normalizeTavilyError(error, runtime);
		}
	},

	async extract(request: ExtractRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<ExtractResult> {
		const settings = runtime.settings as TavilySettings;
		const client = clientFor(runtime);
		const params: TavilyExtractOptions = {
			extractDepth: (settings.extractDepth ?? "basic") as TavilyExtractOptions["extractDepth"],
			format: request.format ?? "markdown",
			...(request.query !== undefined ? { query: request.query } : {}),
		};
		runtime.recordRequest?.({ endpoint: `${runtime.baseURL}/extract`, params: { urls: [...request.urls], ...params } });
		throwIfAborted(signal);
		try {
			const response: TavilyExtractResponse = await client.extract([...request.urls], params);
			const pages = [
				...response.results.map((result) => ({
					url: result.url,
					...(result.title != null && result.title.length > 0 ? { title: result.title } : {}),
					content: result.rawContent,
				})),
				// A failed URL is a page-level outcome, not an operation failure.
				...response.failedResults.map((failed) => ({ url: failed.url, failureReason: failed.error })),
			];
			return { pages, truncated: false };
		} catch (error) {
			throw normalizeTavilyError(error, runtime);
		}
	},

	async crawl(request: CrawlRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<CrawlResult> {
		const settings = runtime.settings as TavilySettings;
		const client = clientFor(runtime);
		const params: TavilyCrawlOptions = {
			...(request.maxPages !== undefined ? { limit: request.maxPages } : {}),
			extractDepth: (settings.extractDepth ?? "basic") as TavilyCrawlOptions["extractDepth"],
			format: "markdown",
			allowExternal: false,
			...(request.includeDomains !== undefined ? { selectDomains: [...request.includeDomains] } : {}),
			...(request.excludeDomains !== undefined ? { excludeDomains: [...request.excludeDomains] } : {}),
		};
		runtime.recordRequest?.({ endpoint: `${runtime.baseURL}/crawl`, params: { url: request.url, ...params } });
		throwIfAborted(signal);
		try {
			const response: TavilyCrawlResponse = await client.crawl(request.url, params);
			const pages = response.results.map((result) => ({ url: result.url, content: result.rawContent }));
			return { pages, truncated: false };
		} catch (error) {
			throw normalizeTavilyError(error, runtime);
		}
	},

	async map(request: MapRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<MapResult> {
		const client = clientFor(runtime);
		const params: TavilyMapOptions = {
			...(request.maxUrls !== undefined ? { limit: request.maxUrls } : {}),
		};
		runtime.recordRequest?.({ endpoint: `${runtime.baseURL}/map`, params: { url: request.url, ...params } });
		throwIfAborted(signal);
		try {
			const response: TavilyMapResponse = await client.map(request.url, params);
			const seen = new Set<string>();
			const urls: string[] = [];
			for (const url of response.results) {
				if (seen.has(url)) continue;
				seen.add(url);
				urls.push(url);
			}
			return { urls, truncated: false };
		} catch (error) {
			throw normalizeTavilyError(error, runtime);
		}
	},

	async submitResearch(input: string, runtime: AdapterRuntime, signal?: AbortSignal): Promise<ResearchSubmission> {
		const settings = runtime.settings as TavilySettings;
		const client = clientFor(runtime);
		const params: TavilyResearchOptions = {
			model: (settings.researchModel ?? "auto") as TavilyResearchOptions["model"],
		};
		runtime.recordRequest?.({ endpoint: `${runtime.baseURL}/research`, params: { input, ...params } });
		throwIfAborted(signal);
		try {
			// stream is never set, so the AsyncGenerator arm of the return type cannot occur.
			const response = (await client.research(input, params)) as TavilyResearchResponse;
			return { requestId: response.requestId, status: researchPhase(response.status) };
		} catch (error) {
			throw normalizeTavilyError(error, runtime);
		}
	},

	async pollResearch(requestId: string, runtime: AdapterRuntime, signal?: AbortSignal): Promise<ResearchStatus> {
		const client = clientFor(runtime);
		throwIfAborted(signal);
		try {
			const response = await client.getResearch(requestId);
			const complete = response as TavilyGetResearchResponse;
			const sources = Array.isArray(complete.sources)
				? complete.sources
						.filter((source) => source.url != null && source.url.length > 0)
						.map((source) => ({
							url: source.url,
							...(source.title != null && source.title.length > 0 ? { title: source.title } : {}),
						}))
				: [];
			return {
				requestId: complete.requestId,
				status: researchPhase(complete.status),
				...(typeof complete.content === "string"
					? { content: complete.content }
					: complete.content != null
						? { content: JSON.stringify(complete.content) }
						: {}),
				...(sources.length > 0 ? { sources } : {}),
			};
		} catch (error) {
			throw normalizeTavilyError(error, runtime);
		}
	},
};

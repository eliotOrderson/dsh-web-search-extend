/**
 * Adapter layer — Firecrawl backend. Talks to the hosted Firecrawl v2 API
 * through the official `firecrawl` SDK, which serves an unauthenticated
 * keyless tier (free monthly credits capped per IP); a resolved `fc-` key
 * upgrades the quota and is then sent as a Bearer token by the SDK.
 * Search, scrape, crawl, map, and agent research are native; they consume the
 * shared monthly credits, so an exhausted keyless quota surfaces HTTP 402.
 * @module dsh-web-search-extend/adapters/firecrawl
 */
import { Firecrawl, SdkError, type AgentResponse, type AgentStatusResponse, type CrawlOptions, type Document, type MapData, type MapOptions, type ScrapeOptions, type SearchData, type SearchResultWeb } from "firecrawl";
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
import { FIRECRAWL_API_KEY_ENV, FIRECRAWL_BASE_URL_ENV, FIRECRAWL_DEFAULT_BASE_URL } from "../config.js";

/** Result cap when the request carries none (matches the tavily default). */
const DEFAULT_MAX_RESULTS = 5;

/** Firecrawl keys are `fc-`-prefixed; any other non-empty value is a mis-stored ref. */
const KEY_SHAPE = /^fc-/;

/** Markdown is the closest Firecrawl format to the seam's readable content. */
const SCRAPE_OPTIONS: ScrapeOptions = { formats: ["markdown"] };

/** Structured agent output kept as the default so reports carry analysis and recommendations, not just bullets. */
const DEFAULT_AGENT_SCHEMA = {
	type: "object",
	properties: {
		summary: { type: "string", description: "executive summary of the research" },
		analysis: { type: "string", description: "detailed analysis with evidence" },
		sources: { type: "array", items: { type: "string" }, description: "source URLs used" },
		recommendations: { type: "array", items: { type: "string" }, description: "actionable recommendations" },
	},
	required: ["summary", "analysis", "sources", "recommendations"],
} as const;

/** One web hit in the Firecrawl v2 search response. */
type FirecrawlSearchHit = SearchResultWeb | Document;

/** True for the plain search-result shape; false means a scraped Document. */
function isSearchResultWeb(item: FirecrawlSearchHit): item is SearchResultWeb {
	return "url" in item;
}

function clientFor(runtime: AdapterRuntime): Firecrawl {
	return new Firecrawl({ apiKey: runtime.apiKey ?? undefined, apiUrl: runtime.baseURL });
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted === true) throw new WebError("Search aborted", "WEB_ABORTED", { cause: signal.reason });
}

function documentUrl(document: Document): string | undefined {
	return document.metadata?.sourceURL ?? document.metadata?.url ?? document.metadata?.ogUrl;
}

function documentTitle(document: Document): string | undefined {
	return document.metadata?.title ?? document.metadata?.ogTitle;
}

function documentContent(document: Document): string | undefined {
	return document.markdown ?? document.html ?? document.rawHtml;
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

/** Map a scraped Document to the seam's page shape. */
function mapDocument(document: Document, fallbackUrl: string): ExtractResult["pages"][number] {
	const url = documentUrl(document) ?? fallbackUrl;
	const title = documentTitle(document);
	const content = documentContent(document);
	return {
		url,
		...(title != null && title.length > 0 ? { title } : {}),
		...(content != null && content.length > 0 ? { content } : {}),
	};
}

/** Vendor status strings outside the closed union collapse to `unknown`. */
function agentPhase(status: AgentStatusResponse["status"]): ResearchPhase {
	return status === "processing" || status === "completed" || status === "failed" ? (status === "processing" ? "pending" : status) : "unknown";
}

/** Recursively collect URL strings from an agent payload. */
function collectAgentUrls(value: unknown, out: string[]): void {
	if (typeof value === "string") {
		if (value.length > 0 && /^https?:\/\//i.test(value)) out.push(value);
		return;
	}
	if (!Array.isArray(value) && typeof value !== "object") return;
	if (value === null) return;
	if (Array.isArray(value)) {
		for (const item of value) collectAgentUrls(item, out);
		return;
	}
	for (const key of Object.keys(value as Record<string, unknown>)) {
		if (key.toLowerCase() === "url") {
			const candidate = (value as Record<string, unknown>)[key];
			if (typeof candidate === "string" && candidate.length > 0 && /^https?:\/\//i.test(candidate)) out.push(candidate);
		}
		collectAgentUrls((value as Record<string, unknown>)[key], out);
	}
}

/** Map Firecrawl agent output to the seam's research status shape. */
function mapAgentStatus(response: AgentStatusResponse): ResearchStatus {
	const raw = response.data;
	const resultText = raw !== null && typeof raw === "object" && typeof (raw as { result?: unknown }).result === "string"
		? (raw as { result: string }).result
		: undefined;
	const content = typeof raw === "string"
		? raw
		: resultText !== undefined && resultText.length > 0
			? resultText
			: raw !== undefined
				? JSON.stringify(raw)
				: undefined;
	const sources: string[] = [];
	collectAgentUrls(response.data, sources);
	const seen = new Set<string>();
	const uniqueSources = sources.filter((url) => {
		if (seen.has(url)) return false;
		seen.add(url);
		return true;
	});
	return {
		requestId: "agent",
		status: agentPhase(response.status),
		...(content !== undefined && content.length > 0 ? { content } : {}),
		...(uniqueSources.length > 0 ? { sources: uniqueSources.map((url) => ({ url })) } : {}),
	};
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
		if (error.status === 401 && (runtime.apiKey === undefined || runtime.apiKey.length === 0)) {
			return new WebError(
				`Firecrawl agent research is not available on the keyless free tier: ${error.message}. Set ${runtime.apiKeyEnv ?? FIRECRAWL_API_KEY_ENV} to a Firecrawl API key.`,
				"WEB_PROVIDER_ERROR",
				{ cause: error },
			);
		}
		return new WebError(`Firecrawl API error: ${error.message} (HTTP ${error.status ?? "unknown"})`, "WEB_PROVIDER_ERROR", { cause: error });
	}
	return new WebError(`Firecrawl request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
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
		throwIfAborted(signal);
		const client = clientFor(runtime);
		try {
			return mapFirecrawlResponse(await client.search(request.query, { limit }));
		} catch (error) {
			throw normalizeFirecrawlError(error, runtime);
		}
	},
	async extract(request: ExtractRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<ExtractResult> {
		runtime.recordRequest?.({ endpoint: `${runtime.baseURL}/v2/scrape`, params: { urls: [...request.urls], format: request.format ?? "markdown" } });
		throwIfAborted(signal);
		const client = clientFor(runtime);
		const pages = await Promise.all(
			request.urls.map(async (url) => {
				try {
					return mapDocument(await client.scrape(url, SCRAPE_OPTIONS), url);
				} catch (error) {
					return { url, failureReason: error instanceof Error ? error.message : String(error) };
				}
			}),
		);
		return { pages, truncated: false };
	},
	async crawl(request: CrawlRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<CrawlResult> {
		const options: CrawlOptions = {
			...(request.maxPages !== undefined ? { limit: request.maxPages } : {}),
			scrapeOptions: SCRAPE_OPTIONS,
		};
		runtime.recordRequest?.({ endpoint: `${runtime.baseURL}/v2/crawl`, params: { url: request.url, ...options } });
		throwIfAborted(signal);
		const client = clientFor(runtime);
		try {
			const job = await client.crawl(request.url, { ...options, pollInterval: 2, timeout: 60 });
			const pages = job.data.map((document) => mapDocument(document, request.url));
			return { pages, truncated: false };
		} catch (error) {
			throw normalizeFirecrawlError(error, runtime);
		}
	},
	async map(request: MapRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<MapResult> {
		const options: MapOptions = {
			...(request.maxUrls !== undefined ? { limit: request.maxUrls } : {}),
		};
		runtime.recordRequest?.({ endpoint: `${runtime.baseURL}/v2/map`, params: { url: request.url, ...options } });
		throwIfAborted(signal);
		const client = clientFor(runtime);
		try {
			const data: MapData = await client.map(request.url, options);
			const seen = new Set<string>();
			const urls: string[] = [];
			for (const link of data.links) {
				if (link.url == null || link.url.length === 0 || seen.has(link.url)) continue;
				seen.add(link.url);
				urls.push(link.url);
			}
			return { urls, truncated: false };
		} catch (error) {
			throw normalizeFirecrawlError(error, runtime);
		}
	},

	async submitResearch(input: string, runtime: AdapterRuntime, signal?: AbortSignal): Promise<ResearchSubmission> {
		runtime.recordRequest?.({ endpoint: `${runtime.baseURL}/v2/agent`, params: { prompt: input, schema: DEFAULT_AGENT_SCHEMA } });
		throwIfAborted(signal);
		const client = clientFor(runtime);
		try {
			const response: AgentResponse = await client.startAgent({ prompt: input, schema: DEFAULT_AGENT_SCHEMA });
			if (response.id == null || response.id.length === 0) {
				throw new WebError(
					`Firecrawl agent returned no job id${response.error !== undefined ? `: ${response.error}` : ""}`,
					"WEB_PROVIDER_ERROR",
				);
			}
			return { requestId: response.id, status: "pending" };
		} catch (error) {
			throw normalizeFirecrawlError(error, runtime);
		}
	},

	async pollResearch(requestId: string, runtime: AdapterRuntime, signal?: AbortSignal): Promise<ResearchStatus> {
		runtime.recordRequest?.({ endpoint: `${runtime.baseURL}/v2/agent/${requestId}`, params: {} });
		throwIfAborted(signal);
		const client = clientFor(runtime);
		try {
			const response: AgentStatusResponse = await client.getAgentStatus(requestId);
			return { ...mapAgentStatus(response), requestId };
		} catch (error) {
			throw normalizeFirecrawlError(error, runtime);
		}
	},
};
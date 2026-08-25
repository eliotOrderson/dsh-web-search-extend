/**
 * Contract layer for the extensible web-search plugin.
 *
 * These interfaces are the only thing the core (seam integration) and the
 * adapter layer agree on. An adapter owns one backend; the core owns the
 * harness seam, credentials, cancellation, and the WebError taxonomy. Neither
 * side imports the other's internals — they meet here.
 * @module dsh-web-search-extend/types
 */
import type {
	WebFetchResult,
	WebSearchRequest,
	WebSearchResult,
	WebSearchSource,
} from "@deepseek-ai/dsh-web";

/**
 * Resolved, per-search context the core hands to an adapter. The core has
 * already projected configuration, credentials, and the abort/request hooks;
 * the adapter only needs to call its backend and return the normalized result.
 */
export interface AdapterRuntime {
	/** Resolved API key, or `undefined` when the adapter runs keyless. */
	readonly apiKey?: string;
	/** Credential reference name that was resolved (for diagnostics). */
	readonly apiKeyEnv: string;
	/** Backend host root (the adapter appends its own path, e.g. `/search`). */
	readonly baseURL: string;
	/** Adapter-specific settings (the `config[provider]` subsection). */
	readonly settings: Record<string, unknown>;
	/** Secret-free pre-dispatch log hook into the initiating Agent session. */
	readonly recordRequest?: (request: { endpoint: string; params: unknown }) => void;
}

/** The operations the plugin can route to an adapter or composite. */
export type WebOperation = "search" | "extract" | "crawl" | "map" | "research";

export interface ExtractRequest {
	readonly urls: readonly string[];
	/** Guided-extraction hint; honored natively by Tavily, ignored by the composite. */
	readonly query?: string;
	readonly format?: "markdown" | "text";
}

export interface ExtractedPage {
	readonly url: string;
	readonly title?: string;
	/** Readable content in the requested format. */
	readonly content?: string;
	/** Per-URL failure reason; a page-level failure is not a tool failure. */
	readonly failureReason?: string;
}

/** Shared by extract and crawl: a list of fetched-and-readable pages. */
export interface PageResult {
	readonly pages: readonly ExtractedPage[];
	readonly truncated: boolean;
}
export type ExtractResult = PageResult;
export type CrawlResult = PageResult;

export interface CrawlRequest {
	readonly url: string;
	readonly maxPages?: number;
	readonly includeDomains?: readonly string[];
	readonly excludeDomains?: readonly string[];
}

export interface MapRequest {
	readonly url: string;
	readonly maxUrls?: number;
}

export interface MapResult {
	readonly urls: readonly string[];
	readonly truncated: boolean;
}

/** research is a submit/poll protocol (the Tavily API is asynchronous). */
export type ResearchPhase = "pending" | "completed" | "failed" | "unknown";

export interface ResearchSubmission {
	readonly requestId: string;
	readonly status: ResearchPhase;
}

export interface ResearchStatus {
	readonly requestId: string;
	readonly status: ResearchPhase;
	readonly content?: string;
	readonly sources?: readonly WebSearchSource[];
}

/** Terminal phases; consumers branch on this predicate instead of a redundant flag. */
export function isResearchComplete(status: ResearchPhase): boolean {
	return status === "completed" || status === "failed";
}

/**
 * The fetch seam composites are allowed to see. Composites receive this as a
 * parameter instead of importing `ctx` or reaching the seam global, so they
 * stay pure algorithms runnable against any fetch backend — including a
 * recorded stub in tests.
 */
export type FetchLike = (request: { url: string }, signal?: AbortSignal) => Promise<WebFetchResult>;

/** Knobs shared by the composite tier; the router resolves spec-s10 defaults. */
export interface CompositeLimits {
	readonly extractMaxUrls: number;
	readonly crawlMaxPages: number;
	readonly mapMaxUrls: number;
	readonly perPageChars: number;
}

/**
 * A pluggable web backend. One adapter = one vendor/endpoint. It owns its
 * HTTP/SDK call AND its response → seam-normalized results, so adding a new
 * provider means adding one file that implements this interface — the core
 * never changes. Optional methods express vendor depth; capability derives
 * from method presence, never from a separately declared list that could drift.
 */
export interface WebAdapter {
	/** Stable id; also becomes the registered `ctx.web` provider id. */
	readonly id: string;
	/** Human-readable label for logs/UI. */
	readonly label: string;
	/** Whether the backend refuses to run without an API key. */
	readonly requiresApiKey: boolean;
	/** Default credential-reference env name when config does not override. */
	readonly defaultApiKeyEnv: string;
	/** Env name carrying the backend base URL. */
	readonly baseURLEnv: string;
	/** Default backend host root. */
	readonly defaultBaseURL: string;
	/** Cheap, synchronous usability check (no network). */
	available(runtime: AdapterRuntime): boolean;
	/** Run one search and return the seam-normalized result. */
	search(request: WebSearchRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<WebSearchResult>;
	/** Fetch pages and return their readable content (native when present). */
	extract?(request: ExtractRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<ExtractResult>;
	/** Crawl pages breadth-first from one URL (native when present). */
	crawl?(request: CrawlRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<CrawlResult>;
	/** Enumerate site URLs (native when present). */
	map?(request: MapRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<MapResult>;
	/** Submit one asynchronous research task; poll with `pollResearch`. */
	submitResearch?(input: string, runtime: AdapterRuntime, signal?: AbortSignal): Promise<ResearchSubmission>;
	/** Poll one submitted research task until a terminal phase. */
	pollResearch?(requestId: string, runtime: AdapterRuntime, signal?: AbortSignal): Promise<ResearchStatus>;
}

/** Pre-v2 alias; existing adapters and the registry keep compiling unchanged. */
export type SearchAdapter = WebAdapter;

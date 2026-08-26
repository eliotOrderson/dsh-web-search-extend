/**
 * Adapter layer — Firecrawl keyless backend. Talks to the hosted Firecrawl v2
 * search endpoint, which serves an unauthenticated keyless tier (free monthly
 * credits capped per IP); a resolved `fc-` key upgrades the quota and is then
 * sent as a Bearer token. Search-only by design: the keyless REST surface also
 * exposes /scrape, but routing extract through it would burn the same shared
 * monthly credits — single-page fetch stays on the composite tier (zero
 * quota), so it keeps working even after search credits run out.
 * @module dsh-web-search-extend/adapters/firecrawl
 */
import { WebError, type WebSearchResult, type WebSearchSource } from "@deepseek-ai/dsh-web";
import type { AdapterRuntime, SearchAdapter } from "../types.js";
import { isAbortError } from "../core/abort.js";
import { FIRECRAWL_API_KEY_ENV, FIRECRAWL_BASE_URL_ENV, FIRECRAWL_DEFAULT_BASE_URL } from "../config.js";

/** Attribution sent on every request. */
const USER_AGENT = "deepseek-harness";

/** Result cap when the request carries none (matches the tavily default). */
const DEFAULT_MAX_RESULTS = 5;

/** Firecrawl keys are `fc-`-prefixed; any other non-empty value is a mis-stored ref. */
const KEY_SHAPE = /^fc-/;

/** One web hit in the Firecrawl v2 search response. */
interface FirecrawlSearchHit {
	url?: string;
	title?: string;
	description?: string;
}

/** Firecrawl v2 search response envelope (`data.web` for the default source set). */
interface FirecrawlSearchResponse {
	success?: boolean;
	error?: string;
	data?: { web?: FirecrawlSearchHit[] };
}

/** Map a v2 search response to the seam's normalized result (deduped by URL). */
function mapFirecrawlResponse(response: FirecrawlSearchResponse): WebSearchResult {
	const seen = new Set<string>();
	const sources: WebSearchSource[] = [];
	for (const hit of response.data?.web ?? []) {
		if (hit.url == null || hit.url.length === 0 || seen.has(hit.url)) continue;
		seen.add(hit.url);
		sources.push({
			url: hit.url,
			...(hit.title != null && hit.title.length > 0 ? { title: hit.title } : {}),
			...(hit.description != null && hit.description.length > 0 ? { snippet: hit.description } : {}),
		});
	}
	return { sources, truncated: false };
}

/** Prefer the server's error text; fall back to a status line for non-JSON bodies. */
async function errorDetail(response: Response): Promise<string> {
	try {
		const parsed = await response.json();
		if (typeof parsed?.error === "string" && parsed.error.length > 0) return parsed.error;
	} catch {
		/* non-JSON error body */
	}
	return `Firecrawl API error (HTTP ${response.status})`;
}

/** Quota/rate-limit statuses get actionable messages; everything else passes through. */
function httpErrorMessage(status: number, detail: string): string {
	if (status === 402) {
		return `Firecrawl keyless monthly credit quota exhausted: ${detail}. Set ${FIRECRAWL_API_KEY_ENV} or wait for the monthly reset.`;
	}
	if (status === 429) return `Firecrawl rate limit exceeded: ${detail}`;
	return `${detail} (HTTP ${status})`;
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
		const endpoint = `${runtime.baseURL}/v2/search`;
		const body = { query: request.query, limit: request.maxResults ?? DEFAULT_MAX_RESULTS };
		runtime.recordRequest?.({ endpoint, params: body });
		if (signal?.aborted === true) throw new WebError("Search aborted", "WEB_ABORTED", { cause: signal.reason });
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json",
			"user-agent": USER_AGENT,
		};
		// Keyless requests carry NO Authorization header; only a resolved key adds one.
		if (runtime.apiKey != null && runtime.apiKey.length > 0) headers.authorization = `Bearer ${runtime.apiKey}`;
		let response: Response;
		try {
			response = await fetch(endpoint, {
				method: "POST",
				redirect: "error",
				headers,
				body: JSON.stringify(body),
				...signal !== undefined ? { signal } : {},
			});
		} catch (error) {
			if (isAbortError(error)) {
				throw new WebError("Search aborted", "WEB_ABORTED", { cause: error });
			}
			throw new WebError(`Firecrawl search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) {
			throw new WebError(httpErrorMessage(response.status, await errorDetail(response)), "WEB_PROVIDER_ERROR");
		}
		try {
			const parsed = (await response.json()) as FirecrawlSearchResponse;
			if (parsed.success === false) throw new Error(parsed.error ?? "Firecrawl reported failure without an error message");
			return mapFirecrawlResponse(parsed);
		} catch (error) {
			if (error instanceof WebError) throw error;
			throw new WebError(`Firecrawl returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
	},
};

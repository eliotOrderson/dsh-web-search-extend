/**
 * Contract layer for the extensible web-search plugin.
 *
 * These interfaces are the only thing the core (seam integration) and the
 * adapter layer agree on. An adapter owns one backend; the core owns the
 * harness seam, credentials, cancellation, and the WebError taxonomy. Neither
 * side imports the other's internals — they meet here.
 * @module dsh-web-search-extend/types
 */
import type { WebSearchRequest, WebSearchResult } from "@deepseek-ai/dsh-web";
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
    readonly recordRequest?: (request: {
        endpoint: string;
        params: unknown;
    }) => void;
}
/**
 * A pluggable search backend. One adapter = one vendor/endpoint. It owns its
 * HTTP/SDK call AND its response → `WebSearchResult` mapping, so adding a new
 * provider means adding one file that implements this interface — the core
 * never changes.
 */
export interface SearchAdapter {
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
}
//# sourceMappingURL=types.d.ts.map
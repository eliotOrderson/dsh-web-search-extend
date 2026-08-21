/**
 * Seam-integration layer: the `WebSearchProvider` registered into `ctx.web`.
 *
 * Single responsibility — harness wiring only. It resolves credentials, owns
 * cancellation and the WebError taxonomy, logs the pre-dispatch request, and
 * delegates the actual backend call to the configured `SearchAdapter`. It
 * contains zero vendor specifics, so switching providers is a config change,
 * not a code change.
 * @module dsh-web-search-extend/core/provider
 */
import { type WebSearchProvider, type WebSearchRequest, type WebSearchResult } from "@deepseek-ai/dsh-web";
import type { SearchAdapter } from "../types.js";
/** One search's fully-resolved options, snapshotted by a thunk. */
export interface ResolvedOptions {
    provider: string;
    /** Literal config key, if present. */
    apiKey?: string;
    /** Resolves the credential reference for this search. */
    resolveApiKey?: () => Promise<string | undefined>;
    apiKeyEnv: string;
    baseURL: string;
    adapter: SearchAdapter | undefined;
    settings: Record<string, unknown>;
    recordRequest?: (request: {
        endpoint: string;
        params: unknown;
    }) => void;
}
/**
 * The registered `ctx.web` provider id — the SAME one the official
 * `@deepseek-ai/dsh-web-search-deepseek` provider used. Registering under this
 * id is what makes this plugin a drop-in replacement: the seam auto-selects it
 * and any existing `searchProvider: deepseek-official` config keeps working.
 */
export declare const SEARCH_PROVIDER_ID = "deepseek-official";
/**
 * The web capability's search provider. Its id is always `deepseek-official`
 * (official slot), while the INTERNAL adapter selection (`provider` config)
 * decides which backend actually serves each search. Agent tooling is
 * unaffected — the old `web_search` tool keeps calling `ctx.web.search`, which
 * now routes through this provider into the configured adapter.
 */
export declare class ExtensibleWebSearchProvider implements WebSearchProvider {
    resolveOptions: () => ResolvedOptions;
    id: string;
    constructor(resolveOptions: () => ResolvedOptions);
    available(): boolean;
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
    /**
     * Resolve one operation's credential without retaining it on the provider.
     * Keyless adapters may return `undefined`; key-required adapters throw
     * `WEB_PROVIDER_CREDENTIAL_MISSING`.
     */
    private apiKey;
}
//# sourceMappingURL=provider.d.ts.map
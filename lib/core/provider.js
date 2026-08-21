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
import { WebError } from "@deepseek-ai/dsh-web";
import { abortable, isAbortError, searchAborted, throwIfSearchAborted } from "./abort.js";
import { credentialMissing, providerError } from "./errors.js";
/**
 * The registered `ctx.web` provider id — the SAME one the official
 * `@deepseek-ai/dsh-web-search-deepseek` provider used. Registering under this
 * id is what makes this plugin a drop-in replacement: the seam auto-selects it
 * and any existing `searchProvider: deepseek-official` config keeps working.
 */
export const SEARCH_PROVIDER_ID = "deepseek-official";
/**
 * The web capability's search provider. Its id is always `deepseek-official`
 * (official slot), while the INTERNAL adapter selection (`provider` config)
 * decides which backend actually serves each search. Agent tooling is
 * unaffected — the old `web_search` tool keeps calling `ctx.web.search`, which
 * now routes through this provider into the configured adapter.
 */
export class ExtensibleWebSearchProvider {
    resolveOptions;
    id = SEARCH_PROVIDER_ID;
    constructor(resolveOptions) {
        this.resolveOptions = resolveOptions;
    }
    available() {
        const o = this.resolveOptions();
        if (o.adapter === undefined)
            return false;
        return o.adapter.available({
            apiKey: undefined,
            apiKeyEnv: o.apiKeyEnv,
            baseURL: o.baseURL,
            settings: o.settings,
        });
    }
    async search(request, signal) {
        const o = this.resolveOptions();
        if (o.adapter === undefined)
            throw providerError(`Unknown search adapter "${o.provider}"`);
        const apiKey = await this.apiKey(o, signal);
        throwIfSearchAborted(signal);
        const runtime = {
            apiKey,
            apiKeyEnv: o.apiKeyEnv,
            baseURL: o.baseURL,
            settings: o.settings,
            recordRequest: o.recordRequest,
        };
        throwIfSearchAborted(signal);
        try {
            return await abortable(o.adapter.search(request, runtime, signal), signal);
        }
        catch (error) {
            if (signal?.aborted === true || isAbortError(error))
                throw searchAborted(signal, error);
            if (error instanceof WebError)
                throw error;
            throw providerError(`Search via "${o.provider}" failed: ${String(error)}`, { cause: error });
        }
    }
    /**
     * Resolve one operation's credential without retaining it on the provider.
     * Keyless adapters may return `undefined`; key-required adapters throw
     * `WEB_PROVIDER_CREDENTIAL_MISSING`.
     */
    async apiKey(o, signal) {
        throwIfSearchAborted(signal);
        if (o.adapter === undefined)
            return undefined;
        if (o.apiKey !== undefined && o.apiKey.length > 0)
            return o.apiKey;
        let resolved;
        try {
            resolved = await abortable(o.resolveApiKey?.() ?? Promise.resolve(undefined), signal);
        }
        catch (error) {
            if (signal?.aborted === true || isAbortError(error))
                throw searchAborted(signal, error);
            throw providerError(`Credential resolution failed: ${String(error)}`, { cause: error });
        }
        if (resolved !== undefined && resolved.length > 0)
            return resolved;
        if (o.adapter.requiresApiKey)
            throw credentialMissing(o.apiKeyEnv);
        return undefined;
    }
}
//# sourceMappingURL=provider.js.map
/**
 * Local fetch provider for the `ctx.web` seam. Registered by default so the
 * composite tier keeps working even when the official web-search plugin (and
 * its fetch provider) is disabled.
 *
 * `available()` yields to any other usable provider: the local fallback only
 * becomes visible when nothing else can serve `web_fetch`, which avoids
 * turning a working single-provider deployment into an ambiguous multi-provider
 * one. The underlying request goes through the secure fetch layer.
 * @module dsh-web-search-extend/core/localFetch
 */
import type { WebFetchProvider, WebFetchResult } from "@deepseek-ai/dsh-web";
import { secureFetch } from "./secureFetch.js";

export const LOCAL_FETCH_PROVIDER_ID = "web-search-extend-local";

export function makeLocalFetchProvider(
    providers: () => WebFetchProvider[],
    fetchImpl: (url: string, signal?: AbortSignal) => Promise<WebFetchResult> = secureFetch,
): WebFetchProvider {
    return {
        id: LOCAL_FETCH_PROVIDER_ID,
        available() {
            return providers().every((provider) => provider.id === LOCAL_FETCH_PROVIDER_ID || !provider.available());
        },
        async fetch(request, signal) {
            return fetchImpl(request.url, signal);
        },
    };
}
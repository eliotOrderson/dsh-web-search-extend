/**
 * Local fetch provider for the `ctx.web` seam. Registered by default so the
 * composite tier keeps working even when the official web-search plugin (and
 * its fetch provider) is disabled.
 *
 * `available()` yields to any other usable provider: the local fallback only
 * becomes visible when nothing else can serve `web_fetch`, which avoids
 * turning a working single-provider deployment into an ambiguous multi-provider
 * one.
 * @module dsh-web-search-extend/core/localFetch
 */
import type { WebFetchProvider } from "@deepseek-ai/dsh-web";

export const LOCAL_FETCH_PROVIDER_ID = "web-search-extend-local";

/** Build the default local fetch provider. */
export function makeLocalFetchProvider(providers: () => WebFetchProvider[]): WebFetchProvider {
	return {
		id: LOCAL_FETCH_PROVIDER_ID,
		available() {
			return providers().every((provider) => provider.id === LOCAL_FETCH_PROVIDER_ID || !provider.available());
		},
		async fetch(request, signal) {
			const response = await globalThis.fetch(request.url, { redirect: "follow", signal });
			const contentType = response.headers.get("content-type") ?? "";
			const content = await response.text();
			return {
				url: response.url || request.url,
				statusCode: response.status,
				body: /\bhtml\b/i.test(contentType) ? { kind: "html", content } : { kind: "text", content },
				truncated: false,
			};
		},
	};
}
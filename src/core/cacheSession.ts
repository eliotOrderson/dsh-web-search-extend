/**
 * Cache orchestration shared by the two search entry points: the seam provider
 * (`web_search`) and the `web_search_scoped` tool. The store itself
 * (`core/cache.ts`) is pure storage; THIS module owns the policy both callers
 * must agree on, so a hit cannot be silent in one path and loud in the other:
 *
 * - the key covers the adapter, the provider, the endpoint, the settings
 *   snapshot and the request, never the credential;
 * - a hit is a DEGRADED success, so it always carries `cache hit (age Ns)` on
 *   the warnings trail and never an `attempts` entry — no member ran, and a
 *   fabricated one would surface downstream as a real engine;
 * - both the stored entry and the returned result are copies, because the same
 *   object must not be reachable from two callers.
 * @module dsh-web-search-extend/core/cacheSession
 */
import type { WebSearchRequest, WebSearchResult } from "@deepseek-ai/dsh-web";
import { cacheKey, canonicalize, type ResultCache } from "./cache.js";
import type { WithAttempts } from "./chain.js";

/** What one cacheable search needs to know about itself. */
export interface SearchCacheSession {
	readonly cache: ResultCache;
	/** Identity of the ADAPTER that would serve, which may be a chain id. */
	readonly adapterId: string;
	/** Configured provider id, kept separate: a chain id encodes the members. */
	readonly provider: string;
	readonly baseURL: string;
	/** The settings the adapter will actually see (hints already compiled in). */
	readonly settings: Record<string, unknown>;
	/** Live check, so switching the tier off stops hits instead of only stores. */
	readonly enabled: () => boolean;
	/** Write-through hook; fires once per STORED result, never on a hit. */
	readonly onWrite?: () => void;
}

/**
 * Run one search through the result cache.
 *
 * @param session - the call's cache identity plus its live enable check.
 * @param request - the vendor request; only its canonical hash is stored.
 * @param run - the dispatch to perform on a miss.
 * @returns the fresh result, or a rebuilt copy of the stored one carrying the
 * age marker. Never mutates what it returns to either side afterwards.
 */
export async function runCachedSearch(
	session: SearchCacheSession,
	request: WebSearchRequest,
	run: () => Promise<WebSearchResult>,
): Promise<WebSearchResult> {
	const key = cacheKey({
		op: "search",
		providerId: session.adapterId,
		request,
		// A nested settings object (the `limits` block) only encodes correctly
		// through the depth-sorted canonicaliser; JSON.stringify's array-replacer
		// form is a whitelist at every depth and would hide such a change.
		signature: canonicalize([session.adapterId, session.provider, session.baseURL, session.settings]) ?? session.provider,
	});
	const hit = session.cache.getWithAge<WebSearchResult>(key);
	if (hit !== undefined && session.enabled()) {
		return hitResult(hit.value as WebSearchResult & WithAttempts, Math.floor(hit.ageMs / 1000));
	}
	const result = await run();
	// Store a copy, not the object about to be returned: a caller that mutates
	// what it received would otherwise rewrite the entry every later hit replays.
	session.cache.set(key, copyResult(result));
	session.onWrite?.();
	return result;
}

/** Shallow result copy — sources are remapped so the array is not shared. */
export function copyResult(result: WebSearchResult): WebSearchResult {
	return { ...result, sources: result.sources.map((source) => ({ ...source })) };
}

/**
 * Rebuild the seam's own result shape from a stored payload. Spreading the
 * cached entry would replay whatever the chain stamped onto the ORIGINAL call —
 * a failover success carries `attempts`, and replaying it here would report an
 * engine as having run inside a call that dispatched nothing.
 */
export function hitResult(cached: WebSearchResult & WithAttempts, ageSeconds: number): WebSearchResult & WithAttempts {
	const sources = cached.sources.map((source) => ({ ...source }));
	const content = cached.content;
	const warnings = [...(cached.warnings ?? []), `cache hit (age ${ageSeconds}s)`];
	return Object.assign({ sources, truncated: cached.truncated, ...(content === undefined ? {} : { content }) }, { warnings });
}

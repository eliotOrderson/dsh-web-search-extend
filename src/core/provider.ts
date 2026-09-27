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
import { WebError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult } from "@deepseek-ai/dsh-web";
import type { AdapterRuntime, SearchAdapter } from "../types.js";
import { abortable, isAbortError, searchAborted, throwIfSearchAborted } from "./abort.js";
import { cacheKey, canonicalize, ResultCache } from "./cache.js";
// Type-only: the cache reuses the chain's additive degradation trail shape, so
// a caller switching on `WithAttempts` reads a cache hit and a failover alike.
import type { WithAttempts } from "./chain.js";
import { credentialMissing, providerError } from "./errors.js";

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
	recordRequest?: (request: { endpoint: string; params: unknown }) => void;
}

/**
 * The registered `ctx.web` provider id — the SAME one the official
 * `@deepseek-ai/dsh-web-search-deepseek` provider used. Registering under this
 * id is what makes this plugin a drop-in replacement: the seam auto-selects it
 * and any existing `searchProvider: deepseek-official` config keeps working.
 */
export const SEARCH_PROVIDER_ID = "deepseek-official";

/**
 * Answer-affecting config folded into a cache key. Deliberately excludes the
 * credential: a key is not a secret-keeping device, and the same question
 * answered by the same endpoint at the same settings deserves the same answer
 * no matter which key paid for it.
 */
function cacheSignature(o: ResolvedOptions): string {
	// An array replacer would be a whitelist applied at EVERY depth, so a nested
	// settings object (the `limits` block today) would encode as `{}` and a change
	// inside it would keep serving the old answer. canonicalize sorts keys at all
	// depths instead, and is total: an unencodable value cannot throw here.
	return canonicalize([o.adapter?.id ?? o.provider, o.provider, o.baseURL, o.settings]) ?? o.provider;
}

/**
 * Copy a cached result so the caller can never mutate what we keep: the stored
 * object is replayed to every later hit inside the TTL window.
 */
function copyResult(result: WebSearchResult): WebSearchResult {
	return { ...result, sources: result.sources.map((source) => ({ ...source })) };
}

/**
 * Rebuild the seam's own result shape from a stored payload. Spreading the
 * cached entry would replay whatever the chain stamped onto the ORIGINAL call —
 * a failover success carries `attempts`, and replaying it here would report an
 * engine as having run inside a call that dispatched nothing.
 */
function hitResult(cached: WebSearchResult & WithAttempts, ageSeconds: number): WebSearchResult & WithAttempts {
	const sources = cached.sources.map((source) => ({ ...source }));
	const content = cached.content;
	const warnings = [...(cached.warnings ?? []), `cache hit (age ${ageSeconds}s)`];
	return Object.assign({ sources, truncated: cached.truncated, ...(content === undefined ? {} : { content }) }, { warnings });
}

/**
 * The web capability's search provider. Its id is always `deepseek-official`
 * (official slot), while the INTERNAL adapter selection (`provider` config)
 * decides which backend actually serves each search. Agent tooling is
 * unaffected — the old `web_search` tool keeps calling `ctx.web.search`, which
 * now routes through this provider into the configured adapter.
 */
export class ExtensibleWebSearchProvider implements WebSearchProvider {
	resolveOptions: () => ResolvedOptions;
	id: string = SEARCH_PROVIDER_ID;
	private readonly cache: ResultCache | undefined;
	private readonly cacheEnabled: () => boolean;
	/** Write-through hook; called once per stored result, never on a hit. */
	onCacheWrite: (() => void) | undefined;

	constructor(resolveOptions: () => ResolvedOptions, cache?: ResultCache, onCacheWrite?: () => void, cacheEnabled: () => boolean = () => true) {
		this.resolveOptions = resolveOptions;
		this.cache = cache;
		this.onCacheWrite = onCacheWrite;
		this.cacheEnabled = cacheEnabled;
	}

	available(): boolean {
		const o = this.resolveOptions();
		if (o.adapter === undefined) return false;
		return o.adapter.available({
			apiKey: undefined,
			apiKeyEnv: o.apiKeyEnv,
			baseURL: o.baseURL,
			settings: o.settings,
		});
	}

	async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
		const o = this.resolveOptions();
		const key = this.cache === undefined ? undefined : cacheKey({ op: "search", providerId: o.adapter?.id ?? o.provider, request, signature: cacheSignature(o) });
		if (key !== undefined) {
			const hit = this.cache!.getWithAge<WebSearchResult>(key);
			// Enabled is read per call, not latched at mount: a settings write that
			// switches the tier off must stop HITS, not only future stores.
			if (hit !== undefined && this.cacheEnabled()) {
				// A hit is a DEGRADED success — the payload was not fetched now and
				// may be up to a TTL old — so it always carries the trail, and never
				// an attempts entry: no member ran, and a fabricated one would
				// surface in doctor output as a real engine.
				return hitResult(hit.value as WebSearchResult & WithAttempts, Math.floor(hit.ageMs / 1000));
			}
		}
		const { adapter, runtime } = await resolveExecution(o, signal);
		let result: WebSearchResult;
		try {
			result = await abortable(adapter.search(request, runtime, signal), signal);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			if (error instanceof WebError) throw error;
			throw providerError(`Search via "${o.provider}" failed: ${String(error)}`, { cause: error });
		}
		if (key !== undefined) {
			// Store a copy, not the adapter's object: the same reference is about to
			// be handed to the caller, and a caller that mutates what it received
			// would otherwise rewrite the entry every later hit replays.
			this.cache!.set(key, copyResult(result));
			this.onCacheWrite?.();
		}
		return result;
	}
}

/** One operation's ready-to-dispatch target: guarded adapter plus credentialed runtime. */
export interface ExecutionTarget {
	readonly adapter: SearchAdapter;
	readonly runtime: AdapterRuntime;
}

/**
 * Resolve one operation's execution target from a config snapshot. Shared by
 * `ExtensibleWebSearchProvider` and the tool layer so the unknown-adapter
 * guard, credential resolution, and preflight abort checks stay single-sourced.
 */
export async function resolveExecution(o: ResolvedOptions, signal?: AbortSignal): Promise<ExecutionTarget> {
	if (o.adapter === undefined) throw providerError(`Unknown search adapter "${o.provider}"`);
	const apiKey = await resolveApiKey(o, signal);
	throwIfSearchAborted(signal);
	return {
		adapter: o.adapter,
		runtime: {
			apiKey,
			apiKeyEnv: o.apiKeyEnv,
			baseURL: o.baseURL,
			settings: o.settings,
			recordRequest: o.recordRequest,
		},
	};
}

/**
 * Resolve one operation's credential without retaining it anywhere. Keyless
 * adapters may return `undefined`; key-required adapters throw
 * `WEB_PROVIDER_CREDENTIAL_MISSING`.
 */
async function resolveApiKey(o: ResolvedOptions, signal?: AbortSignal): Promise<string | undefined> {
	throwIfSearchAborted(signal);
	if (o.apiKey !== undefined && o.apiKey.length > 0) return o.apiKey;
	let resolved: string | undefined;
	try {
		resolved = await abortable(o.resolveApiKey?.() ?? Promise.resolve(undefined), signal);
	} catch (error) {
		if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
		throw providerError(`Credential resolution failed: ${String(error)}`, { cause: error });
	}
	if (resolved !== undefined && resolved.length > 0) return resolved;
	if (o.adapter !== undefined && o.adapter.requiresApiKey) throw credentialMissing(o.apiKeyEnv);
	return undefined;
}

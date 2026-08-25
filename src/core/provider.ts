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
 * The web capability's search provider. Its id is always `deepseek-official`
 * (official slot), while the INTERNAL adapter selection (`provider` config)
 * decides which backend actually serves each search. Agent tooling is
 * unaffected — the old `web_search` tool keeps calling `ctx.web.search`, which
 * now routes through this provider into the configured adapter.
 */
export class ExtensibleWebSearchProvider implements WebSearchProvider {
	resolveOptions: () => ResolvedOptions;
	id: string = SEARCH_PROVIDER_ID;

	constructor(resolveOptions: () => ResolvedOptions) {
		this.resolveOptions = resolveOptions;
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
		const { adapter, runtime } = await resolveExecution(o, signal);
		try {
			return await abortable(adapter.search(request, runtime, signal), signal);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			if (error instanceof WebError) throw error;
			throw providerError(`Search via "${o.provider}" failed: ${String(error)}`, { cause: error });
		}
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

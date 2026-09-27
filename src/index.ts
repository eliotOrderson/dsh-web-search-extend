/**
 * Plugin entry — a drop-in replacement for the official web-search provider.
 *
 * It takes over the official identity where it matters (so nothing downstream
 * changes), while keeping an independent cordis name so a normal bundle install
 * is not accidentally disabled by the patch that disables the official:
 * - settings surface:   its own entry's Config (0.1.7 keys forms by entry id)
 * - provider id:        `deepseek-official` (seam/agent selection unchanged)
 * - cordis plugin name: `dsh-web-search-extend` (distinct loader identity)
 *
 * The agent keeps calling the OLD `web_search` tool; that tool stays on
 * `ctx.web.search`, which now routes through this plugin's provider into the
 * adapter selected by `config.provider` (firecrawl-keyless / tavily / deepseek).
 * @module dsh-web-search-extend
 */
import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError, type WebFetchProvider, type WebSearchResult } from "@deepseek-ai/dsh-web";
import { Config, ConfigShape, type ConfigType } from "./config.js";
import { capabilitiesOf } from "./core/capabilities.js";
import { DEFAULT_MAX_ENTRIES, DEFAULT_TTL_MS, ResultCache } from "./core/cache.js";
import { ExtensibleWebSearchProvider, resolveExecution, type ResolvedOptions } from "./core/provider.js";
import { runCachedSearch } from "./core/cacheSession.js";
import { abortable, isAbortError, searchAborted } from "./core/abort.js";
import { providerError } from "./core/errors.js";
import type { ExecutionTarget } from "./core/provider.js";
import { execute } from "./core/router.js";
import { AdapterRegistry } from "./core/registry.js";
import { chainOf, resolveChain } from "./core/chain.js";
import type { SearchAdapter } from "./types.js";
import { CooldownBoard, loadBoard } from "./core/cooldown.js";
import { readState, resolveStateDir, writeState } from "./core/state.js";
import { rotatingKey } from "./core/rotating-key.js";
import { makeLocalFetchProvider } from "./core/localFetch.js";
import { createDefaultRegistry } from "./adapters/index.js";
import { applyWebTools } from "./tools/index.js";
import type { DoctorCacheReport } from "./tools/doctor.js";
import type { ScopedSearchPlanner, ScopedSearchRequest, ScopedSearchRunner } from "./tools/scoped.js";

/** Cordis plugin name — independent from the official one on purpose. */
const name = "dsh-web-search-extend";
/** The web seam this provider registers into. */
const inject = ["web", "tools", "systemPrompt", "settings"];
/** Fallback env name for the base URL when no adapter supplies one. */
const FALLBACK_BASE_URL_ENV = "DSH_WEB_SEARCH_BASE_URL";

/**
 * Project one resolved config (read live via `getConfig`) into the options the
 * provider serves its next search with. Adapter metadata supplies the defaults
 * for credential env, base URL, and base-url env; config overrides win, so
 * switching `provider` re-targets credentials + endpoint automatically.
 *
 * @param ctx - plugin context supplying credential/environment planes.
 * @param getConfig - thunk returning the authoritative config (updates on settings change).
 * @param registry - the adapter registry to look the selected backend up in.
 * @returns options for one search.
 */
function resolveOptions(ctx: Context, getConfig: () => ConfigType, registry: AdapterRegistry, cooldowns: CooldownBoard): () => ResolvedOptions {
	return () => {
		const config = getConfig();
		const provider = config.provider ?? "tavily";
		// D3 failover: with a non-empty fallbacks array the provider sees one
		// ChainAdapter wrapping [primary, ...fallbacks]; otherwise the bare
		// primary, so single-provider configs keep today's shape.
		const { members } = resolveChain(registry, provider, config.fallbacks ?? []);
		// Key rotation wraps ONLY the primary: the resolved key value belongs to
		// one provider's own ref, and fallback members inherit the shared
		// runtime, so rotating their calls through it would borrow keys across
		// providers (AGENTS.md incident rule).
		const wired = members.map((member, index) => (index === 0 ? rotatingKey(member) : member));
		const adapter = chainOf(wired, { cooldowns }) ?? wired[0];
		const memberIds = wired.map((member) => member.id);
		// Key ref resolution: the top-level apiKeyEnv is what the settings card
		// writes against (official-compatible); a provider subsection may override
		// it for per-provider splits. No cross-provider fallback beyond that.
		const providerSettings = ((config as Record<string, unknown>)[provider] ?? {}) as Record<string, unknown>;
		const subsectionEnv = (providerSettings as { apiKeyEnv?: string }).apiKeyEnv;
		const apiKeyEnvName = config.apiKeyEnv ?? subsectionEnv ?? adapter?.defaultApiKeyEnv ?? "DEEPSEEK_API_KEY";
		const apiKeyEnv = credentialRef(apiKeyEnvName);
		const literalApiKey = config.apiKey != null && config.apiKey.length > 0 ? config.apiKey : undefined;
		const baseURLEnv = adapter?.baseURLEnv ?? FALLBACK_BASE_URL_ENV;
		const baseURL =
			config.baseURL != null && config.baseURL.length > 0
				? config.baseURL
				: launchEnvironmentOf(ctx).get(baseURLEnv)?.value ?? adapter?.defaultBaseURL ?? "";
		const settings = { ...providerSettings, limits: config.limits, routeMode: config.routeMode };
		return {
			provider,
			...(literalApiKey === undefined ? {} : { apiKey: literalApiKey }),
			resolveApiKey: async () => {
				const credentials = ctx.get("credentials");
				if (credentials !== undefined) {
					const resolved = await credentials.resolve(apiKeyEnv);
					if (resolved?.value !== undefined && resolved.value.length > 0) return resolved.value;
				}
				const ambient = launchEnvironmentOf(ctx).get(apiKeyEnvName);
				if (ambient !== undefined && ambient.value.length > 0) return ambient.value;
				const envKey = process.env[apiKeyEnvName];
				return envKey !== undefined && envKey.length > 0 ? envKey : undefined;
			},
			apiKeyEnv: apiKeyEnvName,
			baseURL,
			adapter,
			memberIds,
			settings,
			recordRequest: (request) => {
				ctx.get("agents")?.currentInitiator()?.session.append("web/deepseek-search-llm-request", request);
			},
		};
	};
}

/**
 * Opt-in fetch takeover (design s9): expose single-URL extract as a fetch
 * provider under an explicit id. Selection stays manual (`fetchProvider`
 * setting / `DSH_WEB_FETCH_PROVIDER` env) per the seam ambiguity rule.
 *
 * Guard semantics: takeover serves each URL through the ACTIVE ADAPTER'S
 * NATIVE extract only. Registration requires capabilitiesOf(adapter) to
 * contain "extract" — a search-only adapter cannot serve web_fetch and gets a
 * structured WEB_OP_UNSUPPORTED instead of silently degrading to the composite
 * tier. The composite seam handed to execute() is therefore an unreachable
 * stub that throws the same error: unreachable for native-extract adapters,
 * and a clean failure instead of unbounded ctx.web.fetch recursion if any
 * future change ever routes this provider back into itself.
 */
function fetchTakeoverUnavailable(adapterId: string): WebError {
	return new WebError(
		`fetchBackend=adapter requires the active provider to support extract natively (e.g. tavily); current provider "${adapterId}" cannot serve web_fetch takeover - switch provider or set fetchBackend="local"`,
		"WEB_OP_UNSUPPORTED",
	);
}

function makeFetchProvider(resolveOpts: () => ResolvedOptions): WebFetchProvider {
	return {
		id: "web-search-extend",
		available: () => true,
		fetch: async (request, signal) => {
			const { adapter, runtime } = await resolveExecution(resolveOpts(), signal);
			if (!capabilitiesOf(adapter).has("extract")) throw fetchTakeoverUnavailable(adapter.id);
			const result = await execute({
				op: "extract",
				request: { urls: [request.url] },
				adapter,
				runtime,
				// Unreachable by the guard above; throwing keeps any regression a clean failure.
				fetch: () => {
					throw fetchTakeoverUnavailable(adapter.id);
				},
				signal,
			});
			const page = result.pages[0];
			return {
				url: request.url,
				statusCode: page !== undefined && page.failureReason !== undefined ? 502 : 200,
				body: { kind: "text", content: page?.content ?? "" },
				truncated: false,
			};
		},
	};
}

/**
 * The config reference cordis hands a plugin whose schema marks its root
 * volatile: the value is read through `get()` and updates in place, so holding
 * the reference is what keeps the provider live across a settings write.
 */
interface VolatileConfig {
	get(): ConfigType | undefined;
}

/** Register the replacement search provider with `ctx.web`. */
function apply(ctx: Context, config: VolatileConfig): void {
	const registry = createDefaultRegistry();
	// 0.1.7 drops the namespace-keyed settings surface: the entry's own volatile
	// Config is the form, and this thunk is the single reader of it.
	const current = (): ConfigType => config.get() ?? ConfigShape({});
	const stateDir = resolveStateDir(ctx);
	// Cooldown and cache state share one document; both are re-read before every
	// write so each tier publishes its own slice without erasing the other's.
	const cooldowns = loadBoard(stateDir);
	const cacheSettings = current().cache;
	const cache = ResultCache.fromState(readState(stateDir)?.cache, {
		ttlMs: (cacheSettings?.ttlSeconds ?? DEFAULT_TTL_MS / 1000) * 1000,
		maxEntries: cacheSettings?.maxEntries ?? DEFAULT_MAX_ENTRIES,
	});
	const saveState = (): void => {
		writeState(stateDir, {
			version: 1,
			cooldown: cooldowns.toState(),
			cache: cache.toState(),
		});
	};
	const resolveOpts = resolveOptions(ctx, current, registry, cooldowns);
	// The cache hook is a no-op when the tier is switched off: nothing was stored,
	// so nothing needs publishing.
	const persist = (): void => {
		if (current().cache?.enabled !== false) saveState();
	};
	const cacheEnabled = cacheSettings?.enabled !== false;
	const cacheInfo = (): DoctorCacheReport => {
		const live = cacheSettings ?? { ttlSeconds: DEFAULT_TTL_MS / 1000, maxEntries: DEFAULT_MAX_ENTRIES };
		return { enabled: cacheEnabled, ttlSeconds: live.ttlSeconds, maxEntries: live.maxEntries, ...cache.stats(), stateDir: cacheEnabled ? stateDir : "" };
	};
	// ttl/maxEntries are applied at mount (a settings edit that changes them needs a
	// restart); `enabled` is re-read per call so switching the tier off takes effect
	// at once instead of only stopping the next store.
	const provider = new ExtensibleWebSearchProvider(resolveOpts, cacheEnabled ? cache : undefined, persist, () => current().cache?.enabled !== false);
	ctx.web.registerSearchProvider(provider);
	const fetchProviders = () => [...(ctx.web as unknown as { fetchProviders: Map<string, WebFetchProvider> }).fetchProviders.values()];
	ctx.web.registerFetchProvider(makeLocalFetchProvider(fetchProviders));

	/**
	 * Dispatch for `web_search_scoped`. Two rules make it differ from the seam
	 * provider on purpose:
	 * - a NAMED provider is used exactly as named and is NOT wrapped in the
	 *   failover chain: an engine-specific source (a platform search, say) that
	 *   silently falls back becomes a general web search, i.e. a different answer
	 *   to the question that was asked;
	 * - filters are compiled per adapter, so the chain case compiles to what EVERY
	 *   member can express rather than to what the first one happens to support.
	 */
	/**
	 * Resolution for `web_search_scoped`, shared by its planner and runner so the
	 * two phases cannot disagree about which provider serves. Two rules make it
	 * differ from the seam provider on purpose:
	 * - a NAMED provider is used exactly as named and is NOT wrapped in the
	 *   failover chain: an engine-specific source (a platform search, say) that
	 *   silently falls back becomes a general web search, i.e. a different answer
	 *   to the question that was asked;
	 * - filters are compiled per adapter, so the chain case compiles to what EVERY
	 *   member can express rather than to what the first one happens to support.
	 */
	const scopedTarget = async (request: ScopedSearchRequest, signal?: AbortSignal): Promise<{ options: ResolvedOptions; target: ExecutionTarget }> => {
		const o = resolveOpts();
		const named = request.provider === undefined ? undefined : registry.get(request.provider);
		if (request.provider !== undefined && named === undefined) {
			const known = registry.list().map((adapter) => adapter.id).join(", ");
			throw new WebError(`Unknown provider "${request.provider}" for web_search_scoped. Registered providers: ${known}.`, "WEB_PROVIDER_CONFIGURED_MISSING");
		}
		const wired =
			named === undefined
				? (o.memberIds ?? []).map((id) => registry.get(id)).filter((adapter): adapter is SearchAdapter => adapter !== undefined)
				: [named];
		// Key rotation wraps only the member that will actually serve, mirroring the
		// seam chain's rule: a resolved key belongs to one provider's own ref.
		const serving = wired.length === 0 ? o.adapter : rotatingKey(wired[0]!);
		if (serving === undefined) throw new WebError("No search provider is available for web_search_scoped.", "WEB_PROVIDER_UNAVAILABLE");
		const options: ResolvedOptions = { ...o, adapter: serving, memberIds: wired.map((member) => member.id), settings: request.settings };
		return { options, target: await resolveExecution(options, signal) };
	};

	const scopedPlanner: ScopedSearchPlanner = async (request, signal) => {
		const { options, target } = await scopedTarget(request, signal);
		return { adapter: target.adapter, runtime: { ...target.runtime, settings: request.settings }, memberIds: options.memberIds ?? [] };
	};

	const scopedRunner: ScopedSearchRunner = async (request, signal) => {
		const { options, target } = await scopedTarget(request, signal);
		const vendorRequest = { query: request.query, ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }) };
		const dispatch = async (): Promise<WebSearchResult> => {
			try {
				return await abortable(target.adapter.search(vendorRequest, target.runtime, signal), signal);
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
				if (error instanceof WebError) throw error;
				throw providerError(`Scoped search via "${options.adapter?.id ?? options.provider}" failed: ${String(error)}`, { cause: error });
			}
		};
		if (!cacheEnabled) return dispatch();
		return runCachedSearch(
			{
				cache,
				adapterId: options.adapter?.id ?? options.provider,
				provider: request.provider ?? options.provider,
				baseURL: options.baseURL,
				settings: request.settings,
				enabled: () => current().cache?.enabled !== false,
				onWrite: persist,
			},
			vendorRequest,
			dispatch,
		);
	};

	applyWebTools(ctx, resolveOpts, current().tools, { registry, config: current, cooldowns, cacheInfo }, scopedPlanner, scopedRunner);
	if (current().fetchBackend === "adapter") {
		ctx.web.registerFetchProvider(makeFetchProvider(resolveOpts));
	}
	// A restart re-probes every engine, so the last publish before teardown is
	// what carries the cooldown to the next process; the cache rides along.
	ctx.effect(() => () => persist());
}

export { Config, createDefaultRegistry, apply, inject, name };

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
import { WebError, type WebFetchProvider } from "@deepseek-ai/dsh-web";
import { Config, ConfigShape, type ConfigType } from "./config.js";
import { capabilitiesOf } from "./core/capabilities.js";
import { ExtensibleWebSearchProvider, resolveExecution, type ResolvedOptions } from "./core/provider.js";
import { execute } from "./core/router.js";
import { AdapterRegistry } from "./core/registry.js";
import { chainOf, resolveChain } from "./core/chain.js";
import { CooldownBoard } from "./core/cooldown.js";
import { rotatingKey } from "./core/rotating-key.js";
import { makeLocalFetchProvider } from "./core/localFetch.js";
import { createDefaultRegistry } from "./adapters/index.js";
import { applyWebTools } from "./tools/index.js";

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
	// D2: cooldown state lives in memory for the plugin's lifetime; a restart
	// clears it and the engine is simply probed again.
	const cooldowns = new CooldownBoard();
	// 0.1.7 drops the namespace-keyed settings surface: the entry's own volatile
	// Config is the form, and this thunk is the single reader of it.
	const current = (): ConfigType => config.get() ?? ConfigShape({});
	const resolveOpts = resolveOptions(ctx, current, registry, cooldowns);
	ctx.web.registerSearchProvider(new ExtensibleWebSearchProvider(resolveOpts));
	const fetchProviders = () => [...(ctx.web as unknown as { fetchProviders: Map<string, WebFetchProvider> }).fetchProviders.values()];
	ctx.web.registerFetchProvider(makeLocalFetchProvider(fetchProviders));
	applyWebTools(ctx, resolveOpts, current().tools, { registry, config: current, cooldowns });
	if (current().fetchBackend === "adapter") {
		ctx.web.registerFetchProvider(makeFetchProvider(resolveOpts));
	}
}

export { Config, createDefaultRegistry, apply, inject, name };

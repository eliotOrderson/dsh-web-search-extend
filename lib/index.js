import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { Config } from "./config.js";
import { ExtensibleWebSearchProvider } from "./core/provider.js";
import { createDefaultRegistry } from "./adapters/index.js";
/** Cordis plugin name — independent from the official one on purpose. */
const name = "web-search-extend";
/** The web seam this provider registers into. */
const inject = ["web"];
/** Fallback env name for the base URL when no adapter supplies one. */
const FALLBACK_BASE_URL_ENV = "DSH_WEB_SEARCH_BASE_URL";
/** Settings namespace — REUSED so the config page keeps the section in place. */
const WEB_SEARCH_SETTINGS_NAMESPACE = settingsNamespace("web-search-deepseek");
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
function resolveOptions(ctx, getConfig, registry) {
    return () => {
        const config = getConfig();
        const provider = config.provider ?? "tavily";
        const adapter = registry.get(provider);
        const apiKeyEnvName = config.apiKeyEnv ?? adapter?.defaultApiKeyEnv ?? "DEEPSEEK_API_KEY";
        const apiKeyEnv = credentialRef(apiKeyEnvName);
        const literalApiKey = config.apiKey != null && config.apiKey.length > 0 ? config.apiKey : undefined;
        const baseURLEnv = adapter?.baseURLEnv ?? FALLBACK_BASE_URL_ENV;
        const baseURL = config.baseURL != null && config.baseURL.length > 0
            ? config.baseURL
            : launchEnvironmentOf(ctx).get(baseURLEnv)?.value ?? adapter?.defaultBaseURL ?? "";
        const settings = (config[provider] ?? {});
        return {
            provider,
            ...(literalApiKey === undefined ? {} : { apiKey: literalApiKey }),
            resolveApiKey: async () => {
                const credentials = ctx.get("credentials");
                if (credentials !== undefined)
                    return (await credentials.resolve(apiKeyEnv))?.value;
                const ambient = launchEnvironmentOf(ctx).get(apiKeyEnvName);
                return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined;
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
/** Register the replacement search provider with `ctx.web`. */
function apply(ctx, config) {
    const registry = createDefaultRegistry();
    let current = () => config;
    installSettingsSection(ctx, WEB_SEARCH_SETTINGS_NAMESPACE, Config, config, {
        setSource: (source) => {
            current = source;
        },
        onChange: () => { },
    });
    ctx.web.registerSearchProvider(new ExtensibleWebSearchProvider(resolveOptions(ctx, current, registry)));
}
export { Config, createDefaultRegistry, apply, inject, name };
//# sourceMappingURL=index.js.map
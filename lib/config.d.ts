/**
 * Config layer: the schemastery schema for the (replaced) `web-search-deepseek`
 * Settings section and shared defaults.
 *
 * The section's field set is a SUPERSET of the official `@deepseek-ai/
 * dsh-web-search-deepseek` config, extended with a `provider` selector and
 * per-provider subsections. `apiKeyEnv`/`baseURL` carry no default here:
 * each adapter supplies its own, so switching `provider` re-targets credentials
 * and endpoint automatically. This module knows nothing about HTTP.
 * @module dsh-web-search-extend/config
 */
import z from "@deepseek-ai/schemastery";
/** Default backend selected when config omits `provider` (keyless, testable). */
export declare const DEFAULT_PROVIDER = "tavily";
/** Fallback credential-reference name when no adapter supplies one. */
export declare const DEFAULT_API_KEY_ENV = "TAVILY_API_KEY";
/** Tavily defaults + env names. */
export declare const TAVILY_API_KEY_ENV = "TAVILY_API_KEY";
export declare const TAVILY_BASE_URL_ENV = "TAVILY_BASE_URL";
export declare const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com";
/** DeepSeek defaults + env names (mirrors the official provider). */
export declare const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";
export declare const DEEPSEEK_SEARCH_BASE_URL_ENV = "DEEPSEEK_SEARCH_BASE_URL";
export declare const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic/v1";
export declare const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";
export declare const DEEPSEEK_DEFAULT_API_VERSION = "2023-06-01";
export declare const DEEPSEEK_DEFAULT_MAX_TOKENS = 4096;
export declare const DEEPSEEK_DEFAULT_MAX_USES = 5;
/**
 * Plugin config. `provider` selects which adapter runs; `apiKey`/`apiKeyEnv`/
 * `baseURL` are cross-cutting overrides; each adapter reads its own subsection
 * (`deepseek`, `tavily`, `demo`) for backend-specific knobs.
 */
export declare const Config: z<Schemastery.ObjectS<{
    provider: z<string, string>;
    apiKey: z<string, string>;
    apiKeyEnv: z<string, string>;
    baseURL: z<string, string>;
    deepseek: z<Schemastery.ObjectS<{
        model: z<string, string>;
        apiVersion: z<string, string>;
        maxTokens: z<number, number>;
        maxUses: z<number, number>;
    }>, Schemastery.ObjectT<{
        model: z<string, string>;
        apiVersion: z<string, string>;
        maxTokens: z<number, number>;
        maxUses: z<number, number>;
    }>>;
    tavily: z<Schemastery.ObjectS<{
        searchDepth: z<string, string>;
        topic: z<string, string>;
        maxResults: z<number, number>;
        includeAnswer: z<boolean, boolean>;
        timeRange: z<string, string>;
    }>, Schemastery.ObjectT<{
        searchDepth: z<string, string>;
        topic: z<string, string>;
        maxResults: z<number, number>;
        includeAnswer: z<boolean, boolean>;
        timeRange: z<string, string>;
    }>>;
    demo: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>>;
}>, Schemastery.ObjectT<{
    provider: z<string, string>;
    apiKey: z<string, string>;
    apiKeyEnv: z<string, string>;
    baseURL: z<string, string>;
    deepseek: z<Schemastery.ObjectS<{
        model: z<string, string>;
        apiVersion: z<string, string>;
        maxTokens: z<number, number>;
        maxUses: z<number, number>;
    }>, Schemastery.ObjectT<{
        model: z<string, string>;
        apiVersion: z<string, string>;
        maxTokens: z<number, number>;
        maxUses: z<number, number>;
    }>>;
    tavily: z<Schemastery.ObjectS<{
        searchDepth: z<string, string>;
        topic: z<string, string>;
        maxResults: z<number, number>;
        includeAnswer: z<boolean, boolean>;
        timeRange: z<string, string>;
    }>, Schemastery.ObjectT<{
        searchDepth: z<string, string>;
        topic: z<string, string>;
        maxResults: z<number, number>;
        includeAnswer: z<boolean, boolean>;
        timeRange: z<string, string>;
    }>>;
    demo: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>>;
}>>;
/** Parsed config type, derived from the schema (schemastery has no `z.infer`). */
export type ConfigType = ReturnType<typeof Config>;
//# sourceMappingURL=config.d.ts.map
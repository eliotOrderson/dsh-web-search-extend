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

/** Firecrawl defaults + env names. */
export const FIRECRAWL_API_KEY_ENV = "FIRECRAWL_API_KEY";
export const FIRECRAWL_BASE_URL_ENV = "FIRECRAWL_BASE_URL";
export const FIRECRAWL_DEFAULT_BASE_URL = "https://api.firecrawl.dev";

/** Default backend selected when config omits `provider` (keyless, testable). */
export const DEFAULT_PROVIDER = "firecrawl-keyless";
/** Fallback credential-reference name when no adapter supplies one. */
export const DEFAULT_API_KEY_ENV = FIRECRAWL_API_KEY_ENV;

/** Tavily defaults + env names. */
export const TAVILY_API_KEY_ENV = "TAVILY_API_KEY";
export const TAVILY_BASE_URL_ENV = "TAVILY_BASE_URL";
export const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com";

/** DeepSeek defaults + env names (mirrors the official provider). */
export const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";
export const DEEPSEEK_SEARCH_BASE_URL_ENV = "DEEPSEEK_SEARCH_BASE_URL";
export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic/v1";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";
export const DEEPSEEK_DEFAULT_API_VERSION = "2023-06-01";
export const DEEPSEEK_DEFAULT_MAX_TOKENS = 4096;
export const DEEPSEEK_DEFAULT_MAX_USES = 5;

/**
 * Plugin config. `provider` selects which adapter runs; `apiKey`/`apiKeyEnv`/
 * `baseURL` are cross-cutting overrides; each adapter reads its own subsection
 * (`deepseek`, `tavily`) for backend-specific knobs.
 */
export const Config = z.object({
	provider: z.string().default(DEFAULT_PROVIDER),
	apiKey: z.string().role("secret"),
	apiKeyEnv: z.string().role("credential-ref").default(FIRECRAWL_API_KEY_ENV),
	baseURL: z.string(),
	/** Fetch takeover (design s9): "local" registers nothing new; "adapter" also exposes extract as a fetch provider. */
	fetchBackend: z.string().default("local"),
	/** Failover chain (D3): ordered adapter ids tried after the primary on switchable failures. */
	fallbacks: z.array(z.string()).default([]),
	/**
	 * Routing mode for extract/crawl/map: "provider-first" tries the active
	 * adapter's native call and retries through the zero-quota composite tier
	 * on failure; "local-only" goes straight to the composite tier without
	 * touching the provider. search/research have no local form and are
	 * unaffected.
	 */
	routeMode: z.string().default("provider-first"),
	tools: z.object({
		extract: z.boolean().default(true),
		crawl: z.boolean().default(true),
		map: z.boolean().default(true),
		research: z.boolean().default(false),
		doctor: z.boolean().default(true),
	}),
	limits: z.object({
		extractMaxUrls: z.number().step(1).min(1).default(10),
		crawlMaxPages: z.number().step(1).min(1).default(10),
		mapMaxUrls: z.number().step(1).min(1).default(100),
		perPageChars: z.number().step(1).min(1).default(20000),
	}),
	deepseek: z.object({
		model: z.string().default(DEEPSEEK_DEFAULT_MODEL),
		apiVersion: z.string().default(DEEPSEEK_DEFAULT_API_VERSION),
		maxTokens: z.number().step(1).min(1).default(DEEPSEEK_DEFAULT_MAX_TOKENS),
		maxUses: z.number().step(1).min(1).default(DEEPSEEK_DEFAULT_MAX_USES),
		apiKeyEnv: z.string().role("credential-ref").default(DEEPSEEK_API_KEY_ENV),
	}),
	tavily: z.object({
		searchDepth: z.string().default("basic"),
		topic: z.string().default("general"),
		maxResults: z.number().step(1).min(1).default(5),
		includeAnswer: z.boolean().default(false),
		timeRange: z.string().default(""),
		extractDepth: z.string().default("basic"),
		researchModel: z.string().default("auto"),
		apiKeyEnv: z.string().role("credential-ref").default(TAVILY_API_KEY_ENV),
	}),
});

/** Parsed config type, derived from the schema (schemastery has no `z.infer`). */
export type ConfigType = ReturnType<typeof Config>;

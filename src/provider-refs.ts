/**
 * Zero-dependency leaf: provider id -> default credential-ref name.
 *
 * Shared verbatim by the node core and the browser client bundle. The UI must
 * not import the schemastery-backed config module: esbuild cannot tree-shake
 * the top-level schema call, so the whole schema would be inlined into
 * lib/client.js. Only mapping that both sides need lives here.
 * @module dsh-web-search-extend/provider-refs
 */

export const FIRECRAWL_API_KEY_ENV = "FIRECRAWL_API_KEY";
export const TAVILY_API_KEY_ENV = "TAVILY_API_KEY";
export const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";

/** Default key ref per provider; the settings card badge reads the top-level apiKeyEnv. */
export const PROVIDER_DEFAULT_API_KEY_ENVS: Record<string, string> = {
	tavily: TAVILY_API_KEY_ENV,
	deepseek: DEEPSEEK_API_KEY_ENV,
	"firecrawl-keyless": FIRECRAWL_API_KEY_ENV,
};

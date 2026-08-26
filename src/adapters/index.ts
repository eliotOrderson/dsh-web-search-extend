/**
 * Adapter layer entry point: builds the default registry with the adapters
 * shipped by this plugin. External adapters can be registered on the same
 * registry instance after `createDefaultRegistry()` returns.
 * @module dsh-web-search-extend/adapters
 */
import { AdapterRegistry } from "../core/registry.js";
import { DeepSeekAdapter } from "./deepseek.js";
import { FirecrawlKeylessAdapter } from "./firecrawl.js";
import { TavilyAdapter } from "./tavily.js";

/** A registry pre-loaded with the bundled adapters (DeepSeek + Tavily + Firecrawl). */
export function createDefaultRegistry(): AdapterRegistry {
	const registry = new AdapterRegistry();
	registry.register(DeepSeekAdapter);
	registry.register(TavilyAdapter);
	registry.register(FirecrawlKeylessAdapter);
	return registry;
}

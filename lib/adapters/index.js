/**
 * Adapter layer entry point: builds the default registry with the adapters
 * shipped by this plugin. External adapters can be registered on the same
 * registry instance after `createDefaultRegistry()` returns.
 * @module dsh-web-search-extend/adapters
 */
import { AdapterRegistry } from "../core/registry.js";
import { DeepSeekAdapter } from "./deepseek.js";
import { DemoAdapter } from "./demo.js";
import { TavilyAdapter } from "./tavily.js";
/** A registry pre-loaded with the bundled adapters (DeepSeek + Tavily + Demo). */
export function createDefaultRegistry() {
    const registry = new AdapterRegistry();
    registry.register(DeepSeekAdapter);
    registry.register(TavilyAdapter);
    registry.register(DemoAdapter);
    return registry;
}
//# sourceMappingURL=index.js.map
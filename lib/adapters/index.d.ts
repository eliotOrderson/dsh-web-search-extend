/**
 * Adapter layer entry point: builds the default registry with the adapters
 * shipped by this plugin. External adapters can be registered on the same
 * registry instance after `createDefaultRegistry()` returns.
 * @module dsh-web-search-extend/adapters
 */
import { AdapterRegistry } from "../core/registry.js";
/** A registry pre-loaded with the bundled adapters (DeepSeek + Tavily + Demo). */
export declare function createDefaultRegistry(): AdapterRegistry;
//# sourceMappingURL=index.d.ts.map
/**
 * Adapter registry — the pluggability mechanism. The core looks adapters up
 * by id here; bundled adapters are registered at `apply` time, and external
 * code can register more without touching the core. This is what keeps the
 * plugin from being locked to one vendor.
 * @module dsh-web-search-extend/core/registry
 */
import type { SearchAdapter } from "../types.js";
export declare class AdapterRegistry {
    private readonly adapters;
    /** Register an adapter. Returns a disposer that unregisters it. */
    register(adapter: SearchAdapter): () => void;
    /** Look up an adapter by id. */
    get(id: string): SearchAdapter | undefined;
    /** Whether an adapter id is registered. */
    has(id: string): boolean;
    /** All registered adapters (for diagnostics/ui). */
    list(): SearchAdapter[];
}
//# sourceMappingURL=registry.d.ts.map
/**
 * Adapter registry — the pluggability mechanism. The core looks adapters up
 * by id here; bundled adapters are registered at `apply` time, and external
 * code can register more without touching the core. This is what keeps the
 * plugin from being locked to one vendor.
 * @module dsh-web-search-extend/core/registry
 */
import type { SearchAdapter } from "../types.js";

export class AdapterRegistry {
	private readonly adapters = new Map<string, SearchAdapter>();

	/** Register an adapter. Returns a disposer that unregisters it. */
	register(adapter: SearchAdapter): () => void {
		this.adapters.set(adapter.id, adapter);
		return () => {
			this.adapters.delete(adapter.id);
		};
	}

	/** Look up an adapter by id. */
	get(id: string): SearchAdapter | undefined {
		return this.adapters.get(id);
	}

	/** Whether an adapter id is registered. */
	has(id: string): boolean {
		return this.adapters.has(id);
	}

	/** All registered adapters (for diagnostics/ui). */
	list(): SearchAdapter[] {
		return [...this.adapters.values()];
	}
}

export class AdapterRegistry {
    adapters = new Map();
    /** Register an adapter. Returns a disposer that unregisters it. */
    register(adapter) {
        this.adapters.set(adapter.id, adapter);
        return () => {
            this.adapters.delete(adapter.id);
        };
    }
    /** Look up an adapter by id. */
    get(id) {
        return this.adapters.get(id);
    }
    /** Whether an adapter id is registered. */
    has(id) {
        return this.adapters.has(id);
    }
    /** All registered adapters (for diagnostics/ui). */
    list() {
        return [...this.adapters.values()];
    }
}
//# sourceMappingURL=registry.js.map
/**
 * The settings card's write path must use the client's real SettingsScope API.
 *
 * Regression: the card called a non-existent `scope.write({op,path,value})`,
 * which the real controller does not implement. The call site swallows its own
 * failure into console.warn, so every control on the card (provider, routeMode,
 * apiKey, per-provider params) silently did nothing while the UI looked fine.
 *
 * `SettingsScopeFake` implements exactly the members the shipped
 * @deepseek-ai/dsh-client-ui-settings controller exposes — getSnapshot,
 * subscribe, mutate, set, unset — and deliberately no others, so a write aimed
 * at a member the API does not have throws a TypeError here just as it does in
 * the browser.
 */
import { describe, expect, it, vi } from "vitest";
import type { SettingsScope, SettingsScopeSnapshot } from "@deepseek-ai/dsh-client-runtime/client";
import { createSettingsAccess } from "../src/ui/settings.js";

type PathOp = { op: "set" | "unset"; path: string[]; value?: unknown };

/** Minimal stand-in for the bound namespace scope (see module doc). */
class SettingsScopeFake implements SettingsScope<Record<string, unknown>> {
    readonly ops: PathOp[] = [];
    readonly listeners = new Set<() => void>();
    readonly state: Record<string, unknown> = { provider: "firecrawl-keyless" };
    readonly snapshot: SettingsScopeSnapshot<Record<string, unknown>> = {
        status: "ready",
        value: this.state,
        base: undefined,
        user: undefined,
        revision: 1,
        writable: true,
        mode: "host",
    };

    private apply(op: PathOp): void {
        if (op.op !== "set") return;
        const [head, ...rest] = op.path;
        if (head === undefined || rest.length > 0) return;
        this.state[head] = op.value;
    }

    getSnapshot(): SettingsScopeSnapshot<Record<string, unknown>> {
        return this.snapshot;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async mutate(ops: readonly PathOp[]): Promise<void> {
        this.ops.push(...ops.map((entry) => ({ ...entry, path: [...entry.path] })));
        // The real controller folds the Host's answer back into the mirror, which
        // republishes every subscriber's snapshot. Without that publication the
        // card keeps rendering the value it read before the write.
        for (const op of ops) this.apply(op);
        for (const listener of this.listeners) listener();
    }

    async set(field: string, value: unknown): Promise<void> {
        await this.mutate([{ op: "set", path: [field], value }]);
    }

    async unset(field: string): Promise<void> {
        await this.mutate([{ op: "unset", path: [field] }]);
    }
}

function access(fake: SettingsScopeFake): ReturnType<typeof createSettingsAccess> {
    return createSettingsAccess({
        bind: <T>() => fake as unknown as SettingsScope<T>,
    });
}

describe("settings card write path", () => {
    it("persists the provider through the scope's path-op API", () => {
        const fake = new SettingsScopeFake();
        access(fake).write(["provider"], "tavily");
        expect(fake.ops).toEqual([{ op: "set", path: ["provider"], value: "tavily" }]);
    });

    it("persists a nested provider parameter as one path-addressed set", () => {
        const fake = new SettingsScopeFake();
        access(fake).write(["tavily", "maxResults"], 7);
        expect(fake.ops).toEqual([{ op: "set", path: ["tavily", "maxResults"], value: 7 }]);
    });

    it("writes without reporting a persistence failure", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
            access(new SettingsScopeFake()).write(["routeMode"], "local-only");
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it("notifies the card and re-reads the switched provider", () => {
        const fake = new SettingsScopeFake();
        const settings = access(fake);
        let notifications = 0;
        settings.subscribe(() => {
            notifications += 1;
        });

        expect(settings.readProvider()).toBe("firecrawl-keyless");
        settings.write(["provider"], "tavily");

        // What the user reported as "no reaction": the card re-renders from the
        // subscription and must then read the NEW provider, not the old one.
        expect(notifications).toBe(1);
        expect(settings.readProvider()).toBe("tavily");
    });
});

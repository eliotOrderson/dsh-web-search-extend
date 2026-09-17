import type { SettingsScope, SettingsScopeSnapshot } from "@deepseek-ai/dsh-client-runtime/client";
import { DEFAULT_PROVIDER, ROUTE_PROVIDER_FIRST, SETTINGS_NAMESPACE } from "./config.js";
import type { SettingsScopeBinder } from "./types.js";

export interface SettingsAccess {
    readValue(path: readonly string[]): unknown;
    readSection(section: string): Record<string, unknown>;
    readProvider(fallback?: string): string;
    readRouteMode(fallback?: string): string;
    write(path: readonly string[], value: unknown): void;
    subscribe(listener: () => void): () => void;
    describeRef(refName: string): Promise<boolean | null>;
}

/**
 * The write surface beyond the published `SettingsScope<T>`: the shipped
 * `SettingsScopeController` implements `mutate`, while this runtime version's
 * typings still carry `set`/`unset` only. `mutate` is the path-addressed form
 * `set` delegates to, and the one nested fields need — a scope has no
 * `write(request)` member, whatever a local interface claims.
 */
interface ScopeWithMutate<T> extends SettingsScope<T> {
    mutate(ops: readonly ScopePathOp[]): Promise<void>;
    describe?(request: { refs: string[] }): Promise<unknown>;
}

interface ScopePathOp {
    op: "set";
    path: string[];
    value: unknown;
}

type SnapshotShape = {
    value?: Record<string, unknown>;
    base?: unknown;
};

export function createSettingsAccess(settingsScope: SettingsScopeBinder): SettingsAccess {
    const scope = settingsScope.bind<Record<string, unknown>>({ namespace: SETTINGS_NAMESPACE }) as ScopeWithMutate<Record<string, unknown>>;

    const snapshot = (): SettingsScopeSnapshot<Record<string, unknown>> | SnapshotShape => {
        try {
            return scope.getSnapshot() ?? {};
        } catch {
            return {};
        }
    };

    const walk = (node: unknown, path: readonly string[]): unknown =>
        path.reduce<unknown>((current, key) => {
            if (current && typeof current === "object" && key in current) return (current as Record<string, unknown>)[key];
            return undefined;
        }, node);

    const readValue = (path: readonly string[]): unknown => {
        const snap = snapshot();
        const override = walk(snap.value, path);
        return override !== undefined ? override : walk(snap.base, path);
    };

    const readSection = (section: string): Record<string, unknown> => {
        const value = readValue([section]);
        return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    };

    const readProvider = (fallback: string = DEFAULT_PROVIDER): string => {
        const value = readValue(["provider"]);
        return typeof value === "string" && value.length > 0 ? value : fallback;
    };

    const readRouteMode = (fallback: string = ROUTE_PROVIDER_FIRST): string => {
        const value = readValue(["routeMode"]);
        return typeof value === "string" && value.length > 0 ? value : fallback;
    };

    const write = (path: readonly string[], value: unknown): void => {
        try {
            void scope.mutate([{ op: "set", path: [...path], value }]).catch((error: unknown) => {
                console.warn("[@mr.robot/dsh-web-search-extend] failed to persist", path.join("."), error);
            });
        } catch (error) {
            console.warn("[@mr.robot/dsh-web-search-extend] failed to persist", path.join("."), error);
        }
    };

    const subscribe = (listener: () => void): (() => void) => scope.subscribe(listener);

    const describeRef = async (refName: string): Promise<boolean | null> => {
        if (scope.describe === undefined) return null;
        try {
            const result = await scope.describe({ refs: [refName] });
            const entry = Array.isArray(result) ? result[0] : result;
            return entry == null ? null : Boolean((entry as Record<string, unknown>).configured ?? (entry as Record<string, unknown>).exists ?? (entry as Record<string, unknown>).set);
        } catch {
            return null;
        }
    };

    return { readValue, readSection, readProvider, readRouteMode, write, subscribe, describeRef };
}

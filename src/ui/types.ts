import type { Context } from "@deepseek-ai/cordis";
import type { SettingsScope } from "@deepseek-ai/dsh-client-runtime/client";
import type { SlotRegistry } from "@deepseek-ai/dsh-client-runtime/client";
import type { StoredEntry, Translate } from "@deepseek-ai/dsh-client-ui-slots";
import type { ComponentType, ReactElement, ReactNode } from "react";

export interface DshClientContext extends Context {
    settingsScope: SettingsScopeBinder;
    locale: LocaleRuntimeLike;
    slots: SlotRegistry;
}

export interface SettingsScopeBinder {
    bind<T>(spec: { namespace: string; decode?: (section: unknown) => T | undefined }): SettingsScope<T>;
}

export interface LocaleRuntimeLike {
    getSnapshot(): { active: string; revision: number };
    subscribe(listener: () => void): () => void;
    bind(namespace: string): Translate;
}

export type { StoredEntry, Translate };

export interface ReactApi {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: ReactNode[]) => ReactElement;
    useState: <T>(initial: T | (() => T)) => [T, (value: T | ((previous: T) => T)) => void];
    useEffect: (effect: () => void | (() => void), dependencies: readonly unknown[]) => void;
}

export interface UiPrimitives {
    IconChevronDownOutline14: ComponentType<{ className?: string }>;
}

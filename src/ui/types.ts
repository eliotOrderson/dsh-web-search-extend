import type { Context } from "@deepseek-ai/cordis";
import type { StoredEntry, Translate } from "@deepseek-ai/dsh-client-ui-slots";
import type { ComponentType, ReactElement, ReactNode } from "react";

export interface DshClientContext extends Context {
    configForms: ConfigFormsLike;
    locale: LocaleRuntimeLike;
    slots: SlotRegistry;
    remote: RemoteLike;
}

/**
 * The subset of the 0.1.7 client `ConfigFormController` this page needs. It is
 * what `ctx.configForms.get(entryId)` returns: its snapshot keeps the same
 * `value`/`base` split the removed `SettingsScope` exposed, so the read path is
 * unchanged from the namespace-keyed era.
 */
export interface ConfigFormAccess {
    getSnapshot(): { value?: Record<string, unknown>; base?: unknown } | undefined;
    subscribe(listener: () => void): () => void;
    mutate(ops: readonly ScopePathOp[]): Promise<boolean>;
}

interface ScopePathOp {
    op: "set" | "unset";
    path: string[];
    value?: unknown;
}

/**
 * The 0.1.7 client settings surface: one form per profile entry id, replacing
 * the namespace-keyed `settingsScope` service the card used to bind.
 */
export interface ConfigFormsLike {
    get(entryId: string): ConfigFormAccess;
    describe(): { getSnapshot(): { view?: { namespaces?: readonly { ns: string }[] } } };
    /** Run `register` while the Host serves at least one of `namespaces`. */
    whileServed(namespaces: readonly string[], register: (served: Set<string>) => (() => void) | void): () => void;
}

export interface RemoteLike {
    credentials: {
        describe(refs: readonly string[]): Promise<{ ok: boolean; value?: Record<string, { configured?: boolean; writable?: boolean }> }>;
        set(ref: string, value: string): Promise<unknown>;
    };
    $on(event: string, listener: (ref: string) => void): () => void;
}

export interface SlotRegistry {
    inject(name: string, callback: () => (() => void) | void): (() => void) | void;
    register(options: Record<string, unknown>, component: unknown): () => void;
    entries(name: string): StoredEntry[];
    subscribe(name: string, listener: () => void): () => void;
}

export interface LocaleRuntimeLike {
    getSnapshot(): { active: string; revision: number };
    subscribe(listener: () => void): () => void;
    bind(namespace: string): Translate;
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void;
}

export type { StoredEntry, Translate };

export interface ReactApi {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: ReactNode[]) => ReactElement;
    useState: <T>(initial: T | (() => T)) => [T, (value: T | ((previous: T) => T)) => void];
    useEffect: (effect: () => void | (() => void), dependencies: readonly unknown[]) => void;
    useRef: <T>(initial: T) => { current: T };
}

/**
 * The settings UI kit the official pages render with. Its field set is
 * text/number/secret only — it ships no select, so a choice control is built
 * from the kit's own Button and Menu rather than from a hand-styled widget.
 */
export interface UiPrimitives {
    IconChevronDownOutlineRegular: ComponentType<{ className?: string }>;
    SettingsForm: ComponentType<Record<string, unknown>>;
    SettingsValueField: ComponentType<Record<string, unknown>>;
    SettingsSecretField: ComponentType<Record<string, unknown>>;
    /** The kit's inline option picker: the only choice control the kit ships. */
    SegmentedControl: ComponentType<{
        id?: string;
        value?: string;
        options: readonly { value: string; label: string }[];
        onChange: (value: string) => void;
        label?: string;
        disabled?: boolean;
    }>;
    /**
     * A hover/focus bubble anchored to one child element. The kit renders a
     * control's visible title through this, because a caption under the row
     * reads as a stray line rather than as that field's explanation.
     */
    Tooltip: ComponentType<{
        label: string;
        side?: "top" | "bottom" | "right";
        delayMs?: number;
        maxWidth?: number;
        portal?: boolean;
        disabled?: boolean;
        children?: ReactNode;
    }>;
    SettingsFormModel: new (
        scope: ConfigFormAccess,
        fields: readonly unknown[],
        writers: readonly { field: string; write: (text: string) => Promise<boolean> }[]
    ) => SettingsFormModelLike;
    settingsTextField: (field: string) => unknown;
    settingsNumberField: (field: string) => unknown;
}

export interface SettingsFormModelLike {
    bind(projection: () => Record<string, unknown>): StoreLike<Record<string, unknown>>;
    shell(): Record<string, unknown>;
    field(name: string): Record<string, unknown>;
    actions(): Record<string, unknown>;
    dispose(): void;
}

export interface StoreLike<T> {
    getSnapshot(): T;
    subscribe(listener: () => void): () => void;
    set(value: T): void;
}

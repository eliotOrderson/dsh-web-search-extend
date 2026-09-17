/**
 * The card's provider drop-down must reach the settings scope.
 *
 * This drives the real component — `createWebSearchCard` and its field
 * factories — instead of a single call site, so the chain the user actually
 * touches is covered: expand the card, change the drop-down, and the scope
 * receives a mutation. A regression anywhere along it (a shadow interface, a
 * renamed control, a drop-down wired to nothing) fails here.
 */
import { describe, expect, it } from "vitest";
import type { SettingsScope, SettingsScopeSnapshot } from "@deepseek-ai/dsh-client-runtime/client";
import { createWebSearchCard } from "../src/ui/card.js";
import { createSettingsAccess } from "../src/ui/settings.js";

type PathOp = { op: "set" | "unset"; path: string[]; value?: unknown };

interface Element {
    type: unknown;
    props: Record<string, unknown>;
}

/**
 * Enough of React for ONE component: a hook cursor, state slots, and effects.
 * `settle` runs the initial effects and re-renders while they set state, which
 * is what expands the card body holding the drop-down.
 */
class HookHarness {
    private readonly states = new Map<number, unknown>();
    private readonly effects = new Map<number, () => void | (() => void)>();
    private cursor = 0;
    private dirty = false;

    readonly createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({
        type,
        props: { ...(props ?? {}), children },
    });

    readonly useState = <T,>(initial: T): [T, (value: T) => void] => {
        const slot = this.cursor++;
        if (!this.states.has(slot)) this.states.set(slot, initial);
        return [
            this.states.get(slot) as T,
            (value: T): void => {
                this.states.set(slot, value);
                this.dirty = true;
            },
        ];
    };

    readonly useEffect = (effect: () => void | (() => void)): void => {
        this.effects.set(this.cursor++, effect);
    };

    /** Render, then run the effects this render registered; re-render if they moved state. */
    settle(render: () => unknown): unknown {
        let tree = render();
        for (let pass = 0; pass < 5; pass += 1) {
            const effects = [...this.effects.values()];
            this.effects.clear();
            for (const effect of effects) effect();
            if (!this.dirty) break;
            this.dirty = false;
            this.cursor = 0;
            tree = render();
        }
        this.cursor = 0;
        return tree;
    }
}

class SettingsScopeFake implements SettingsScope<Record<string, unknown>> {
    readonly ops: PathOp[] = [];
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

    getSnapshot(): SettingsScopeSnapshot<Record<string, unknown>> {
        return this.snapshot;
    }

    subscribe(): () => void {
        return () => undefined;
    }

    async mutate(ops: readonly PathOp[]): Promise<void> {
        this.ops.push(...ops.map((entry) => ({ ...entry, path: [...entry.path] })));
        for (const op of ops) if (op.op === "set" && op.path.length === 1) this.state[op.path[0]!] = op.value;
    }

    async set(field: string, value: unknown): Promise<void> {
        await this.mutate([{ op: "set", path: [field], value }]);
    }

    async unset(field: string): Promise<void> {
        await this.mutate([{ op: "unset", path: [field] }]);
    }
}

function findAll(node: unknown, predicate: (element: Element) => boolean): Element[] {
    if (Array.isArray(node)) return node.flatMap((child) => findAll(child, predicate));
    if (node === null || typeof node !== "object") return [];
    const element = node as Element;
    const matches = typeof element.type === "string" && predicate(element) ? [element] : [];
    return [...matches, ...findAll(element.props?.children, predicate)];
}

/** Translation stub: the card reads it as a callable that also carries `language`. */
function fakeTranslator(): { (key: string): string; language(): string; subscribeLanguage(listener: () => void): () => void } {
    const translate = (key: string): string => key;
    return Object.assign(translate, {
        language: (): string => "en",
        subscribeLanguage: (): (() => void) => () => undefined,
    });
}

/** Render the card and expand it, returning its element tree and the scope it wrote to. */
function renderOpenCard(fake: SettingsScopeFake): { tree: Element; harness: HookHarness } {
    // The card's duplicate-cleanup effect is the only DOM reader; there is no DOM here.
    (globalThis as { document?: unknown }).document = { querySelectorAll: (): unknown[] => [] };
    const harness = new HookHarness();
    const settings = createSettingsAccess({ bind: <T,>() => fake as unknown as SettingsScope<T> });
    const Card = createWebSearchCard(
        harness as never,
        { IconChevronDownOutline14: "svg" } as never,
        settings,
        fakeTranslator() as never,
    );
    const render = (): unknown => (Card as () => unknown)();
    const collapsed = harness.settle(render) as Element;

    const header = findAll(collapsed, (element) => element.type === "button").at(0);
    expect(header).toBeDefined();
    (header!.props.onClick as () => void)();

    return { tree: harness.settle(render) as Element, harness };
}

describe("settings card provider drop-down", () => {
    it("offers the drop-down with the configured provider selected", () => {
        const { tree } = renderOpenCard(new SettingsScopeFake());
        const selects = findAll(tree, (element) => element.type === "select");
        expect(selects.map((element) => element.props.value)).toContain("firecrawl-keyless");
    });

    it("persists the provider the user picks", () => {
        const fake = new SettingsScopeFake();
        const { tree } = renderOpenCard(fake);
        const provider = findAll(tree, (element) => element.type === "select" && element.props.value === "firecrawl-keyless").at(0);
        expect(provider).toBeDefined();

        (provider!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "tavily" } });

        expect(fake.ops).toEqual([{ op: "set", path: ["provider"], value: "tavily" }]);
    });
});

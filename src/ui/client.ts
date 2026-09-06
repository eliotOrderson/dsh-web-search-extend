import type { DshClientContext, ReactApi, StoredEntry, UiPrimitives } from "./types.js";
import { createSettingsAccess } from "./settings.js";
import { createTranslator } from "./i18n.js";
import { createWebSearchCard } from "./card.js";
import { SLOT_NAME, CARD_KEY, CARD_PRIORITY, CARD_ORDER, SETTINGS_NAMESPACE } from "./config.js";

const REGISTRATION_FLAG = "__WSE_CARD_REGISTERED__";

interface ModuleExports {
    inject: string[];
    apply: (ctx: DshClientContext) => void;
}

interface ModuleLoaderRegistration {
    id: string;
    factory: (require: (id: string) => unknown) => ModuleExports;
}

declare global {
    interface Window {
        __ModuleLoader__: { load(registration: ModuleLoaderRegistration): void };
        [key: string]: unknown;
    }
}

window.__ModuleLoader__.load({
    id: "@mr.robot/dsh-web-search-extend",
    factory: (require) => {
        const module: ModuleExports = { inject: [], apply: () => undefined };
        const react = require("react") as ReactApi;
        let ui: UiPrimitives | undefined;
        try {
            ui = require("@deepseek-ai/dsh-client-ui-primitives") as UiPrimitives;
        } catch { /* optional */ }

        module.inject = ["settingsScope", "locale", "slots"];
        module.apply = (ctx: DshClientContext) => {
            const settings = createSettingsAccess(ctx.settingsScope);
            if (!ui) {
                console.warn("[@mr.robot/dsh-web-search-extend] ui primitives unavailable; card chevron requires it");
                return;
            }

            const translate = createTranslator(ctx.locale);
            const Card = createWebSearchCard(react, ui, settings, translate);

            try {
                if (window[REGISTRATION_FLAG]) return;
                window[REGISTRATION_FLAG] = true;

                ctx.slots.inject(SLOT_NAME as never, function* () {
                    yield ctx.slots.register({
                        name: SLOT_NAME as never,
                        key: CARD_KEY,
                        priority: CARD_PRIORITY,
                    } as never, Card as never);
                    yield maintainCardOrder(ctx, CARD_ORDER);
                });
            } catch (error) {
                console.warn("[@mr.robot/dsh-web-search-extend] settings card registration failed", error);
            }
        };
        return module;
    },
});

/**
 * Keep the ledger in the official settings-tab order (Shell, Agent Loop,
 * subagent-model-selection, Web search). The dynamic runner assigns our entry
 * a negative shadow priority, so registration puts it first; every later
 * registration re-sorts the ledger by priority, so each ledger change re-asserts
 * the order here. The tab snapshots its namespace list at publish time and only
 * re-publishes on ledger or settings-mirror changes — sorting alone is invisible
 * to it — so after moving entries we write our own current provider value back
 * once; the mirror update makes the tab re-read the sorted ledger without
 * changing any real setting.
 */
function maintainCardOrder(ctx: DshClientContext, order: readonly string[]): () => void {
    const onLedgerChange = (): void => {
        const entries = ctx.slots.entries(SLOT_NAME as never) as unknown as StoredEntry[];
        const before = entries.map((entry) => entry.options?.key ?? "").join("\u0000");
        entries.sort((left, right) => rankOf(order, left) - rankOf(order, right));
        if (before === entries.map((entry) => entry.options?.key ?? "").join("\u0000")) return;
        try {
            const scope = ctx.settingsScope.bind<Record<string, unknown>>({ namespace: SETTINGS_NAMESPACE });
            const snapshot = scope.getSnapshot() as { value?: Record<string, unknown>; base?: unknown } | undefined;
            const provider = snapshot?.value?.provider ?? (snapshot?.base as Record<string, unknown> | undefined)?.provider;
            if (typeof provider === "string") void scope.set("provider", provider);
        } catch (error) {
            console.warn("[@mr.robot/dsh-web-search-extend] order nudge failed", error);
        }
    };
    const unsubscribe = ctx.slots.subscribe(SLOT_NAME as never, onLedgerChange);
    onLedgerChange();
    return unsubscribe;
}

function rankOf(order: readonly string[], entry: StoredEntry): number {
    const index = order.indexOf(entry.options?.key ?? "");
    return index === -1 ? order.length : index;
}

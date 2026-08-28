import type { DshClientContext, ReactApi, StoredEntry, UiPrimitives } from "./types.js";
import { createSettingsAccess } from "./settings.js";
import { createTranslator } from "./i18n.js";
import { createWebSearchCard } from "./card.js";
import { SLOT_NAME, CARD_KEY, CARD_PRIORITY, CARD_ORDER } from "./config.js";

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
                    reorderCardEntries(ctx, CARD_ORDER);
                });
            } catch (error) {
                console.warn("[@mr.robot/dsh-web-search-extend] settings card registration failed", error);
            }
        };
        return module;
    },
});

function reorderCardEntries(ctx: DshClientContext, order: readonly string[]): void {
    // ConfigurablePluginsTab collects namespaces by walking the live entries
    // array in priority order, so our low-priority entry would render first.
    // The entries array is an internal live reference; reorder it so Shell,
    // Agent Loop, then Web Search match the official settings tab order.
    const entries = ctx.slots.entries(SLOT_NAME as never) as unknown as StoredEntry[];
    entries.sort((left, right) => rankOf(order, left) - rankOf(order, right));
}

function rankOf(order: readonly string[], entry: StoredEntry): number {
    const index = order.indexOf(entry.options?.key ?? "");
    return index === -1 ? order.length : index;
}

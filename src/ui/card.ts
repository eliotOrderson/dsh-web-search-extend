import type { ComponentType, ReactElement, ReactNode } from "react";
import type { SettingsAccess } from "./settings.js";
import type { TranslateKey, Translator } from "./i18n.js";
import type { ReactApi, UiPrimitives } from "./types.js";
import { createProviderField, createRouteModeField, createApiKeyField, createParamFields, HINT_CLASS, type ApiKeyBadge, type FieldDeps } from "./fields.js";
import { DEFAULT_PROVIDER } from "./config.js";
import { FIRECRAWL_API_KEY_ENV, PROVIDER_DEFAULT_API_KEY_ENVS } from "../provider-refs.js";

const CARD_CLASS = "YyYd_a_card";
const CARD_OPEN_CLASS = "YyYd_a_cardOpen";
const HEADER_CLASS = "YyYd_a_header";
const HEAD_TEXT_CLASS = "YyYd_a_headText";
const NAME_CLASS = "YyYd_a_name";
const DESCRIPTION_CLASS = "YyYd_a_description";
const CHEVRON_CLASS = "YyYd_a_chevron";
const CHEVRON_OPEN_CLASS = "YyYd_a_chevronOpen";
const BODY_CLASS = "YyYd_a_body";
const BODY_STYLE = { display: "flex", flexDirection: "column" };
const CARD_SELECTOR = "[data-wse-card]";
const BADGE_CLASS = "At1oFq_badge";
const BADGE_MUTED_CLASS = "At1oFq_badgeMuted";

export function createWebSearchCard(react: ReactApi, ui: UiPrimitives, settings: SettingsAccess, translate: Translator): ComponentType {
    const h = react.createElement;
    const deps: FieldDeps = { h, settings, translate };

    function WebSearchExtendCard(): ReactElement {
        const [, setState] = react.useState(0);
        const [lang, setLang] = react.useState(translate.language());
        const [configured, setConfigured] = react.useState<boolean | null>(null);
        const [open, setOpen] = react.useState(false);

        react.useEffect(() => {
            const cards = [...document.querySelectorAll(CARD_SELECTOR)];
            if (cards.length > 1) {
                for (const extra of cards.slice(1)) {
                    const host = extra.closest("li") ?? extra.parentElement;
                    host?.remove();
                }
            }
        }, []);

        react.useEffect(() => {
            let unsubscribe: (() => void) | undefined;
            let unsubscribeLanguage: (() => void) | undefined;
            warnOnError("settings subscription", () => { unsubscribe = settings.subscribe(() => setState((value) => value + 1)); });
            warnOnError("locale subscription", () => { unsubscribeLanguage = translate.subscribeLanguage(() => setLang(translate.language())); });
            return () => {
                warnOnError("settings unsubscribe", () => unsubscribe?.());
                warnOnError("locale unsubscribe", () => unsubscribeLanguage?.());
            };
        }, []);

        const provider = settings.readProvider();
        const t: TranslateKey = (key) => translate(key, lang);

        react.useEffect(() => {
            let live = true;
            const ref = apiKeyRef(provider);
            settings.describeRef(ref).then((value) => { if (live) setConfigured(value); });
            return () => { live = false; };
        }, [provider]);

        const badge: ApiKeyBadge = createApiKeyBadge(t, provider, configured);
        const providerField = createProviderField(deps);
        const routeModeField = createRouteModeField(deps);
        const apiKeyField = createApiKeyField(deps, badge);
        const paramFields = createParamFields(deps, provider);

        const bodyChildren: ReactNode[] = [
            providerField,
            routeModeField,
            apiKeyField,
            ...paramFields,
            provider === DEFAULT_PROVIDER
                ? h("p", { className: HINT_CLASS }, t("keylessNote"))
                : null,
        ];

        return h("li", {
            "data-wse-card": "",
            className: open ? `${CARD_CLASS} ${CARD_OPEN_CLASS}` : CARD_CLASS,
        }, [
            h("button", {
                type: "button",
                className: HEADER_CLASS,
                "aria-expanded": open,
                onClick: () => setOpen(!open),
            }, [
                h("span", { className: HEAD_TEXT_CLASS }, [
                    h("span", { className: NAME_CLASS }, t("cardTitle")),
                    h("span", { className: DESCRIPTION_CLASS }, t("cardDescription")),
                ]),
                createChevron(h, ui, open),
            ]),
            open ? h("div", { className: BODY_CLASS, style: BODY_STYLE }, bodyChildren) : null,
        ]);
    }

    return WebSearchExtendCard;
}

function apiKeyRef(provider: string): string {
    return PROVIDER_DEFAULT_API_KEY_ENVS[provider] ?? FIRECRAWL_API_KEY_ENV;
}

const UNCONFIGURED_BADGE_KEY: Record<string, string> = {
    "firecrawl-keyless": "badge_firecrawl_keyless",
    tavily: "badge_tavily",
    deepseek: "badge_deepseek",
};

function createApiKeyBadge(t: (key: string) => string, provider: string, configured: boolean | null): ApiKeyBadge {
    // Unknown provider: deepseek's copy is the only provider-agnostic "key not
    // configured yet" text, so it doubles as the map fallback.
    const text = configured === true ? t("badge_configured") : t(UNCONFIGURED_BADGE_KEY[provider] ?? "badge_deepseek");
    const className = configured === true ? BADGE_CLASS : BADGE_MUTED_CLASS;
    return { text, className };
}

function warnOnError(scope: string, action: () => void): void {
    try {
        action();
    } catch (error) {
        console.warn(`[@mr.robot/dsh-web-search-extend] ${scope} failed`, error);
    }
}

function createChevron(h: ReactApi["createElement"], ui: UiPrimitives, open: boolean): ReactElement {
    const className = open ? `${CHEVRON_CLASS} ${CHEVRON_OPEN_CLASS}` : CHEVRON_CLASS;
    return h(ui.IconChevronDownOutline14, { className });
}

import type {
    ConfigFormsLike,
    DshClientContext,
    ReactApi,
    SettingsFormModelLike,
    StoreLike,
    UiPrimitives,
} from "./types.js";
import { DICTIONARY } from "./i18n.js";
import {
    BUNDLE_PACKAGE,
    ENTRY_IDS,
    DEFAULT_ENTRY_ID,
    PROVIDERS,
    ROUTE_OPTIONS,
    FIELD_SPECS,
    DEFAULT_PROVIDER,
} from "./config.js";
import { FIRECRAWL_API_KEY_ENV } from "../provider-refs.js";

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
    }
}

/** Dictionary namespace this page owns. */
const NS = "settings.webSearchExtend";
/** Credential reference used when the config names none. */
const DEFAULT_API_KEY_REF = FIRECRAWL_API_KEY_ENV;
/** Form field the credential control stages under; not a config key on the Host. */
const API_KEY_FIELD = "apiKey";
/** Top-level fields the form stages straight onto the entry's config. */
const TEXT_FIELDS = ["provider", "routeMode", "baseURL"] as const;
/** Synthetic field prefix for a provider subsection value, e.g. `param.tavily.maxResults`. */
const PARAM_PREFIX = "param";
/**
 * Staged text for an option whose real value is the empty string.
 *
 * The form model drops any custom-writer field staged as empty text — that is
 * what keeps the key control's "leave blank to keep the current key" promise —
 * so an "unrestricted" choice has to travel as a token and be turned back into
 * an unset on the way out.
 */
const EMPTY_OPTION = "__none__";

window.__ModuleLoader__.load({
    id: BUNDLE_PACKAGE,
    factory: (require) => {
        const module: ModuleExports = { inject: [], apply: () => undefined };
        const react = require("react") as ReactApi;
        const ui = require("@deepseek-ai/dsh-client-ui-primitives") as UiPrimitives;
        const h = react.createElement;

        const formLabels = (t: (key: string) => string) => ({
            unavailable: t("unavailable"),
            readOnly: t("readOnly"),
            saveFailed: t("saveFailed"),
            save: t("save"),
            saving: t("saving"),
        });

        const paramFieldName = (provider: string, key: string): string => `${PARAM_PREFIX}.${provider}.${key}`;

        interface ChoiceOption {
            value: string;
            label: string;
        }

        interface ChoiceProps {
            id: string;
            label: string;
            hint?: string;
            value: string;
            options: readonly ChoiceOption[];
            disabled?: boolean;
            onChange: (value: string) => void;
        }

        /**
         * The kit paints the bubble's background from the theme's tooltip token
         * but its label from the shell's static white constant, and it never
         * reads `--dsw-alias-tooltip-fg`. A theme is free to make the bubble
         * light — the mint skin does in dark mode — which leaves white on white
         * at about 1.05:1. Re-pointing that constant hands the label to the
         * theme's own tooltip foreground, and keeps the shell's white in a
         * deployment whose theme names none.
         */
        const TOOLTIP_LABEL_STYLE = { "--dsw-static-neutral-bluish-00": "var(--dsw-alias-tooltip-fg, #fff)" };

        /**
         * One option picker: the kit's segmented control under a visible title.
         * The kit renders its `label` as an accessible name only, so the row
         * draws its own title and keeps the explanation in a hover bubble
         * instead of a caption the control sits under. The bubble hangs on the
         * whole row: anchored to the title alone it never fires while the
         * control is hovered and only appears once the pointer crosses the
         * title on its way out of the field.
         */
        function ChoiceField(props: ChoiceProps): unknown {
            const row = h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", marginBottom: "10px" } },
                h("span", {
                    style: {
                        fontSize: "13px",
                        fontWeight: 500,
                        lineHeight: 1.5,
                        color: "var(--dsw-alias-label-primary)",
                    },
                }, props.label),
                h(ui.SegmentedControl, {
                    id: props.id,
                    label: props.label,
                    value: props.value,
                    options: props.options,
                    disabled: props.disabled === true,
                    onChange: props.onChange,
                }),
            );
            if (props.hint === undefined) return row;
            // The bubble is a sibling of the anchor, so the label token has to
            // sit on a wrapper that holds both.
            return h("div", { style: TOOLTIP_LABEL_STYLE },
                h(ui.Tooltip, { label: props.hint, side: "top", delayMs: 120, maxWidth: 320 }, row));
        }

        interface CardState extends Record<string, unknown> {
            writable?: boolean;
            provider?: { text?: string };
            apiKey?: { text?: string };
            apiKeyConfigured?: boolean;
            apiKeyWritable?: boolean;
            params?: Record<string, { value?: unknown; overridden?: boolean }>;
        }

        interface CardProps {
            view: "summary" | "page";
            t: (key: string) => string;
            useWebSearchCard: (select: (state: CardState) => CardState) => CardState;
            save: () => void;
            discard: () => void;
            edit: (field: string, value: string) => void;
            resetField: (field: string) => void;
            /** Drop one provider subsection override, restoring the schema default. */
            clearParam: (field: string) => void;
        }

        /**
         * Render the one-liner or the settings form, as the Plugins page asks.
         * Controls come from the deployment's own settings kit wherever the kit
         * has one, so the page keeps the styling every other plugin page has.
         */
        function WebSearchCard(props: CardProps) {
            const { t } = props;
            const state = props.useWebSearchCard((snapshot) => snapshot);
            if (props.view === "summary") return t("cardDescription");
            const disabled = !state.writable;

            const valueField = (field: string, label: string, hint: string | undefined) =>
                h(ui.SettingsValueField, {
                    id: `plugin-config-wse-${field}`,
                    label,
                    hint,
                    overriddenLabel: t("overridden"),
                    resetLabel: t("reset"),
                    invalidLabel: t("invalidNumber"),
                    disabled,
                    ...(state[field] as Record<string, unknown>),
                    onEdit: (text: string) => props.edit(field, text),
                    onReset: () => props.resetField(field),
                });

            const choiceField = (
                field: string,
                label: string,
                options: readonly ChoiceOption[],
                current: string,
                hint?: string,
            ) => h(ChoiceField, {
                id: `plugin-config-wse-${field}`,
                label,
                hint,
                disabled,
                options,
                value: current,
                onChange: (next: string) => props.edit(field, next),
            });

            const provider = stagedText(state.provider) || DEFAULT_PROVIDER;
            const params = state.params ?? {};
            const paramFields = (FIELD_SPECS[provider] ?? []).map((spec) => {
                const field = paramFieldName(provider, spec.key);
                const entry = params[field] ?? {};
                const current = entry.value === undefined || entry.value === null ? "" : String(entry.value);
                const label = t(`${provider}.${spec.key}.label`);
                const hint = hintFor(t, `${provider}.${spec.key}.hint`);
                if (spec.type === "select") {
                    return choiceField(
                        field,
                        label,
                        (spec.options ?? []).map((option) => ({
                            value: option === "" ? EMPTY_OPTION : option,
                            label: option === "" ? t("optionAny") : capitalizeLabel(option),
                        })),
                        current === "" ? EMPTY_OPTION : current,
                        hint,
                    );
                }
                if (spec.type === "bool") {
                    return choiceField(field, label, [
                        { value: "true", label: t("bool_on") },
                        { value: "false", label: t("bool_off") },
                    ], current === "" ? String(spec.default ?? false) : current, hint);
                }
                return h(ui.SettingsValueField, {
                    id: `plugin-config-wse-${field}`,
                    label,
                    hint,
                    overriddenLabel: t("overridden"),
                    resetLabel: t("reset"),
                    invalidLabel: t("invalidNumber"),
                    disabled,
                    text: current,
                    overridden: entry.overridden === true,
                    invalid: false,
                    ...(spec.type === "number" ? { numeric: true } : {}),
                    onEdit: (text: string) => props.edit(field, text),
                    onReset: () => props.clearParam(field),
                });
            });

            return h(
                ui.SettingsForm,
                { labels: formLabels(t), state, onSave: props.save, onDiscard: props.discard },
                h(ui.SettingsSecretField, {
                    id: "plugin-config-wse-key",
                    label: t("apiKeyLabel"),
                    hint: hintFor(t, "apiKeyHint"),
                    disabled: !state.apiKeyWritable,
                    text: state.apiKey?.text,
                    configured: state.apiKeyConfigured,
                    stateLabel: state.apiKeyConfigured ? t("apiKeySet") : t("apiKeyUnset"),
                    onEdit: (text: string) => props.edit(API_KEY_FIELD, text),
                }),
                choiceField(
                    "provider",
                    t("providerLabel"),
                    PROVIDERS.map((option) => ({ value: option.value, label: t(option.labelKey) })),
                    provider,
                ),
                choiceField(
                    "routeMode",
                    t("routeModeLabel"),
                    ROUTE_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) })),
                    stagedText(state.routeMode),
                    hintFor(t, "routeModeHint"),
                ),
                ...paramFields,
                valueField("baseURL", t("baseUrlLabel"), hintFor(t, "baseUrlHint")),
            );
        }

        /** The staged text of one field value, or the empty string. */
        function stagedText(field: unknown): string {
            const text = (field as { text?: unknown } | undefined)?.text;
            return typeof text === "string" ? text : "";
        }

        /** Present a stored option token the way the labels are written (Basic, Ultra-Fast). */
        function capitalizeLabel(option: string): string {
            return option.replace(/(^|[\s-])[a-z]/g, (match) => match.toUpperCase());
        }

        /**
         * The translated hint for a key, or nothing when the dictionary has no
         * entry. The locale service answers a missing key with the key itself,
         * so an absent entry has to be turned into an absent hint here.
         */
        function hintFor(t: (key: string) => string, key: string): string | undefined {
            const text = t(key);
            return text === key ? undefined : text;
        }

        /**
         * The page's staged form over this plugin's config entry.
         *
         * Two kinds of fields: the top-level scalars go through the model's own
         * text specs, while the key and every provider subsection value are
         * custom writers — the model writes a spec field as the single-segment
         * path `[field]`, which cannot reach `tavily.maxResults`.
         */
        class WebSearchCardController {
            private readonly scope;
            private readonly ctx;
            private readonly form: SettingsFormModelLike;
            private readonly store: StoreLike<Record<string, unknown>>;
            private readonly unsubscribe: () => void;
            private credential = { ref: "", configured: false, writable: true };

            constructor(scope: ConfigFormsLike extends { get(id: string): infer F } ? F : never, ctx: DshClientContext) {
                this.scope = scope;
                this.ctx = ctx;
                const paramWriters = Object.entries(FIELD_SPECS).flatMap(([provider, specs]) =>
                    specs.map((spec) => ({
                        field: paramFieldName(provider, spec.key),
                        write: (text: string) => this.writeParam(provider, spec, text),
                    })),
                );
                this.form = new ui.SettingsFormModel(
                    scope,
                    TEXT_FIELDS.map((field) => ui.settingsTextField(field)),
                    [{ field: API_KEY_FIELD, write: (text: string) => this.writeKey(text) }, ...paramWriters],
                );
                this.store = this.form.bind(() => this.projection());
                this.unsubscribe = scope.subscribe(() => {
                    void this.readCredential();
                });
                void this.readCredential();
            }

            private projection(): Record<string, unknown> {
                const provider = this.effectiveProvider();
                const fields = Object.fromEntries(TEXT_FIELDS.map((field) => [field, this.form.field(field)]));
                const params = Object.fromEntries((FIELD_SPECS[provider] ?? []).map((spec) => {
                    const field = paramFieldName(provider, spec.key);
                    const staged = stagedText(this.form.field(field));
                    const stored = this.subsectionValue(provider, spec.key);
                    return [field, {
                        value: staged.length > 0 ? staged : stored ?? spec.default,
                        overridden: stored !== undefined,
                    }];
                }));
                return {
                    ...this.form.shell(),
                    ...fields,
                    [API_KEY_FIELD]: this.form.field(API_KEY_FIELD),
                    params,
                    apiKeyConfigured: this.credential.configured,
                    apiKeyWritable: this.credential.writable,
                };
            }

            /** The provider the entry currently resolves to (staged edits land after save). */
            private currentProvider(): string {
                const snapshot = this.snapshot();
                const value = snapshot.value?.provider ?? snapshot.base?.provider;
                return typeof value === "string" && value.length > 0 ? value : DEFAULT_PROVIDER;
            }

            /**
             * The provider whose subsection the page shows: the staged selection
             * first, so picking a provider reveals its parameters before the save
             * commits the switch, then the committed one.
             */
            private effectiveProvider(): string {
                const staged = stagedText(this.form.field("provider"));
                return staged.length > 0 ? staged : this.currentProvider();
            }

            private snapshot(): { value?: Record<string, unknown>; base?: Record<string, unknown> } {
                try {
                    return (this.scope.getSnapshot() ?? {}) as never;
                } catch {
                    return {};
                }
            }

            private subsectionValue(provider: string, key: string): unknown {
                const snapshot = this.snapshot();
                const fromUser = (snapshot.value?.[provider] as Record<string, unknown> | undefined)?.[key];
                if (fromUser !== undefined) return fromUser;
                return (snapshot.base?.[provider] as Record<string, unknown> | undefined)?.[key];
            }

            /**
             * Ask the credentials domain about the reference the section names.
             *
             * The answer is stored with the reference it describes: the reference
             * can change between the request and its response, so a response is
             * published only while it still answers for the reference in force.
             */
            private async readCredential(): Promise<void> {
                const ref = refOf(this.snapshot());
                if (ref !== this.credential.ref) {
                    this.credential = { ref, configured: false, writable: true };
                    this.store.set(this.projection());
                }
                const response = await this.ctx.remote.credentials.describe([ref]);
                if (!response.ok || ref !== refOf(this.snapshot())) return;
                const view = response.value?.[ref];
                const next = { ref, configured: view?.configured ?? false, writable: view?.writable ?? true };
                if (next.configured === this.credential.configured && next.writable === this.credential.writable) return;
                this.credential = next;
                this.store.set(this.projection());
            }

            /** Re-read after the Host reports a change to the reference this page watches. */
            refreshCredential(ref: string): void {
                if (ref !== this.credential.ref) return;
                void this.readCredential();
            }

            /** Build the face the page's slot registration injects. */
            inject(): Record<string, unknown> {
                return {
                    hooks: { webSearchCard: this.store },
                    ...this.form.actions(),
                    // The model's own resetField runs `spec(field)`, which only
                    // knows the text specs, so a subsection value needs its own.
                    clearParam: (field: string) => {
                        void this.clearParam(field);
                    },
                };
            }

            /** Drop one provider subsection override so the schema default applies again. */
            private async clearParam(field: string): Promise<boolean> {
                const [, provider, key] = field.split(".");
                if (provider === undefined || provider.length === 0 || key === undefined) return false;
                return await this.scope.mutate([{ op: "unset", path: [provider, key] }]);
            }

            /** Write one staged provider subsection value to its nested path. */
            private async writeParam(
                provider: string,
                spec: { key: string; type: string },
                text: string,
            ): Promise<boolean> {
                const trimmed = text.trim();
                if (trimmed === EMPTY_OPTION) {
                    // "Unrestricted" is the schema default, so drop the override
                    // rather than storing an empty string the resolver must read back.
                    return await this.scope.mutate([{ op: "unset", path: [provider, spec.key] }]);
                }
                let value: unknown = trimmed;
                if (spec.type === "number") {
                    const parsed = Number(trimmed);
                    if (trimmed.length === 0 || !Number.isFinite(parsed)) return false;
                    value = parsed;
                } else if (spec.type === "bool") {
                    value = trimmed === "true";
                }
                return await this.scope.mutate([{ op: "set", path: [provider, spec.key], value }]);
            }

            /** Write the staged key, then re-read whether the Host now holds one. */
            private async writeKey(value: string): Promise<boolean> {
                await this.ctx.remote.credentials.set(refOf(this.snapshot()), value);
                await this.readCredential();
                return this.credential.configured;
            }

            dispose(): void {
                this.unsubscribe();
                this.form.dispose();
            }
        }

        /** The credential reference the section names, or the provider's default. */
        function refOf(snapshot: { value?: Record<string, unknown> } | undefined): string {
            const declared = snapshot?.value?.apiKeyEnv;
            return typeof declared === "string" && declared.length > 0 ? declared : DEFAULT_API_KEY_REF;
        }

        module.inject = ["slots", "locale", "remote", "remote.credentials", "configForms"];
        module.apply = (ctx: DshClientContext) => {
            const t = ctx.locale.bind(NS);
            ctx.effect(() => ctx.locale.register(NS, DICTIONARY), "web-search-extend: dictionaries");
            // The page registers into the Plugins page's `plugins.item` slot while
            // the Host serves the entry, so a deployment without the entry shows
            // no trace of the card.
            ctx.effect(() => ctx.configForms.whileServed(ENTRY_IDS, (served) => {
                const entryId = ENTRY_IDS.find((id) => served.has(id)) ?? DEFAULT_ENTRY_ID;
                const card = new WebSearchCardController(ctx.configForms.get(entryId), ctx);
                const offSlot = ctx.slots.inject("plugins.item", () => ctx.slots.register({
                    name: "plugins.item",
                    id: "web-search",
                    order: 40,
                    label: () => t("cardTitle"),
                    locale: NS,
                    inject: () => card.inject(),
                }, WebSearchCard));
                const offCredential = ctx.remote.$on("credentials/reference-updated", (ref) => card.refreshCredential(ref));
                return () => {
                    offCredential();
                    offSlot?.();
                    card.dispose();
                };
            }), "web-search-extend: page");
        };
        return module;
    },
});

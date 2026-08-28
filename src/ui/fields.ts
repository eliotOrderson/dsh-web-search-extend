import type { ReactNode } from "react";
import type { SettingsAccess } from "./settings.js";
import type { FieldSpec } from "./config.js";
import { PROVIDERS, ROUTE_OPTIONS, FIELD_SPECS } from "./config.js";
import type { TranslateKey } from "./i18n.js";

type CreateElement = (type: unknown, props: Record<string, unknown> | null, ...children: ReactNode[]) => ReactNode;

const FIELD_CLASS = "At1oFq_field";
const HEAD_CLASS = "At1oFq_head";
const LABEL_CLASS = "At1oFq_label";
export const HINT_CLASS = "At1oFq_hint";
const INPUT_CLASS = "At1oFq_input";
const BADGES_CLASS = "At1oFq_badges";
const ROW_CLASS = "At1oFq_row";
const ROW_STYLE = { display: "flex", alignItems: "center", gap: "8px" };
const BOOL_LABEL_STYLE = { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" };

export interface ApiKeyBadge {
    text: string;
    className: string;
}

export interface FieldDeps {
    h: CreateElement;
    settings: SettingsAccess;
    translate: TranslateKey;
}

export function createFieldElement(h: CreateElement, labelText: string, controls: ReactNode[], hintText?: string): ReactNode {
    return h("div", { className: FIELD_CLASS }, [
        h("div", { className: HEAD_CLASS }, [
            h("label", { className: LABEL_CLASS }, labelText),
        ]),
        ...controls,
        hintText ? h("p", { className: HINT_CLASS }, hintText) : null,
    ]);
}

export function createProviderField(deps: FieldDeps): ReactNode {
    const { h, settings, translate } = deps;
    const provider = settings.readProvider();
    const options = PROVIDERS.map((item) =>
        h("option", { key: item.value, value: item.value }, translate(item.labelKey)),
    );
    const select = h("select", {
        className: INPUT_CLASS,
        value: provider,
        onChange: (event: { target: { value: string } }) => settings.write(["provider"], event.target.value),
    }, options);
    return createFieldElement(h, translate("providerLabel"), [select], translate("providerHint"));
}

export function createRouteModeField(deps: FieldDeps): ReactNode {
    const { h, settings, translate } = deps;
    const routeMode = settings.readRouteMode();
    const options = ROUTE_OPTIONS.map((item) =>
        h("option", { key: item.value, value: item.value }, translate(item.labelKey)),
    );
    const select = h("select", {
        className: INPUT_CLASS,
        value: routeMode,
        onChange: (event: { target: { value: string } }) => settings.write(["routeMode"], event.target.value),
    }, options);
    return createFieldElement(h, translate("routeModeLabel"), [select]);
}

export function createApiKeyField(deps: FieldDeps, badge: ApiKeyBadge): ReactNode {
    const { h, settings, translate } = deps;
    const input = h("input", {
        className: INPUT_CLASS,
        type: "password",
        autoComplete: "off",
        onChange: (event: { target: { value: string } }) => settings.write(["apiKey"], event.target.value),
    });
    const head = h("div", { className: HEAD_CLASS }, [
        h("label", { className: LABEL_CLASS }, translate("apiKeyLabel")),
        h("span", { className: BADGES_CLASS }, [
            h("span", { className: badge.className }, badge.text),
        ]),
    ]);
    return h("div", { className: FIELD_CLASS }, [
        head,
        input,
        h("p", { className: HINT_CLASS }, translate("apiKeyHint")),
    ]);
}

export function createParamFields(deps: FieldDeps, provider: string): ReactNode[] {
    const { h, settings, translate } = deps;
    const specs = FIELD_SPECS[provider] ?? [];
    return specs.map((spec) => {
        const value = settings.readValue([provider, spec.key]);
        const shown = normalizeShown(spec, value);
        const control = createParamControl(deps, { provider, spec, shown });
        return createFieldElement(h, translate(`${provider}.${spec.key}.label`), [control], translate(`${provider}.${spec.key}.hint`));
    });
}

function capitalizeLabel(option: string): string {
    return option.replace(/(^|[\s-])[a-z]/g, (match) => match.toUpperCase());
}

function normalizeShown(spec: FieldSpec, value: unknown): string | number | boolean {
    if (value === undefined || value === null) return spec.default ?? "";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    return String(value);
}

interface ParamField {
    provider: string;
    spec: FieldSpec;
    shown: string | number | boolean;
}

function createParamControl(deps: FieldDeps, { provider, spec, shown }: ParamField): ReactNode {
    const { h, settings, translate } = deps;
    if (spec.type === "select") {
        return h("select", {
            className: INPUT_CLASS,
            value: String(shown),
            onChange: (event: { target: { value: string } }) => settings.write([provider, spec.key], event.target.value),
        }, (spec.options ?? []).map((option) => h("option", { key: option, value: option }, capitalizeLabel(option))));
    }

    if (spec.type === "bool") {
        return h("div", { className: ROW_CLASS, style: ROW_STYLE }, [
            h("input", {
                type: "checkbox",
                checked: Boolean(shown),
                onChange: (event: { target: { checked: boolean } }) => settings.write([provider, spec.key], event.target.checked),
            }),
            h("span", { style: BOOL_LABEL_STYLE }, shown ? translate("bool_on") : translate("bool_off")),
        ]);
    }

    return h("input", {
        className: INPUT_CLASS,
        type: "text",
        inputMode: spec.type === "number" ? "numeric" : undefined,
        defaultValue: String(shown),
        key: `${provider}.${spec.key}`,
        onBlur: (event: { target: { value: string } }) => {
            if (spec.type === "number") {
                const raw = event.target.value.trim();
                if (raw === "") {
                    const fallback = normalizeNumericDefault(spec.default);
                    if (fallback !== undefined) settings.write([provider, spec.key], fallback);
                    return;
                }
                const parsed = Number(raw);
                if (!Number.isFinite(parsed) || parsed < 1) {
                    event.target.value = String(shown);
                    return;
                }
                settings.write([provider, spec.key], parsed);
                event.target.value = String(parsed);
                return;
            }
            settings.write([provider, spec.key], event.target.value.trim());
        },
    });
}

function normalizeNumericDefault(value: string | number | boolean | undefined): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return undefined;
}

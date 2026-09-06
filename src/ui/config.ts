export interface ProviderOption {
    value: string;
    labelKey: string;
}

export interface RouteOption {
    value: string;
    labelKey: string;
}

export type FieldType = "select" | "number" | "bool" | "text";

export interface FieldSpec {
    key: string;
    type: FieldType;
    options?: readonly string[];
    default?: string | number | boolean;
}

export const PROVIDERS: readonly ProviderOption[] = [
    { value: "tavily", labelKey: "provider_tavily" },
    { value: "firecrawl-keyless", labelKey: "provider_firecrawl_keyless" },
    { value: "deepseek", labelKey: "provider_deepseek" },
];

export const DEFAULT_PROVIDER = "firecrawl-keyless";
export const ROUTE_PROVIDER_FIRST = "provider-first";
export const ROUTE_LOCAL_ONLY = "local-only";

export const ROUTE_OPTIONS: readonly RouteOption[] = [
    { value: ROUTE_LOCAL_ONLY, labelKey: "route_local_only" },
    { value: ROUTE_PROVIDER_FIRST, labelKey: "route_provider_first" },
];

export const FIELD_SPECS: Record<string, readonly FieldSpec[]> = {
    "firecrawl-keyless": [],
    tavily: [
        { key: "searchDepth", type: "select", options: ["basic", "advanced", "fast", "ultra-fast"], default: "basic" },
        { key: "topic", type: "select", options: ["general", "news", "finance"], default: "general" },
        { key: "maxResults", type: "number", default: 5 },
        { key: "includeAnswer", type: "bool", default: true },
        { key: "timeRange", type: "text", default: "" },
        { key: "extractDepth", type: "select", options: ["basic", "advanced"], default: "basic" },
        { key: "researchModel", type: "select", options: ["auto", "mini", "pro"], default: "auto" },
    ],
    deepseek: [
        { key: "maxTokens", type: "number", default: 4096 },
        { key: "maxUses", type: "number", default: 5 },
    ],
};

export const SETTINGS_NAMESPACE = "web-search-deepseek";
export const SLOT_NAME = "settings.plugin.item";
export const CARD_KEY = "web-search-deepseek";
export const CARD_PRIORITY = -1;
/** Ledger order matching the official settings tab (Shell, Agent Loop, subagent-model-selection, Web search). */
export const CARD_ORDER: readonly string[] = ["shell", "agent-loop", "subagent-model-selection", "web-search-deepseek"];

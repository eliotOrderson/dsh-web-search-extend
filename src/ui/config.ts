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
        { key: "includeAnswer", type: "bool", default: false },
        { key: "timeRange", type: "select", options: ["", "day", "week", "month", "year"], default: "" },
        { key: "extractDepth", type: "select", options: ["basic", "advanced"], default: "basic" },
        { key: "researchModel", type: "select", options: ["auto", "mini", "pro"], default: "auto" },
    ],
    deepseek: [
        { key: "maxTokens", type: "number", default: 4096 },
        { key: "maxUses", type: "number", default: 5 },
    ],
};

/**
 * Bundle package name. 0.1.7 keys `plugins.bundle.config` by the bundle's
 * package name, and renders the cell on that bundle's Plugins page between its
 * description and its rows — the seat the removed `settings.plugin.item` card
 * used to occupy.
 */
export const BUNDLE_PACKAGE = "@mr.robot/dsh-web-search-extend";
/** Candidate Host entry ids carrying this plugin's config; the first served one wins. */
export const ENTRY_IDS: readonly string[] = ["dsh-web-search-extend", "web-search-deepseek"];
/** Used when the served directory cannot be read (mirror not loaded yet). */
export const DEFAULT_ENTRY_ID = "dsh-web-search-extend";
export const SLOT_NAME = "plugins.bundle.config";

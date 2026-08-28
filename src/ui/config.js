export const PROVIDERS = [
	{ value: "tavily", labelKey: "provider_tavily" },
	{ value: "firecrawl-keyless", labelKey: "provider_firecrawl_keyless" },
	{ value: "deepseek", labelKey: "provider_deepseek" },
];

export const DEFAULT_PROVIDER = "firecrawl-keyless";
export const ROUTE_PROVIDER_FIRST = "provider-first";
export const ROUTE_LOCAL_ONLY = "local-only";
export const ROUTE_OPTIONS = [
	{ value: ROUTE_LOCAL_ONLY, labelKey: "route_local_only" },
	{ value: ROUTE_PROVIDER_FIRST, labelKey: "route_provider_first" },
];

export const PROVIDER_MARKER = "data-wse-provider";
export const PARAMS_MARKER = "data-wse-params";

// Field specs mirror the zod subsections in src/config.ts. Defaults MUST
// stay aligned with those schema defaults (see AGENTS.md DRIFT RULE).
// type: select | number | bool | text ; label/hint keys resolve via I18N.
export const FIELD_SPECS = {
	"firecrawl-keyless": [],
	tavily: [
		{ key: "searchDepth", type: "select", options: ["basic", "advanced", "fast", "ultra-fast"], default: "basic" },
		{ key: "topic", type: "select", options: ["general", "news", "finance"], default: "general" },
		{ key: "maxResults", type: "number", default: 5 },
		{ key: "includeAnswer", type: "bool", default: false },
		{ key: "timeRange", type: "text", default: "" },
		{ key: "extractDepth", type: "select", options: ["basic", "advanced"], default: "basic" },
		{ key: "researchModel", type: "select", options: ["auto", "mini", "pro"], default: "auto" },
	],
	deepseek: [
		// model / apiVersion are wire-level internals consumed by the
		// Anthropic-compatible call (body.model / anthropic-version header);
		// kept in the schema for compatibility, deliberately NOT on the card.
		{ key: "maxTokens", type: "number", default: 4096 },
		{ key: "maxUses", type: "number", default: 5 },
	],
};

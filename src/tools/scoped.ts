/**
 * The model-facing `web_search_scoped` tool: a search whose FILTERS are named
 * explicitly by the caller and compiled into the active provider's native
 * parameter language by deterministic code (see `core/hints.ts`).
 *
 * Why a separate tool instead of parameters on `web_search`: that tool is the
 * seam's own, its signature is `{ query, maxResults? }`, and widening it would
 * change the agent-facing surface this plugin exists to leave alone. A sibling
 * tool carries the intent without touching it.
 *
 * Why the model supplies the filters instead of us parsing the query: the
 * caller already understood what was asked when it decided to call this tool,
 * so asking for the filter costs no extra inference. Inferring it from query
 * text would be a guess — and a guess that silently narrows a search is a guess
 * the caller cannot see. The compilation that remains is mechanical translation
 * (`timeRange: "week"` is `time_range` to one vendor and `tbs=qdr:w` to
 * another) and its RESULT is always reported back, so an unexpressible filter
 * is visible rather than quietly dropped.
 * @module dsh-web-search-extend/tools/scoped
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import type { WebSearchResult } from "@deepseek-ai/dsh-web";
import type { AdapterRuntime, SearchAdapter } from "../types.js";
import type { CompiledHints, SearchHints } from "../core/hints.js";
import { compileHints, compileHintsForChain, normalizeTimeRange } from "../core/hints.js";
import { DEFAULT_WEB_TOOL_TIMEOUT_MS, type ToolGate } from "./common.js";

/** One scoped search's dispatch target, plus the adapter ids that could serve it. */
export interface ScopedSearchTarget {
	readonly adapter: SearchAdapter;
	readonly runtime: AdapterRuntime;
	/**
	 * Members that could answer: the override alone, or the configured chain in
	 * order. The hint compiler takes their intersection, because a chain serves
	 * from whichever member answers and a hint only some members understand would
	 * silently change meaning per hop.
	 */
	readonly memberIds: readonly string[];
}

/** What the tool asks the entry to resolve for one scoped search. */
export interface ScopedSearchRequest {
	readonly query: string;
	readonly maxResults?: number;
	/** Named provider: used exactly, never folded into the failover chain. */
	readonly provider?: string;
	/** The settings the adapter must see; empty while the filters are still uncompiled. */
	readonly settings: Record<string, unknown>;
}

/**
 * Resolve the target WITHOUT dispatching. The tool needs the target first
 * because a filter can only be translated once the adapter is known.
 */
export type ScopedSearchPlanner = (request: ScopedSearchRequest, signal?: AbortSignal) => Promise<ScopedSearchTarget>;

/**
 * Dispatch one scoped search with its compiled settings. Supplied by the plugin
 * entry so it reuses the same credential ladder, key rotation, cooldown board
 * and RESULT CACHE the seam provider uses — this tool adds filters, not a second
 * execution path, and in particular not a second cache.
 */
export type ScopedSearchRunner = (request: ScopedSearchRequest, signal?: AbortSignal) => Promise<WebSearchResult>;

/** Arguments this tool accepts; validated beyond what the schema DSL can express. */
interface ScopedArgs {
	query: string;
	maxResults?: number;
	provider?: string;
	timeRange?: string;
	afterDate?: string;
	topic?: string;
	locale?: string;
	includeDomains?: string[];
	excludeDomains?: string[];
}

/** Reject the shapes the schema cannot: blank strings and non-string list items. */
function parseScopedArgs(args: ScopedArgs): ScopedArgs {
	if (typeof args.query !== "string" || args.query.trim().length === 0) throw new Error("query must be a non-empty string");
	const strings = (value: unknown, field: string): string[] | undefined => {
		if (value === undefined) return undefined;
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
			throw new Error(`${field} must be a list of non-empty strings`);
		}
		return [...new Set(value as string[])];
	};
	const optional = (value: unknown, field: string): string | undefined => {
		if (value === undefined) return undefined;
		if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
		return value;
	};
	const includeDomains = strings(args.includeDomains, "includeDomains");
	const excludeDomains = strings(args.excludeDomains, "excludeDomains");
	// Validate here rather than letting normalization drop it: a malformed date is
	// a caller mistake, and silently searching without the bound would hand back
	// "nothing was published" for a request that was simply mistyped.
	const afterDate = optional(args.afterDate, "afterDate");
	const afterRange = afterDate === undefined ? undefined : normalizeTimeRange(afterDate);
	if (afterDate !== undefined && (afterRange === undefined || !("after" in afterRange))) {
		throw new Error(`afterDate must be a real calendar date as YYYY-MM-DD, got "${afterDate}"`);
	}
	// Both express freshness, and one of them would otherwise win by accident.
	if (afterDate !== undefined && args.timeRange !== undefined) throw new Error("timeRange and afterDate both set the freshness bound; pass one of them");
	return {
		query: args.query,
		...(afterDate === undefined ? {} : { afterDate }),
		...(optional(args.provider, "provider") === undefined ? {} : { provider: optional(args.provider, "provider")! }),
		...(optional(args.timeRange, "timeRange") === undefined ? {} : { timeRange: optional(args.timeRange, "timeRange")! }),
		...(optional(args.topic, "topic") === undefined ? {} : { topic: optional(args.topic, "topic")! }),
		...(optional(args.locale, "locale") === undefined ? {} : { locale: optional(args.locale, "locale")! }),
		...(args.maxResults === undefined ? {} : { maxResults: args.maxResults }),
		...(includeDomains === undefined ? {} : { includeDomains }),
		...(excludeDomains === undefined ? {} : { excludeDomains }),
	};
}

/** Pretty label for the provider token an adapter id belongs to. */
function providerLabel(adapterId: string): string {
	const chain = /^Chain\(([^)]*)\)$/.exec(adapterId);
	return chain?.[1]?.split("->")[0]?.trim() ?? adapterId;
}

/**
 * The one line every scoped result carries. Filters are only trustworthy when
 * the caller can see which of them reached the provider, so this is not
 * decoration: an `ignored:` clause is the difference between "no results in
 * this time window" and "the window was never applied".
 */
export function renderScopeLine(adapterId: string, compiled: CompiledHints, requested: readonly string[]): string {
	const parts = [`Search (${providerLabel(adapterId)}`];
	if (compiled.respects.length > 0) parts.push(`, ${compiled.respects.join(", ")}`);
	parts.push(")");
	if (compiled.unsupported.length > 0) parts.push(` — ignored by this provider: ${compiled.unsupported.join(", ")}`);
	if (requested.length > 0 && compiled.respects.length === 0 && compiled.unsupported.length === 0) parts.push(" — no filter could be expressed by this provider");
	return parts.join("");
}

/** Render the source list the way the other web tools do. */
function formatSources(sources: readonly { url: string; title?: string; snippet?: string }[]): string {
	if (sources.length === 0) return "No results found.";
	return sources
		.map((source, index) => {
			const head = source.title !== undefined && source.title.length > 0 ? `[${source.title}](${source.url})` : source.url;
			return `${index + 1}. ${head}${source.snippet !== undefined && source.snippet.length > 0 ? ` — ${source.snippet}` : ""}`;
		})
		.join("\n");
}

/**
 * Register `web_search_scoped`, gated by `options.enabled`. The tool stays
 * registered regardless of the active provider: a provider that cannot express
 * a filter reports it rather than failing the call.
 */
export function applyScopedSearchTool(ctx: Context, planner: ScopedSearchPlanner, runner: ScopedSearchRunner, options: ToolGate): void {
	if (!options.enabled) return;
	ctx.tools.register(defineTool({
		name: "web_search_scoped",
		description:
			"Search the web with explicit filters: a time window, a topic, a country/region, or domain allow/deny lists. Use this instead of web_search when the request names such a constraint (e.g. 'this week', 'news', 'only from docs.example.com'); the result reports which filters the active provider could express. Without filters it behaves like web_search, except that the filters you pass are honoured natively rather than ignored.",
		parameters: {
			query: { type: "string", required: true, description: "The search query." },
			provider: {
				type: "string",
				description: "Optional provider id to search with, e.g. tavily, firecrawl-keyless, deepseek. Omit to use the configured provider and its failover chain. A named provider is used EXACTLY: it is not part of the failover chain, so engine-specific sources (a platform search, say) cannot quietly become a general web search.",
			},
			maxResults: { type: "number", description: "Optional result count." },
			timeRange: {
				type: "string",
				enum: ["day", "week", "month", "year"],
				description: "Optional freshness window. These four are the whole vocabulary: a value outside them would otherwise be dropped silently, which is why there is no free-form form here. Use afterDate for an absolute lower bound.",
			},
			afterDate: {
				type: "string",
				description: "Optional absolute lower bound as YYYY-MM-DD: only results published on or after that date. Rejected with an error if it is not a real calendar date, rather than ignored.",
			},
			topic: { type: "string", enum: ["general", "news", "finance"], description: "Optional result class." },
			locale: { type: "string", description: "Optional country/region to bias results toward, e.g. US, CN, GB. Providers that cannot express it report it as ignored." },
			includeDomains: { type: "array", items: { type: "string" }, description: "Optional allowlist of domains; only these are searched." },
			excludeDomains: { type: "array", items: { type: "string" }, description: "Optional denylist of domains; these are never searched." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: { type: "string", required: true } },
			},
			render: (_args, value) => [{ type: "text", text: value.text }],
		},
		timeoutMs: DEFAULT_WEB_TOOL_TIMEOUT_MS,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const input = parseScopedArgs(args as ScopedArgs);
			// Resolve FIRST: the hint compilation is per adapter, so the target has
			// to be known before a filter can be translated into anything.
			const probe = await planner({ query: input.query, maxResults: input.maxResults, ...(input.provider === undefined ? {} : { provider: input.provider }), settings: {} }, exec.signal);
			const base = probe.runtime.settings;
			// The caller spells the window the way a person would ("2w", "2026-09-01").
			// normalizeTimeRange — not compileHints — is the one place that parses such
			// a string into the {days}|{after} shape, so it runs here; handing the raw
			// string to the compiler would crash it on its first `"after" in range`.
			// One field, one shape: the enum value is a tier, afterDate is absolute.
			// Both go through the same normalizer, so neither can bypass validation.
			const timeRange = normalizeTimeRange(input.timeRange) ?? normalizeTimeRange(input.afterDate);
			const hints: SearchHints = {
				query: input.query,
				...(input.maxResults === undefined ? {} : { maxResults: input.maxResults }),
				...(timeRange === undefined ? {} : { timeRange }),
				...(input.topic === undefined ? {} : { topic: input.topic }),
				...(input.locale === undefined ? {} : { locale: input.locale }),
				...(input.includeDomains === undefined ? {} : { includeDomains: input.includeDomains }),
				...(input.excludeDomains === undefined ? {} : { excludeDomains: input.excludeDomains }),
			};
			// A single member is a one-member intersection, so the two compilers agree
			// by construction; the chain form is what makes multi-hop honest.
			const compiled = probe.memberIds.length <= 1 ? compileHints(probe.adapter.id, hints, base) : compileHintsForChain(probe.memberIds, hints, base);
			// These labels must match the compiler's stable tokens, because this list is
			// only consulted when `respects` and `unsupported` are both empty: a window
			// the compiler could not map to any tier is `freshness`, not `timeRange`.
			const requested = [timeRange === undefined ? undefined : "freshness", hints.topic === undefined ? undefined : "topic", hints.locale === undefined ? undefined : "locale", hints.includeDomains === undefined ? undefined : "includeDomains", hints.excludeDomains === undefined ? undefined : "excludeDomains"].filter((label): label is string => label !== undefined);
			const result = await runner({ query: input.query, maxResults: input.maxResults, ...(input.provider === undefined ? {} : { provider: input.provider }), settings: compiled.settings }, exec.signal);
			const body = formatSources(result.sources);
			const scopeLine = renderScopeLine(probe.adapter.id, compiled, requested);
			const content = result.content === undefined || result.content.length === 0 ? "" : `\n\n${result.content}`;
			return { text: `${scopeLine}\n\n${body}${content}` };
		},
	}));
}

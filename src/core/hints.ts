/**
 * Search-hint compilation. A caller expresses filters once, in a
 * provider-neutral vocabulary ({@link SearchHints}), and this module translates
 * them into the parameter language of the adapter that will actually run. The
 * translation is a lookup table rather than a pass-through on purpose: a hint
 * becomes a vendor parameter only when the INSTALLED SDK declares that
 * parameter, and every hint without a home is reported through
 * {@link CompiledHints.unsupported} instead of being dropped. A silently
 * discarded filter is worse than an absent one, because the caller reads the
 * answer as if the filter had been applied.
 *
 * Two traps shape the code below. `TavilySearchOptions` carries an
 * `[key: string]: any` index signature, so an invented parameter would both
 * compile and reach the wire — only the named declarations count as evidence.
 * And the adapters disagree deliberately: Tavily and Firecrawl spell the same
 * filter differently, while DeepSeek's server-side `web_search_20250305` tool
 * takes no filter at all. "Supported" is therefore a per-adapter fact, never a
 * property of the hint.
 *
 * A chain is compiled by INTERSECTION ({@link compileHintsForChain}): a
 * dimension is written only when EVERY member can express it. A chain serves
 * from whichever member answers, so a per-hop-correct compilation is impossible
 * — whatever the first member understands, a later one may not. Predictable
 * narrowing is the honest failure; a hint that reaches only some hops reads as
 * applied and is not.
 * @module dsh-web-search-extend/core/hints
 */

/** A fixed-tier window, or an absolute lower bound taken from an ISO date. */
export type TimeRange = { readonly days: number } | { readonly after: string };

/** Caller-supplied filters, in the one vocabulary every adapter is compiled from. */
export interface SearchHints {
	/** The caller's query, preserved verbatim. */
	readonly query: string;
	readonly maxResults?: number;
	readonly timeRange?: TimeRange;
	/** general | news | finance */
	readonly topic?: string;
	readonly includeDomains?: readonly string[];
	readonly excludeDomains?: readonly string[];
	/** Country/region hint. Its accepted FORMAT is unattested in the installed SDKs. */
	readonly locale?: string;
}

/** One adapter's translation of {@link SearchHints}. */
export interface CompiledHints {
	/** Replace `runtime.settings` with this (the caller's own knobs ride inside). */
	readonly settings: Record<string, unknown>;
	/** Hints the active adapter cannot express, for the tool to report. */
	readonly unsupported: readonly string[];
	/** Hint labels that DID reach the request, for degradation visibility. */
	readonly respects: readonly string[];
}

/**
 * One filter dimension. These strings are also the caller-facing tokens the tool
 * prints, so each names the hint rather than the vendor key and stays stable
 * across adapters that spell the same filter differently (`timeRange` for
 * Tavily, `tbs` for Firecrawl) and across adapters that cannot express it.
 */
type Dimension = "maxResults" | "topic" | "freshness" | "includeDomains" | "excludeDomains" | "locale";

/** Token print order, which is also the order dimensions are resolved in. */
const DIMENSIONS: readonly Dimension[] = ["maxResults", "topic", "freshness", "includeDomains", "excludeDomains", "locale"];

/** Day counts of the fixed windows every freshness-capable adapter offers. */
const TIER_DAYS = { day: 1, week: 7, month: 30, year: 365 } as const;
type Tier = keyof typeof TIER_DAYS;
const TIERS: readonly Tier[] = ["day", "week", "month", "year"];

/**
 * Canonical day count → tier name. `normalizeTimeRange` yields nothing but tier
 * counts, so this is total over everything the compiler can be handed; a
 * hand-built `{ days: 4 }` (nothing in this plugin does that) gets `undefined`
 * and an honest refusal instead of a fabricated window.
 */
function tierOfDays(days: number): Tier | undefined {
	return TIERS.find((tier) => TIER_DAYS[tier] === days);
}

const ISO_DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Whether a `YYYY-MM-DD` triple is a real calendar day. The shape alone accepts
 * `2024-02-31`, which would reach a vendor as a date that does not exist, so the
 * parts are round-tripped through UTC — `Date.UTC` rolls overflow forward and
 * the mismatch is the only evidence the day was invented.
 */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
	if (month < 1 || month > 12 || day < 1 || day > 31) return false;
	const probe = new Date(Date.UTC(year, month - 1, day));
	return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/**
 * Normalize a caller's freshness value into {@link TimeRange}. Accepts exactly
 * two shapes: a fixed tier (`day`/`week`/`month`/`year`) and an absolute
 * `YYYY-MM-DD` start date. There is deliberately no relative-span grammar
 * (`3d`, `2w`): the vocabulary a caller may use is declared in the tool's own
 * schema, so nothing here has to decide what "7 days" was supposed to mean, and
 * a value outside the declared set cannot reach this function from the tool at
 * all. Anything else yields undefined. Never throws: this runs on supplied text.
 */
export function normalizeTimeRange(input: string | undefined): TimeRange | undefined {
	if (typeof input !== "string") return undefined;
	const value = input.trim().toLowerCase();
	if (value === "") return undefined;
	// Matched against the tier list rather than with `in`: an object literal's
	// prototype chain makes `"constructor" in TIER_DAYS` true, which would hand a
	// caller-supplied `"constructor"` back as a day count.
	const tier = TIERS.find((candidate) => candidate === value);
	if (tier !== undefined) return { days: TIER_DAYS[tier] };

	const iso = ISO_DATE_SHAPE.exec(value);
	if (iso !== null) {
		const year = Number(iso[1]);
		const month = Number(iso[2]);
		const day = Number(iso[3]);
		return isRealCalendarDate(year, month, day) ? { after: value } : undefined;
	}

	// No relative-span grammar on purpose: the only windows are the four fixed
	// tiers and an absolute start date, so every accepted spelling is declared in
	// the tool's own schema and nothing has to guess what "7 days" means.
	return undefined;
}

/** A result cap only filters when it is a positive whole number of results. */
function usableMaxResults(value: number | undefined): number | undefined {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Topics the shared vocabulary defines, normalized to the spelling vendors use. */
const TOPICS = new Set(["general", "news", "finance"]);

function usableTopic(value: string | undefined): string | undefined {
	const topic = value?.trim().toLowerCase();
	return topic !== undefined && topic.length > 0 ? topic : undefined;
}

/** Domains the caller actually listed; an empty or blank list is not a filter. */
function usableDomains(list: readonly string[] | undefined): string[] | undefined {
	if (list === undefined) return undefined;
	const cleaned = list.filter((entry) => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
	return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * A locale hint with only surrounding whitespace removed. Nothing else is
 * validated, case-folded or normalized: neither installed SDK attests the
 * expected format (an ISO country code, `"City,Region,Country"` or otherwise),
 * and guessing one would corrupt a value the vendor may accept verbatim.
 */
function usableLocale(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const locale = value.trim();
	return locale.length > 0 ? locale : undefined;
}

/**
 * What one adapter can do with one dimension: the settings keys it would write,
 * or undefined when the dimension has no native home there. An EMPTY object is
 * not a refusal — it means the adapter already behaves that way and needs no key
 * (Firecrawl's default already is general web search).
 */
type DimensionWrite = Record<string, unknown> | undefined;

/** One adapter's per-dimension translator. */
type DimensionCompiler = (dimension: Dimension, hints: SearchHints) => DimensionWrite;

/**
 * Tavily. Every key written here is a named member of `TavilySearchOptions`
 * (`@tavily/core@0.7.7`, `dist/index.d.ts`) and is forwarded on the wire by that
 * SDK — the option names are camelCase and the SDK performs the snake_case
 * translation, so the settings carry the camelCase spelling.
 *
 * `startDate` handles `{ after }`: an absolute lower bound has no fixed-tier
 * equivalent, and expressing one as a duration would need a clock this module
 * deliberately does not have. `time_range` keeps its own tiers for `{ days }`.
 */
function tavilyDimension(dimension: Dimension, hints: SearchHints): DimensionWrite {
	switch (dimension) {
		case "maxResults": {
			const maxResults = usableMaxResults(hints.maxResults);
			return maxResults === undefined ? undefined : { maxResults };
		}
		case "topic": {
			const topic = usableTopic(hints.topic);
			return topic !== undefined && TOPICS.has(topic) ? { topic } : undefined;
		}
		case "freshness": {
			const range = hints.timeRange;
			if (range === undefined) return undefined;
			if ("after" in range) return { startDate: range.after };
			const tier = tierOfDays(range.days);
			return tier === undefined ? undefined : { timeRange: tier };
		}
		case "includeDomains": {
			const includeDomains = usableDomains(hints.includeDomains);
			return includeDomains === undefined ? undefined : { includeDomains };
		}
		case "excludeDomains": {
			const excludeDomains = usableDomains(hints.excludeDomains);
			return excludeDomains === undefined ? undefined : { excludeDomains };
		}
		case "locale": {
			const locale = usableLocale(hints.locale);
			return locale === undefined ? undefined : { country: locale };
		}
	}
}

/** Tier → Firecrawl's `tbs` window token; `qdr:m` is the form the installed SDK exercises itself. */
const TBS_BY_TIER: Record<Tier, string> = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };

/**
 * Firecrawl. The named members used here come from `SearchRequest`
 * (`firecrawl@4.35.0`, `dist/index.d.ts`): `limit`, `tbs`, `sources`,
 * `includeDomains`, `excludeDomains`, `location`. Note the package is
 * `firecrawl`, not `@mendable/firecrawl-js` — the latter is not installed here.
 *
 * There is no `topic` parameter, and `sources` is not a synonym for one:
 * `general` writes nothing at all, because Firecrawl's own default already is
 * general web search and forcing `sources: ["web"]` would narrow a request whose
 * caller asked for no narrowing. `news` does have a home in the news source;
 * `finance` has none and is reported. An absolute date is reported too — the
 * package demonstrates only the relative `qdr:` grammar, so any `cdr:`-style
 * absolute bound would be invented rather than verified.
 */
function firecrawlDimension(dimension: Dimension, hints: SearchHints): DimensionWrite {
	switch (dimension) {
		case "maxResults": {
			const maxResults = usableMaxResults(hints.maxResults);
			return maxResults === undefined ? undefined : { limit: maxResults };
		}
		case "topic": {
			const topic = usableTopic(hints.topic);
			if (topic === undefined) return undefined;
			if (topic === "general") return {};
			return topic === "news" ? { sources: ["news"] } : undefined;
		}
		case "freshness": {
			const range = hints.timeRange;
			if (range === undefined || "after" in range) return undefined;
			const tier = tierOfDays(range.days);
			return tier === undefined ? undefined : { tbs: TBS_BY_TIER[tier] };
		}
		case "includeDomains": {
			const includeDomains = usableDomains(hints.includeDomains);
			return includeDomains === undefined ? undefined : { includeDomains };
		}
		case "excludeDomains": {
			const excludeDomains = usableDomains(hints.excludeDomains);
			if (excludeDomains === undefined) return undefined;
			// The installed SDK throws when a request carries both lists
			// (`src/v2/methods/search.ts:23`), so the allowlist — the narrower intent —
			// wins and the denylist is refused. Refusing it here also keeps an
			// intersection from being handed a pair that would fail at that boundary.
			return usableDomains(hints.includeDomains) !== undefined ? undefined : { excludeDomains };
		}
		case "locale": {
			const locale = usableLocale(hints.locale);
			return locale === undefined ? undefined : { location: locale };
		}
	}
}

/**
 * DeepSeek. Its transport delegates to the server-side `web_search_20250305`
 * tool, which accepts a query and nothing else, so every dimension is refused
 * and only the query travels.
 */
function deepseekDimension(): DimensionWrite {
	return undefined;
}

/** Adapter id → dimension compiler. Ids match `SearchAdapter.id` in `src/adapters`. */
const DIMENSION_COMPILERS: Readonly<Record<string, DimensionCompiler>> = {
	tavily: tavilyDimension,
	"firecrawl-keyless": firecrawlDimension,
	deepseek: deepseekDimension,
};

/**
 * Resolve an adapter id to its compiler. `Object.hasOwn`, not a bare index:
 * `DIMENSION_COMPILERS["constructor"]` resolves through the prototype chain to a
 * truthy function, and calling it would return an object with no `unsupported`.
 */
function compilerFor(adapterId: string): DimensionCompiler | undefined {
	const id = adapterId.trim();
	return Object.hasOwn(DIMENSION_COMPILERS, id) ? DIMENSION_COMPILERS[id] : undefined;
}

/**
 * Whether the caller supplied anything for a dimension. This reuses the
 * compilers' usability guards, so a value no adapter could act on (a zero result
 * cap, a blank locale) counts as absent rather than as simultaneously respected
 * and unsupported.
 */
function dimensionPresent(dimension: Dimension, hints: SearchHints): boolean {
	switch (dimension) {
		case "maxResults":
			return usableMaxResults(hints.maxResults) !== undefined;
		case "topic":
			return usableTopic(hints.topic) !== undefined;
		case "freshness":
			return hints.timeRange !== undefined;
		case "includeDomains":
			return usableDomains(hints.includeDomains) !== undefined;
		case "excludeDomains":
			return usableDomains(hints.excludeDomains) !== undefined;
		case "locale":
			return usableLocale(hints.locale) !== undefined;
	}
}

/** Mutable accumulator, frozen into {@link CompiledHints} at the end. */
interface Compiled {
	writes: Record<string, unknown>;
	respects: string[];
	unsupported: string[];
}

function emptyCompiled(): Compiled {
	return { writes: {}, respects: [], unsupported: [] };
}

/**
 * Resolve every supplied dimension against each member, writing a dimension only
 * when every member expresses it. Each member contributes its OWN native keys,
 * so they land side by side and whichever hop answers finds the one it reads;
 * for a single member this is an ordinary per-adapter compilation.
 *
 * A member that is undefined (an unknown adapter id) expresses nothing, and an
 * empty member list starts unresolvable, so both refuse every hint rather than
 * claim a support nobody can honour.
 */
function resolveHints(members: readonly (DimensionCompiler | undefined)[], hints: SearchHints): Compiled {
	const out = emptyCompiled();
	for (const dimension of DIMENSIONS) {
		if (!dimensionPresent(dimension, hints)) continue;
		const writes: Record<string, unknown> = {};
		let expressible = members.length > 0;
		for (const member of members) {
			const write = member === undefined ? undefined : member(dimension, hints);
			if (write === undefined) {
				expressible = false;
				break;
			}
			Object.assign(writes, write);
		}
		if (expressible) {
			Object.assign(out.writes, writes);
			out.respects.push(dimension);
		} else out.unsupported.push(dimension);
	}
	return out;
}

const CHAIN_SHAPE = /^Chain\((.*)\)$/;

/**
 * The member a chain id is compiled for when only the id is available: the first
 * one. A malformed chain yields undefined, which falls through to the
 * unknown-adapter path — the honest answer when no member can be identified.
 * Callers holding the member list should prefer {@link compileHintsForChain}.
 */
function primaryMember(adapterId: string): string | undefined {
	const id = adapterId.trim();
	const chain = CHAIN_SHAPE.exec(id);
	if (chain === null) return id;
	const first = (chain[1] ?? "").split("->")[0]?.trim();
	return first !== undefined && first.length > 0 ? first : undefined;
}

/**
 * Compile {@link SearchHints} for one adapter, merged over `baseSettings` so the
 * adapter's own config knobs (`searchDepth`, `includeAnswer`, `extractDepth`,
 * `limits`, `routeMode` …) survive: only the keys this module owns are
 * overwritten. An adapter id with no compiler — a chain whose first member is
 * unknown included — respects nothing and reports every hint present, because
 * claiming support for an adapter we cannot identify is the one answer that
 * cannot be recovered from.
 *
 * A `Chain(a -> b)` id is treated as its first member. That is a fallback for
 * callers holding only the id, and it carries no caveat, so a caller that knows
 * the members should use {@link compileHintsForChain} instead.
 */
export function compileHints(adapterId: string, hints: SearchHints, baseSettings: Record<string, unknown>): CompiledHints {
	const member = primaryMember(adapterId);
	const compiled = resolveHints([member === undefined ? undefined : compilerFor(member)], hints);
	return { settings: { ...baseSettings, ...compiled.writes }, unsupported: compiled.unsupported, respects: compiled.respects };
}

/**
 * Compile {@link SearchHints} for a chain of adapters by intersection: a
 * dimension reaches the settings only when EVERY member expresses it, and is
 * otherwise reported in `unsupported`. A chain serves from whichever member
 * answers, so a hint understood by only some hops would be applied
 * unpredictably; refusing it outright narrows the answer the same way on every
 * hop, which is the failure a caller can reason about.
 *
 * An empty list refuses every supplied hint, mirroring the unknown-adapter path.
 */
export function compileHintsForChain(adapterIds: readonly string[], hints: SearchHints, baseSettings: Record<string, unknown>): CompiledHints {
	const compiled = resolveHints(adapterIds.map((id) => compilerFor(id)), hints);
	return { settings: { ...baseSettings, ...compiled.writes }, unsupported: compiled.unsupported, respects: compiled.respects };
}

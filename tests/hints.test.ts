import { describe, expect, it } from "vitest";
import { compileHints, compileHintsForChain, normalizeTimeRange } from "../src/core/hints.js";
import type { SearchHints } from "../src/core/hints.js";

/** The adapter sections this compiler merges over; none of these keys are its own. */
function baseSettings(): Record<string, unknown> {
	return { searchDepth: "advanced", includeAnswer: true, extractDepth: "basic", limits: { maxUrls: 5 }, routeMode: "auto" };
}

describe("normalizeTimeRange", () => {
	it("maps the fixed tiers onto their day counts", () => {
		expect(normalizeTimeRange("day")).toEqual({ days: 1 });
		expect(normalizeTimeRange("week")).toEqual({ days: 7 });
		expect(normalizeTimeRange("month")).toEqual({ days: 30 });
		expect(normalizeTimeRange("year")).toEqual({ days: 365 });
	});

	it("accepts tiers regardless of case or surrounding whitespace", () => {
		expect(normalizeTimeRange("  WEEK  ")).toEqual({ days: 7 });
		expect(normalizeTimeRange("Month")).toEqual({ days: 30 });
	});

	it("refuses relative spans, because the tool's schema declares only tiers and dates", () => {
		// Deliberate: a free-form span vocabulary is what lets a value the compiler
		// cannot map get dropped without the caller noticing. The declared set is
		// the four tiers plus an absolute date, and nothing else is accepted.
		for (const span of ["12h", "24h", "1h", "3d", "2w", "2mo", "1y", "7 days"]) {
			expect(normalizeTimeRange(span)).toBeUndefined();
		}
	});

	it("turns a real ISO date into an absolute lower bound", () => {
		expect(normalizeTimeRange("2024-01-15")).toEqual({ after: "2024-01-15" });
		expect(normalizeTimeRange("2024-02-29")).toEqual({ after: "2024-02-29" });
	});

	it("rejects dates whose shape is right but whose day does not exist", () => {
		expect(normalizeTimeRange("2024-02-31")).toBeUndefined();
		expect(normalizeTimeRange("2023-02-29")).toBeUndefined();
		expect(normalizeTimeRange("2024-13-01")).toBeUndefined();
		expect(normalizeTimeRange("2024-00-10")).toBeUndefined();
	});

	it("returns undefined for anything it cannot map, and never throws", () => {
		const unusable = [undefined, "", "   ", "yesterday", "last week", "recent", "3 days", "1.5d", "-3d", "0d", "0h", "abc", "3x", "2024-1-5", "15-01-2024", "d3", "day week"];
		for (const input of unusable) expect(normalizeTimeRange(input)).toBeUndefined();
	});

	it("does not resolve an Object.prototype member as a tier", () => {
		// `"constructor" in TIER_DAYS` is true, so an `in` lookup would return a function as `days`.
		for (const input of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
			expect(normalizeTimeRange(input)).toBeUndefined();
		}
	});
});

describe("compileHints: base settings merge", () => {
	it("preserves every knob it does not own and copies rather than mutates the base", () => {
		const base = baseSettings();
		const before = JSON.stringify(base);
		const compiled = compileHints("tavily", { query: "q", maxResults: 7 }, base);
		expect(compiled.settings).toEqual({ ...base, maxResults: 7 });
		expect(JSON.stringify(base)).toBe(before);
	});

	it("returns the base untouched when the caller supplied no hints", () => {
		const base = baseSettings();
		const compiled = compileHints("tavily", { query: "q" }, base);
		expect(compiled.settings).toEqual(base);
		expect(compiled.respects).toEqual([]);
		expect(compiled.unsupported).toEqual([]);
	});
});

describe("compileHints: tavily", () => {
	it("writes the SDK's own option names for every expressible hint", () => {
		// Tavily takes both domain lists at once: unlike Firecrawl it has no guard
		// rejecting the pair, so no conflict policy is invented for it.
		const compiled = compileHints(
			"tavily",
			{ query: "q", maxResults: 10, topic: "news", timeRange: { days: 7 }, includeDomains: ["a.com"], excludeDomains: ["b.com"] },
			baseSettings(),
		);
		expect(compiled.settings).toEqual({
			...baseSettings(),
			maxResults: 10,
			topic: "news",
			// 4 days sits between the day and week tiers; the wider one wins the tie.
			timeRange: "week",
			includeDomains: ["a.com"],
			excludeDomains: ["b.com"],
		});
		expect(compiled.respects).toEqual(["maxResults", "topic", "freshness", "includeDomains", "excludeDomains"]);
		expect(compiled.unsupported).toEqual([]);
	});

	it("maps every reached tier exactly, and refuses a count no tier owns", () => {
		const tierOf = (days: number) => compileHints("tavily", { query: "q", timeRange: { days } }, {}).settings.timeRange;
		expect(tierOf(1)).toBe("day");
		expect(tierOf(7)).toBe("week");
		expect(tierOf(30)).toBe("month");
		expect(tierOf(365)).toBe("year");
		// No rounding: a hand-built count that is not a tier gets an honest refusal
		// rather than a window the caller never asked for.
		expect(tierOf(4)).toBeUndefined();
		expect(tierOf(0.5)).toBeUndefined();
	});

	it("carries an absolute lower bound on startDate, which is not a tier", () => {
		const compiled = compileHints("tavily", { query: "q", timeRange: { after: "2024-01-15" } }, {});
		expect(compiled.settings).toEqual({ startDate: "2024-01-15" });
		expect(compiled.respects).toEqual(["freshness"]);
		expect(compiled.unsupported).toEqual([]);
	});

	it("keeps all three vocabulary topics, and reports one outside it", () => {
		for (const topic of ["general", "news", "finance"]) {
			const compiled = compileHints("tavily", { query: "q", topic }, {});
			expect(compiled.settings.topic).toBe(topic);
			expect(compiled.respects).toEqual(["topic"]);
		}
		const unknown = compileHints("tavily", { query: "q", topic: "sports" }, {});
		expect(unknown.settings.topic).toBeUndefined();
		expect(unknown.respects).toEqual([]);
		expect(unknown.unsupported).toEqual(["topic"]);
	});

	it("ignores empty and blank filter lists instead of sending them", () => {
		const compiled = compileHints("tavily", { query: "q", includeDomains: [], excludeDomains: ["  "] }, {});
		expect(compiled.settings).toEqual({});
		expect(compiled.respects).toEqual([]);
		expect(compiled.unsupported).toEqual([]);
	});

	it("reports a non-positive or fractional result cap rather than passing it on", () => {
		for (const maxResults of [0, -3, 2.5, Number.NaN]) {
			const compiled = compileHints("tavily", { query: "q", maxResults }, {});
			expect(compiled.settings.maxResults).toBeUndefined();
			expect(compiled.respects).toEqual([]);
			expect(compiled.unsupported).toEqual([]);
		}
	});

	it("reports freshness it cannot act on", () => {
		const compiled = compileHints("tavily", { query: "q", timeRange: { days: 0 } }, {});
		expect(compiled.unsupported).toEqual(["freshness"]);
		expect(compiled.respects).toEqual([]);
	});
});

describe("compileHints: firecrawl-keyless", () => {
	it("spells the same hints with Firecrawl's parameter names", () => {
		const compiled = compileHints(
			"firecrawl-keyless",
			{ query: "q", maxResults: 8, topic: "news", timeRange: { days: 7 }, includeDomains: ["a.com"] },
			baseSettings(),
		);
		expect(compiled.settings).toEqual({
			...baseSettings(),
			limit: 8,
			sources: ["news"],
			// 5 days is 2 from the week tier and 4 from the day tier.
			tbs: "qdr:w",
			includeDomains: ["a.com"],
		});
		expect(compiled.respects).toEqual(["maxResults", "topic", "freshness", "includeDomains"]);
		expect(compiled.unsupported).toEqual([]);
	});

	it("takes a denylist when it is the only domain hint", () => {
		const compiled = compileHints("firecrawl-keyless", { query: "q", excludeDomains: ["b.com"] }, {});
		expect(compiled.settings).toEqual({ excludeDomains: ["b.com"] });
		expect(compiled.respects).toEqual(["excludeDomains"]);
		expect(compiled.unsupported).toEqual([]);
	});

	it("keeps the allowlist and reports the denylist, which the SDK refuses alongside it", () => {
		// firecrawl@4.35.0 throws "includeDomains and excludeDomains cannot both be
		// specified" before the request leaves the process, so one list must go.
		const compiled = compileHints("firecrawl-keyless", { query: "q", includeDomains: ["a.com"], excludeDomains: ["b.com"] }, {});
		expect(compiled.settings).toEqual({ includeDomains: ["a.com"] });
		expect(compiled.settings.excludeDomains).toBeUndefined();
		expect(compiled.respects).toEqual(["includeDomains"]);
		expect(compiled.unsupported).toEqual(["excludeDomains"]);
	});

	it("writes no source filter for a general topic, which is Firecrawl's own default", () => {
		const compiled = compileHints("firecrawl-keyless", { query: "q", topic: "general" }, {});
		// Forcing sources: ["web"] would narrow a caller who asked for no narrowing.
		expect(compiled.settings).toEqual({});
		expect(compiled.respects).toEqual(["topic"]);
		expect(compiled.unsupported).toEqual([]);
	});

	it("reports a topic it has no source for", () => {
		const compiled = compileHints("firecrawl-keyless", { query: "q", topic: "finance" }, {});
		expect(compiled.settings).toEqual({});
		expect(compiled.respects).toEqual([]);
		expect(compiled.unsupported).toEqual(["topic"]);
	});

	it("spells each tier as the tbs token the installed SDK exercises", () => {
		const tbsOf = (days: number) => compileHints("firecrawl-keyless", { query: "q", timeRange: { days } }, {}).settings.tbs;
		expect(tbsOf(1)).toBe("qdr:d");
		expect(tbsOf(7)).toBe("qdr:w");
		expect(tbsOf(30)).toBe("qdr:m");
		expect(tbsOf(365)).toBe("qdr:y");
	});

	it("reports an absolute date, having no verified absolute-date grammar", () => {
		const compiled = compileHints("firecrawl-keyless", { query: "q", timeRange: { after: "2024-01-15" } }, {});
		expect(compiled.settings).toEqual({});
		expect(compiled.respects).toEqual([]);
		expect(compiled.unsupported).toEqual(["freshness"]);
	});
});

describe("compileHints: locale", () => {
	it("maps onto each adapter's own country/region key", () => {
		expect(compileHints("tavily", { query: "q", locale: "US" }, {}).settings).toEqual({ country: "US" });
		expect(compileHints("firecrawl-keyless", { query: "q", locale: "US" }, {}).settings).toEqual({ location: "US" });
	});

	it("passes the caller's string through without guessing a format", () => {
		// Neither installed SDK attests the accepted format, so nothing is normalized.
		const value = "San Francisco,California,United States";
		expect(compileHints("tavily", { query: "q", locale: value }, {}).settings).toEqual({ country: value });
		expect(compileHints("firecrawl-keyless", { query: "q", locale: value }, {}).settings).toEqual({ location: value });
	});

	it("does not case-fold a value that looks like a country code", () => {
		expect(compileHints("tavily", { query: "q", locale: "us" }, {}).settings).toEqual({ country: "us" });
	});

	it("trims surrounding whitespace and nothing else", () => {
		expect(compileHints("firecrawl-keyless", { query: "q", locale: "  US  " }, {}).settings).toEqual({ location: "US" });
	});

	it("reports locale where there is no native home", () => {
		const compiled = compileHints("deepseek", { query: "q", locale: "US" }, {});
		expect(compiled.settings).toEqual({});
		expect(compiled.respects).toEqual([]);
		expect(compiled.unsupported).toEqual(["locale"]);
	});

	it("treats a blank or non-string locale as absent, neither respected nor unsupported", () => {
		for (const locale of ["", "   ", undefined, 42 as unknown as string, null as unknown as string]) {
			const compiled = compileHints("tavily", { query: "q", locale }, {});
			expect(compiled.settings).toEqual({});
			expect(compiled.respects).toEqual([]);
			expect(compiled.unsupported).toEqual([]);
		}
	});
});

describe("compileHints: deepseek", () => {
	it("writes nothing and reports every filter, because the server tool takes only a query", () => {
		const hints: SearchHints = {
			query: "q",
			maxResults: 10,
			topic: "news",
			timeRange: { days: 30 },
			includeDomains: ["a.com"],
			excludeDomains: ["b.com"],
		};
		const compiled = compileHints("deepseek", hints, baseSettings());
		expect(compiled.settings).toEqual(baseSettings());
		expect(compiled.respects).toEqual([]);
		expect(compiled.unsupported).toEqual(["maxResults", "topic", "freshness", "includeDomains", "excludeDomains"]);
	});

	it("reports nothing extra when the caller supplied no filter", () => {
		const compiled = compileHints("deepseek", { query: "q" }, { model: "x" });
		expect(compiled.settings).toEqual({ model: "x" });
		expect(compiled.unsupported).toEqual([]);
	});
});

describe("compileHints: chain ids", () => {
	it("compiles for the first member of a Chain(...) id", () => {
		const compiled = compileHints("Chain(tavily -> firecrawl-keyless)", { query: "q", topic: "news" }, {});
		expect(compiled.settings).toEqual({ topic: "news" });
		expect(compiled.respects).toEqual(["topic"]);
		expect(compiled.unsupported).toEqual([]);
	});

	it("picks whichever adapter is named first", () => {
		const compiled = compileHints("Chain(firecrawl-keyless -> tavily)", { query: "q", maxResults: 5 }, {});
		expect(compiled.settings).toEqual({ limit: 5 });
	});

	it("treats a chain it cannot parse as unknown rather than guessing a member", () => {
		for (const id of ["Chain()", "Chain( -> tavily)", "Chain(   )"]) {
			const compiled = compileHints(id, { query: "q", topic: "news" }, {});
			expect(compiled.respects).toEqual([]);
			expect(compiled.unsupported).toEqual(["topic"]);
		}
	});
});

describe("compileHintsForChain: intersection semantics", () => {
	it("writes a dimension when every member expresses it, each in its own keys", () => {
		const compiled = compileHintsForChain(["tavily", "firecrawl-keyless"], { query: "q", topic: "news", timeRange: { days: 7 } }, { routeMode: "auto" });
		// Both hops find their own native keys side by side, so whichever answers is filtered.
		expect(compiled.settings).toEqual({ routeMode: "auto", topic: "news", sources: ["news"], timeRange: "week", tbs: "qdr:w" });
		expect(compiled.respects).toEqual(["topic", "freshness"]);
		expect(compiled.unsupported).toEqual([]);
	});

	it("refuses a dimension only one member can express", () => {
		// An absolute date has a home on tavily (`startDate`) but not on firecrawl, so
		// the chain refuses it rather than filtering only the hops that understand it.
		const compiled = compileHintsForChain(["tavily", "firecrawl-keyless"], { query: "q", timeRange: { after: "2024-01-15" } }, {});
		expect(compiled.settings).toEqual({});
		expect(compiled.respects).toEqual([]);
		expect(compiled.unsupported).toEqual(["freshness"]);
	});

	it("refuses everything once a member expresses no filter at all", () => {
		const compiled = compileHintsForChain(["tavily", "deepseek"], { query: "q", maxResults: 5, topic: "news", locale: "US" }, { searchDepth: "basic" });
		expect(compiled.settings).toEqual({ searchDepth: "basic" });
		expect(compiled.respects).toEqual([]);
		expect(compiled.unsupported).toEqual(["maxResults", "topic", "locale"]);
	});

	it("refuses a denylist the pair cannot keep, even though tavily alone would take it", () => {
		const compiled = compileHintsForChain(["tavily", "firecrawl-keyless"], { query: "q", includeDomains: ["a.com"], excludeDomains: ["b.com"] }, {});
		// firecrawl refuses `excludeDomains` whenever `includeDomains` is present, so the
		// intersection drops it for the whole chain instead of throwing at the SDK boundary.
		expect(compiled.settings).toEqual({ includeDomains: ["a.com"] });
		expect(compiled.respects).toEqual(["includeDomains"]);
		expect(compiled.unsupported).toEqual(["excludeDomains"]);
	});

	it("refuses every hint for an empty member list, mirroring the unknown-adapter path", () => {
		const compiled = compileHintsForChain([], { query: "q", topic: "news" }, { routeMode: "auto" });
		expect(compiled.settings).toEqual({ routeMode: "auto" });
		expect(compiled.respects).toEqual([]);
		expect(compiled.unsupported).toEqual(["topic"]);
	});

	it("refuses every hint when a member is unknown", () => {
		const compiled = compileHintsForChain(["tavily", "no-such-adapter"], { query: "q", topic: "news" }, {});
		expect(compiled.settings).toEqual({});
		expect(compiled.respects).toEqual([]);
		expect(compiled.unsupported).toEqual(["topic"]);
	});

	it("merges baseSettings and copies rather than mutating them", () => {
		const base = baseSettings();
		const before = JSON.stringify(base);
		const compiled = compileHintsForChain(["tavily", "firecrawl-keyless"], { query: "q", locale: "US" }, base);
		expect(compiled.settings).toEqual({ ...base, country: "US", location: "US" });
		expect(JSON.stringify(base)).toBe(before);
	});

	it("never lets two members disagree on a shared key", () => {
		// The merge is Object.assign, so a key two members write differently would be
		// decided by member order. Pin that no adapter pair produces such a key.
		const ids = ["tavily", "firecrawl-keyless", "deepseek"];
		const cases: SearchHints[] = [
			{ query: "q", maxResults: 5, topic: "news", timeRange: { days: 30 }, includeDomains: ["a.com"], excludeDomains: ["b.com"], locale: "US" },
			{ query: "q", topic: "general", timeRange: { after: "2024-01-15" }, includeDomains: ["a.com"] },
			{ query: "q", topic: "finance", timeRange: { days: 365 }, locale: "US" },
		];
		for (const hints of cases) {
			const singles = ids.map((id) => compileHints(id, hints, {}).settings);
			for (let i = 0; i < singles.length; i++) {
				for (let j = i + 1; j < singles.length; j++) {
					const left = singles[i] ?? {};
					const right = singles[j] ?? {};
					for (const key of Object.keys(left)) {
						if (key in right) expect(left[key]).toEqual(right[key]);
					}
				}
			}
		}
	});

	it("is identical to compileHints for a single member", () => {
		// The property that keeps the chain and single-adapter paths from drifting.
		const cases: SearchHints[] = [
			{ query: "q" },
			{ query: "q", maxResults: 7, topic: "news", timeRange: { days: 7 }, locale: "US" },
			{ query: "q", timeRange: { after: "2024-01-15" }, includeDomains: ["a.com"], excludeDomains: ["b.com"] },
			{ query: "q", maxResults: 0, topic: "sports", locale: "   " },
		];
		for (const id of ["tavily", "firecrawl-keyless", "deepseek", "no-such-adapter"]) {
			for (const hints of cases) {
				expect(compileHintsForChain([id], hints, baseSettings())).toEqual(compileHints(id, hints, baseSettings()));
			}
		}
	});
});

describe("compileHints: unknown adapter", () => {
	it("claims nothing and reports every hint present", () => {
		const compiled = compileHints("no-such-adapter", { query: "q", maxResults: 3, topic: "news", timeRange: { days: 30 } }, { routeMode: "auto" });
		expect(compiled.settings).toEqual({ routeMode: "auto" });
		expect(compiled.respects).toEqual([]);
		expect(compiled.unsupported).toEqual(["maxResults", "topic", "freshness"]);
	});

	it("stays silent when there was nothing to respect", () => {
		const compiled = compileHints("no-such-adapter", { query: "q" }, {});
		expect(compiled.respects).toEqual([]);
		expect(compiled.unsupported).toEqual([]);
	});

	it("treats an Object.prototype member as an unknown adapter instead of calling it", () => {
		for (const id of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
			const compiled = compileHints(id, { query: "q", topic: "news" }, {});
			expect(compiled.respects).toEqual([]);
			expect(compiled.unsupported).toEqual(["topic"]);
		}
	});
});

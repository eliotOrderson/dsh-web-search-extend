/**
 * Coverage for `web_search_scoped`: the tool that lets the caller NAME search
 * filters instead of having them guessed from query text. What matters here is
 * the contract, not the vendor mappings (those are pinned in hints.test.ts and
 * adapter-hints.test.ts):
 *
 * - the filters actually reach the adapter's settings, compiled per provider;
 * - the result always says which filters were applied and which were ignored,
 *   because a filter silently dropped turns "no results this week" into a lie;
 * - a named provider is used exactly and never folded into the failover chain.
 */
import { describe, expect, it } from "vitest";
import { applyScopedSearchTool, renderScopeLine, type ScopedSearchPlanner, type ScopedSearchRunner } from "../src/tools/scoped.js";
import { compileHints, normalizeTimeRange } from "../src/core/hints.js";
import type { Context } from "@deepseek-ai/cordis";
import type { SearchAdapter } from "../src/types.js";

/** Capture the registered tool so the test can execute it directly. */
function harness() {
	const registered: Record<string, { execute: (args: unknown, exec: { signal: AbortSignal }) => Promise<{ text: string }> }> = {};
	const ctx = {
		tools: {
			register: (tool: { name: string; execute: (args: unknown, exec: { signal: AbortSignal }) => Promise<{ text: string }> }) => {
				registered[tool.name] = tool;
			},
		},
	} as unknown as Context;
	return { ctx, registered };
}

const signal = new AbortController().signal;

/** A planner/runnner pair that records what the tool asked for. */
function stubs(memberIds: readonly string[] = ["tavily"]) {
	const adapter = { id: memberIds[0]!, label: memberIds[0]!, requiresApiKey: false } as SearchAdapter;
	const seen: { planSettings: unknown[]; runSettings: unknown[]; providers: (string | undefined)[] } = { planSettings: [], runSettings: [], providers: [] };
	const base = { searchDepth: "basic", limits: { perPageChars: 20000 } };
	const planner: ScopedSearchPlanner = async (request) => {
		seen.planSettings.push(request.settings);
		seen.providers.push(request.provider);
		return { adapter, runtime: { apiKeyEnv: "K", baseURL: "https://x.test", settings: base }, memberIds };
	};
	const runner: ScopedSearchRunner = async (request) => {
		seen.runSettings.push(request.settings);
		return { sources: [{ url: "https://x.test/1", title: "hit" }], truncated: false };
	};
	return { adapter, planner, runner, seen, base };
}

describe("web_search_scoped", () => {
	it("compiles the caller's filters into the adapter's settings", async () => {
		const { ctx, registered } = harness();
		const { planner, runner, seen } = stubs();
		applyScopedSearchTool(ctx, planner, runner, { enabled: true });

		const out = await registered.web_search_scoped!.execute({ query: "q", timeRange: "week", topic: "news" }, { signal });
		expect(seen.runSettings[0]).toMatchObject({ timeRange: "week", topic: "news" });
		// The adapter's own knobs survive the merge — a filter must not erase them.
		expect(seen.runSettings[0]).toMatchObject({ searchDepth: "basic" });
		expect(out.text).toContain("Search (tavily");
		expect(out.text).toContain("hit");
	});

	it("says which filters were applied and which were ignored", async () => {
		const { ctx, registered } = harness();
		const { planner, runner } = stubs(["deepseek"]);
		applyScopedSearchTool(ctx, planner, runner, { enabled: true });

		// deepseek's native tool carries no filter parameters at all, so every named
		// filter must come back as ignored rather than vanish.
		const out = await registered.web_search_scoped!.execute({ query: "q", timeRange: "week", locale: "CN" }, { signal });
		expect(out.text).toContain("ignored by this provider: freshness, locale");
	});

	it("passes a named provider through instead of a chain", async () => {
		const { ctx, registered } = harness();
		const { planner, runner, seen } = stubs();
		applyScopedSearchTool(ctx, planner, runner, { enabled: true });
		await registered.web_search_scoped!.execute({ query: "q", provider: "zhihu" }, { signal });
		expect(seen.providers).toEqual(["zhihu"]);
	});

	it("uses the chain intersection when several members could answer", async () => {
		const { ctx, registered } = harness();
		const { planner, runner, seen } = stubs(["tavily", "deepseek"]);
		applyScopedSearchTool(ctx, planner, runner, { enabled: true });

		// deepseek expresses nothing, so the intersection is empty: a hint applied
		// to only one hop would change meaning depending on who answered.
		await registered.web_search_scoped!.execute({ query: "q", topic: "news" }, { signal });
		expect(seen.runSettings[0]).not.toHaveProperty("topic");
	});

	it("rejects a blank query and a non-string list item", async () => {
		const { ctx, registered } = harness();
		const { planner, runner } = stubs();
		applyScopedSearchTool(ctx, planner, runner, { enabled: true });
		await expect(registered.web_search_scoped!.execute({ query: "  " }, { signal })).rejects.toThrow(/non-empty/);
		await expect(registered.web_search_scoped!.execute({ query: "q", includeDomains: [""] }, { signal })).rejects.toThrow(/non-empty strings/);
	});

	it("does not register when the gate is off", () => {
		const { ctx, registered } = harness();
		const { planner, runner } = stubs();
		applyScopedSearchTool(ctx, planner, runner, { enabled: false });
		expect(registered.web_search_scoped).toBeUndefined();
	});

	it("compiles an absolute afterDate into the provider's own bound", async () => {
		const { ctx, registered } = harness();
		const { planner, runner, seen } = stubs(["tavily"]);
		applyScopedSearchTool(ctx, planner, runner, { enabled: true });
		await registered.web_search_scoped!.execute({ query: "q", afterDate: "2026-09-01" }, { signal });
		// tavily's absolute form is startDate, not a tier — the whole point of
		// having a second field instead of overloading timeRange.
		expect(seen.runSettings[0]).toMatchObject({ startDate: "2026-09-01" });
	});

	it("rejects a malformed afterDate instead of searching without it", async () => {
		const { ctx, registered } = harness();
		const { planner, runner } = stubs();
		applyScopedSearchTool(ctx, planner, runner, { enabled: true });
		for (const bad of ["yesterday", "2026-13-45", "2026-02-30", "01-09-2026"]) {
			await expect(registered.web_search_scoped!.execute({ query: "q", afterDate: bad }, { signal })).rejects.toThrow(/real calendar date/);
		}
	});

	it("refuses both freshness fields at once rather than letting one win", async () => {
		const { ctx, registered } = harness();
		const { planner, runner } = stubs();
		applyScopedSearchTool(ctx, planner, runner, { enabled: true });
		await expect(registered.web_search_scoped!.execute({ query: "q", timeRange: "week", afterDate: "2026-09-01" }, { signal })).rejects.toThrow(/one of them/);
	});

	it("declares timeRange as a closed enum, so a stray spelling cannot be dropped", () => {
		const { ctx, registered } = harness();
		const { planner, runner } = stubs();
		applyScopedSearchTool(ctx, planner, runner, { enabled: true });
		// The vocabulary lives in the schema the model reads; a free-form string here
		// is what let "last week" vanish silently before.
		const schema = (registered.web_search_scoped as unknown as { parameters: { properties: Record<string, { enum?: string[] }> } }).parameters.properties;
		expect(schema.timeRange!.enum).toEqual(["day", "week", "month", "year"]);
		expect(schema.timeRange!.enum).not.toContain("12h");
	});

	it("deduplicates repeated domains before compiling", async () => {
		const { ctx, registered } = harness();
		const { planner, runner, seen } = stubs();
		applyScopedSearchTool(ctx, planner, runner, { enabled: true });
		await registered.web_search_scoped!.execute({ query: "q", includeDomains: ["a.test", "a.test", "b.test"] }, { signal });
		expect(seen.runSettings[0]).toMatchObject({ includeDomains: ["a.test", "b.test"] });
	});
});

describe("renderScopeLine", () => {
	it("names only the filters that reached the provider", () => {
		// A hint carries the NORMALIZED window: parsing the caller's spelling is
		// normalizeTimeRange's job, and handing the raw string to the compiler
		// crashes it on its first `"after" in range`.
		const compiled = compileHints("tavily", { query: "q", timeRange: normalizeTimeRange("week")!, topic: "news" }, {});
		const line = renderScopeLine("tavily", compiled, ["timeRange", "topic"]);
		expect(line).toContain("tavily");
		expect(line).toContain("freshness");
		expect(line).toContain("topic");
		expect(line).not.toContain("ignored");
	});

	it("reports the ignored ones", () => {
		const compiled = compileHints("deepseek", { query: "q", topic: "news" }, {});
		const line = renderScopeLine("deepseek", compiled, ["topic"]);
		expect(line).toContain("ignored by this provider: topic");
	});

	it("labels a chain by its first member", () => {
		const compiled = compileHints("tavily", { query: "q" }, {});
		expect(renderScopeLine("Chain(tavily -> deepseek)", compiled, [])).toContain("tavily");
	});
});

describe("scope-line honesty", () => {
	it("never claims a filter no provider could express", async () => {
		const { ctx, registered } = harness();
		const { planner, runner } = stubs(["deepseek"]);
		applyScopedSearchTool(ctx, planner, runner, { enabled: true });
		const out = await registered.web_search_scoped!.execute({ query: "q", includeDomains: ["a.test"] }, { signal });
		expect(out.text).toMatch(/ignored by this provider: includeDomains/);
	});

	it("still renders sources when every filter was ignored", async () => {
		const { ctx, registered } = harness();
		const { planner, runner } = stubs(["deepseek"]);
		applyScopedSearchTool(ctx, planner, runner, { enabled: true });
		const out = await registered.web_search_scoped!.execute({ query: "q", topic: "news" }, { signal });
		expect(out.text).toContain("https://x.test/1");
		expect(out.text).not.toContain("undefined");
	});
});

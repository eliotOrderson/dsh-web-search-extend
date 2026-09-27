import { beforeEach, describe, expect, it, vi } from "vitest";
import { compileHints } from "../src/core/hints.js";
import { TavilyAdapter } from "../src/adapters/tavily.js";
import { FirecrawlKeylessAdapter } from "../src/adapters/firecrawl.js";

// Both vendor SDKs are mocked. A compiled per-call hint is only observable in
// the arguments an adapter hands its SDK, so that is what every test asserts —
// with strict (non-partial) equality wherever the point is "nothing else moved".
// The hints themselves are produced by the real `compileHints`, so these tests
// pin the seam between the compiler and the adapters, not a hand-written shape.
// Zero network.
const tavilyState = vi.hoisted(() => {
	const client = {
		search: vi.fn(),
		extract: vi.fn(),
		crawl: vi.fn(),
		map: vi.fn(),
		research: vi.fn(),
		getResearch: vi.fn(),
	};
	return { client, tavily: vi.fn(() => client) };
});

vi.mock("@tavily/core", () => ({
	tavily: tavilyState.tavily,
	TavilyKeylessLimitError: class TavilyKeylessLimitError extends Error {},
}));

const firecrawlState = vi.hoisted(() => {
	class FirecrawlMock {
		constructorArgs: unknown[];

		constructor(...args: unknown[]) {
			this.constructorArgs = args;
			(FirecrawlMock as any).instances.push(this);
		}

		search(...args: unknown[]) {
			return (FirecrawlMock as any).searchMock(...args);
		}
	}

	(FirecrawlMock as any).instances = [];
	(FirecrawlMock as any).searchMock = vi.fn();

	return { FirecrawlMock };
});

vi.mock("firecrawl", () => ({
	Firecrawl: firecrawlState.FirecrawlMock,
	SdkError: class SdkErrorMock extends Error {},
}));

const firecrawlSearch = () => (firecrawlState.FirecrawlMock as any).searchMock as ReturnType<typeof vi.fn>;

function tavilyRuntime(settings: Record<string, unknown>) {
	return { apiKeyEnv: "TAVILY_API_KEY", baseURL: "https://api.tavily.test", settings };
}

function firecrawlRuntime(settings: Record<string, unknown>) {
	return { apiKeyEnv: "FIRECRAWL_API_KEY", baseURL: "https://api.firecrawl.test", settings };
}

/** An empty payload: these tests only care about the OUTGOING arguments. */
const EMPTY_SEARCH = { results: [] };

beforeEach(() => {
	vi.clearAllMocks();
	tavilyState.client.search.mockResolvedValue(EMPTY_SEARCH);
	firecrawlSearch().mockResolvedValue({ web: [] });
});

describe("tavily — per-call hints", () => {
	it("lets a topic and a freshness hint win over the config defaults", async () => {
		const compiled = compileHints(
			"tavily",
			{ query: "q", topic: "news", timeRange: { days: 7 } },
			{ searchDepth: "advanced", topic: "general", maxResults: 9, includeAnswer: true, timeRange: "year" },
		);

		await TavilyAdapter.search({ query: "q" }, tavilyRuntime(compiled.settings));

		expect(compiled.respects).toEqual(expect.arrayContaining(["topic", "freshness"]));
		expect(tavilyState.client.search).toHaveBeenCalledWith("q", {
			searchDepth: "advanced",
			topic: "news",
			maxResults: 9,
			includeAnswer: true,
			timeRange: "week",
		});
	});

	it("passes an absolute freshness bound through as the native startDate", async () => {
		const compiled = compileHints("tavily", { query: "q", timeRange: { after: "2024-05-01" } }, {});

		await TavilyAdapter.search({ query: "q" }, tavilyRuntime(compiled.settings));

		expect(tavilyState.client.search).toHaveBeenCalledWith("q", {
			searchDepth: "basic",
			topic: "general",
			maxResults: 5,
			includeAnswer: false,
			startDate: "2024-05-01",
		});
	});

	it("maps domain hints onto the native include/exclude filters", async () => {
		const compiled = compileHints("tavily", { query: "q", includeDomains: ["a.example"], excludeDomains: ["b.example"] }, {});

		await TavilyAdapter.search({ query: "q" }, tavilyRuntime(compiled.settings));

		expect(tavilyState.client.search).toHaveBeenCalledWith("q", {
			searchDepth: "basic",
			topic: "general",
			maxResults: 5,
			includeAnswer: false,
			includeDomains: ["a.example"],
			excludeDomains: ["b.example"],
		});
	});

	it("keeps every config default byte-for-byte when no filters were supplied", async () => {
		const base = { searchDepth: "advanced", topic: "finance", maxResults: 7, includeAnswer: true, timeRange: "month" };
		const compiled = compileHints("tavily", { query: "q" }, base);

		// The merge is a no-op with nothing to respect, which is what keeps the
		// no-hint vendor call identical to the pre-hints adapter.
		expect(compiled.settings).toEqual(base);
		expect(compiled.respects).toEqual([]);

		await TavilyAdapter.search({ query: "q" }, tavilyRuntime(compiled.settings));

		expect(tavilyState.client.search).toHaveBeenCalledWith("q", {
			searchDepth: "advanced",
			topic: "finance",
			maxResults: 7,
			includeAnswer: true,
			timeRange: "month",
		});
	});

	it("reports an unusable topic instead of guessing, and changes nothing", async () => {
		const compiled = compileHints("tavily", { query: "q", topic: "video" }, {});

		expect(compiled.settings).toEqual({});
		expect(compiled.unsupported).toEqual(["topic"]);

		const result = await TavilyAdapter.search({ query: "q" }, tavilyRuntime(compiled.settings));

		expect(result).toEqual({ sources: [], truncated: false });
		expect(tavilyState.client.search).toHaveBeenCalledWith("q", {
			searchDepth: "basic",
			topic: "general",
			maxResults: 5,
			includeAnswer: false,
		});
	});

	it("ignores a parameter Tavily does not declare, without throwing", async () => {
		// `tbs`/`sources` are Firecrawl's spelling of the same filters. Tavily's own
		// type declares neither, and `TavilySearchOptions` has an index signature —
		// so passing settings straight through would compile and reach the wire.
		const result = await TavilyAdapter.search({ query: "q" }, tavilyRuntime({ tbs: "qdr:w", sources: ["news"] }));

		expect(result).toEqual({ sources: [], truncated: false });
		expect(tavilyState.client.search).toHaveBeenCalledWith("q", {
			searchDepth: "basic",
			topic: "general",
			maxResults: 5,
			includeAnswer: false,
		});
	});

	it("never lets a hint override the request's own result cap", async () => {
		const compiled = compileHints("tavily", { query: "q", maxResults: 3 }, { maxResults: 9 });

		await TavilyAdapter.search({ query: "q", maxResults: 2 }, tavilyRuntime(compiled.settings));

		expect(tavilyState.client.search).toHaveBeenCalledWith("q", expect.objectContaining({ maxResults: 2 }));
	});

	it("compiles a locale hint onto the native country parameter, and adds no key without one", async () => {
		// Lower case on purpose: the compiler strips surrounding whitespace only and
		// the installed `@tavily/core` attests no accepted format for `country`, so
		// the caller's string has to reach the wire unnormalised.
		const compiled = compileHints("tavily", { query: "q", locale: "germany" }, {});

		expect(compiled.settings).toEqual({ country: "germany" });
		expect(compiled.respects).toContain("locale");

		await TavilyAdapter.search({ query: "q" }, tavilyRuntime(compiled.settings));
		expect(tavilyState.client.search).toHaveBeenLastCalledWith("q", {
			searchDepth: "basic",
			topic: "general",
			maxResults: 5,
			includeAnswer: false,
			country: "germany",
		});

		await TavilyAdapter.search({ query: "q" }, tavilyRuntime(compileHints("tavily", { query: "q" }, {}).settings));
		expect(tavilyState.client.search).toHaveBeenLastCalledWith("q", {
			searchDepth: "basic",
			topic: "general",
			maxResults: 5,
			includeAnswer: false,
		});
	});
});

describe("firecrawl — per-call hints", () => {
	it("sends nothing but the limit when no filters were supplied", async () => {
		const compiled = compileHints("firecrawl-keyless", { query: "q" }, {});

		expect(compiled.settings).toEqual({});

		await FirecrawlKeylessAdapter.search({ query: "q" }, firecrawlRuntime(compiled.settings));

		expect(firecrawlSearch()).toHaveBeenCalledWith("q", { limit: 5 });
	});

	it("passes a freshness hint as the native tbs window", async () => {
		const compiled = compileHints("firecrawl-keyless", { query: "q", timeRange: { days: 7 } }, {});

		await FirecrawlKeylessAdapter.search({ query: "q" }, firecrawlRuntime(compiled.settings));

		expect(firecrawlSearch()).toHaveBeenCalledWith("q", { limit: 5, tbs: "qdr:w" });
	});

	it("passes a news topic as the native news source and maps the news arm", async () => {
		const compiled = compileHints("firecrawl-keyless", { query: "q", topic: "news" }, {});
		firecrawlSearch().mockResolvedValue({
			news: [
				{ title: "Story", url: "https://n.example/1", snippet: "news excerpt", date: "2024-05-01" },
				{ title: "Duplicate", url: "https://n.example/1", snippet: "same url" },
				{ url: "https://n.example/2" },
			],
		});

		const result = await FirecrawlKeylessAdapter.search({ query: "q" }, firecrawlRuntime(compiled.settings));

		expect(firecrawlSearch()).toHaveBeenCalledWith("q", { limit: 5, sources: ["news"] });
		// Without the news arm in the mapper this would be an empty source list.
		expect(result).toEqual({
			sources: [
				{ url: "https://n.example/1", title: "Story", snippet: "news excerpt" },
				{ url: "https://n.example/2" },
			],
			truncated: false,
		});
	});

	it("maps domain hints onto the native domain filters", async () => {
		const include = compileHints("firecrawl-keyless", { query: "q", includeDomains: ["a.example"] }, {});
		await FirecrawlKeylessAdapter.search({ query: "q" }, firecrawlRuntime(include.settings));
		expect(firecrawlSearch()).toHaveBeenLastCalledWith("q", { limit: 5, includeDomains: ["a.example"] });

		// The vendor refuses an allow- and a deny-list together, so the compiler
		// keeps the narrower intent and reports the denylist; alone it still rides.
		const exclude = compileHints("firecrawl-keyless", { query: "q", includeDomains: ["a.example"], excludeDomains: ["b.example"] }, {});
		expect(exclude.settings).toEqual({ includeDomains: ["a.example"] });
		expect(exclude.unsupported).toContain("excludeDomains");

		const excluded = compileHints("firecrawl-keyless", { query: "q", excludeDomains: ["b.example"] }, {});
		await FirecrawlKeylessAdapter.search({ query: "q" }, firecrawlRuntime(excluded.settings));
		expect(firecrawlSearch()).toHaveBeenLastCalledWith("q", { limit: 5, excludeDomains: ["b.example"] });
	});

	it("takes the hint's result cap but still lets the request cap it", async () => {
		const compiled = compileHints("firecrawl-keyless", { query: "q", maxResults: 3 }, {});

		await FirecrawlKeylessAdapter.search({ query: "q" }, firecrawlRuntime(compiled.settings));
		expect(firecrawlSearch()).toHaveBeenLastCalledWith("q", { limit: 3 });

		await FirecrawlKeylessAdapter.search({ query: "q", maxResults: 2 }, firecrawlRuntime(compiled.settings));
		expect(firecrawlSearch()).toHaveBeenLastCalledWith("q", { limit: 2 });
	});

	it("changes nothing and does not throw for hints Firecrawl cannot express", async () => {
		// An absolute bound has no attested `tbs` grammar, and finance has no
		// Firecrawl source; both are reported upstream rather than invented here.
		const compiled = compileHints("firecrawl-keyless", { query: "q", timeRange: { after: "2024-05-01" }, topic: "finance" }, {});

		expect(compiled.settings).toEqual({});
		expect(compiled.unsupported).toEqual(expect.arrayContaining(["topic", "freshness"]));

		const result = await FirecrawlKeylessAdapter.search({ query: "q" }, firecrawlRuntime(compiled.settings));

		expect(firecrawlSearch()).toHaveBeenCalledWith("q", { limit: 5 });
		expect(result).toEqual({ sources: [], truncated: false });
	});

	it("compiles a locale hint onto the native location parameter, and adds no key without one", async () => {
		// Capitalised on purpose: the installed `firecrawl` attests no accepted
		// format for `location` (a bare `string`, not a structured object), so the
		// caller's string has to reach the wire unnormalised.
		const compiled = compileHints("firecrawl-keyless", { query: "q", locale: "Germany" }, {});

		expect(compiled.settings).toEqual({ location: "Germany" });
		expect(compiled.respects).toContain("locale");

		await FirecrawlKeylessAdapter.search({ query: "q" }, firecrawlRuntime(compiled.settings));
		expect(firecrawlSearch()).toHaveBeenLastCalledWith("q", { limit: 5, location: "Germany" });

		await FirecrawlKeylessAdapter.search({ query: "q" }, firecrawlRuntime(compileHints("firecrawl-keyless", { query: "q" }, {}).settings));
		expect(firecrawlSearch()).toHaveBeenLastCalledWith("q", { limit: 5 });
	});
});

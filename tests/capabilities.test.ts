import { describe, expect, it } from "vitest";
import { DeepSeekAdapter } from "../src/adapters/deepseek.js";
import { FirecrawlKeylessAdapter } from "../src/adapters/firecrawl.js";
import { TavilyAdapter } from "../src/adapters/tavily.js";
import { capabilitiesOf } from "../src/core/capabilities.js";
import type { WebAdapter } from "../src/types.js";

const opsOf = (adapter: WebAdapter): string[] => [...capabilitiesOf(adapter)].sort();

// Pinning tests (spec section 5): capability derivation is method presence,
// invisible to the compiler when a method is renamed. These fail loudly if a
// bundled adapter's derived set ever shrinks.
describe("capability pinning", () => {
	it("tavily derives all five operations natively", () => {
		expect(opsOf(TavilyAdapter)).toEqual(["crawl", "extract", "map", "research", "search"]);
	});

	it("deepseek derives exactly the singleton search set", () => {
		expect(opsOf(DeepSeekAdapter)).toEqual(["search"]);
	});

	it("firecrawl-keyless derives all five operations natively", () => {
		expect(opsOf(FirecrawlKeylessAdapter)).toEqual(["crawl", "extract", "map", "research", "search"]);
	});

	it("requires BOTH research methods before granting the research capability", () => {
		const submitOnly = {
			...DeepSeekAdapter,
			submitResearch: async () => ({ requestId: "r-1", status: "pending" as const }),
		} as WebAdapter;
		expect(opsOf(submitOnly)).toEqual(["search"]);
	});
});

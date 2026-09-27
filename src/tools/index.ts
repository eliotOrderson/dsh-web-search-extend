/**
 * Wiring for the model-facing web tool suite. This module owns NO tool logic:
 * it builds the injected fetch seam, forwards declarative gates to each
 * per-tool module, and registers the single system-prompt guidance block.
 * @module dsh-web-search-extend/tools
 */
import type { Context } from "@deepseek-ai/cordis";
import type { FetchLike } from "../types.js";
import type { ResolvedOptions } from "../core/provider.js";
import { applyCrawlTool } from "./crawl.js";
import { applyScopedSearchTool, type ScopedSearchPlanner, type ScopedSearchRunner } from "./scoped.js";
import { applyExtractTool } from "./extract.js";
import { applyMapTool } from "./map.js";
import { applyResearchStatusTool, applyResearchSubmitTool } from "./research.js";

/** Registration gates; `config.tools.*` maps straight onto this. */
export interface WebToolsGates {
	/** `web_search_scoped`: the same search with explicitly named filters. */
	readonly scoped: boolean;
	readonly extract: boolean;
	readonly crawl: boolean;
	readonly map: boolean;
	readonly research: boolean;
}

/**
 * The seam fetch composites ride. Built once here — inside the plugin, where
 * `ctx` exists — so the router and composites stay ctx-free algorithms.
 */
function seamFetch(ctx: Context): FetchLike {
	return (request, signal) => ctx.web.fetch(request, signal);
}

/** Register every enabled web tool plus the shared prompt guidance block. */
export function applyWebTools(
	ctx: Context,
	resolveOptions: () => ResolvedOptions,
	gates: WebToolsGates,
	scopedPlanner?: ScopedSearchPlanner,
	scopedRunner?: ScopedSearchRunner,
): void {
	const fetch = seamFetch(ctx);
	if (gates.scoped && scopedPlanner !== undefined && scopedRunner !== undefined) {
		applyScopedSearchTool(ctx, scopedPlanner, scopedRunner, { enabled: true });
	}
	applyExtractTool(ctx, resolveOptions, fetch, { enabled: gates.extract });
	applyCrawlTool(ctx, resolveOptions, fetch, { enabled: gates.crawl });
	applyMapTool(ctx, resolveOptions, fetch, { enabled: gates.map });
	applyResearchSubmitTool(ctx, resolveOptions, fetch, { enabled: gates.research });
	applyResearchStatusTool(ctx, resolveOptions, { enabled: gates.research });
	if (!gates.extract && !gates.crawl && !gates.map && !gates.research && !gates.scoped) return;
	ctx.systemPrompt.section({
		name: "tool:dsh-web-search-extend",
		order: 112,
		text: [
			"When the request names a search constraint — a time window, a topic, a country, or particular sites — use web_search_scoped instead of web_search, so the filter reaches the provider natively; its result states which filters were applied and which the active provider could not express.",
			"When you already know the URL and clean text matters (several pages, or fetch's markdown noise hurts), prefer web_extract over web_fetch.",
			"web_crawl and web_map have native quality on some providers and fall back to a simpler built-in crawl/sitemap pass on others.",
			"web_research costs credits: submit once, then poll web_research_status patiently with gaps of at least 20 seconds instead of re-submitting.",
			"A result carrying a 'cache hit (age Ns)' warning was served from the local result cache rather than the network, so it may be up to the configured TTL old; re-run with the cache disabled only if that staleness actually matters.",
		].join(" "),
	});
}

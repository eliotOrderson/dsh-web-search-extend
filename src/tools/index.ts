/**
 * Wiring for the model-facing web tool suite. This module owns NO tool logic:
 * it builds the injected fetch seam, forwards declarative gates to each
 * per-tool module, and registers the single system-prompt guidance block.
 * @module dsh-web-search-extend/tools
 */
import type { Context } from "@deepseek-ai/cordis";
import type { FetchLike } from "../types.js";
import type { ResolvedOptions } from "../core/provider.js";
import type { AdapterRegistry } from "../core/registry.js";
import type { CooldownBoard } from "../core/cooldown.js";
import type { ConfigType } from "../config.js";
import { applyCrawlTool } from "./crawl.js";
import { applyDoctorTool } from "./doctor.js";
import { applyExtractTool } from "./extract.js";
import { applyMapTool } from "./map.js";
import { applyResearchStatusTool, applyResearchSubmitTool } from "./research.js";

/** Registration gates; `config.tools.*` maps straight onto this. */
export interface WebToolsGates {
	readonly extract: boolean;
	readonly crawl: boolean;
	readonly map: boolean;
	readonly research: boolean;
	readonly doctor: boolean;
}

/** State the offline `web_doctor` report reads (registry/config/cooldowns). */
export interface DoctorWiring {
	readonly registry: AdapterRegistry;
	readonly config: () => ConfigType;
	readonly cooldowns: CooldownBoard;
}

/**
 * The seam fetch composites ride. Built once here — inside the plugin, where
 * `ctx` exists — so the router and composites stay ctx-free algorithms.
 */
function seamFetch(ctx: Context): FetchLike {
	return (request, signal) => ctx.web.fetch(request, signal);
}

/** Register every enabled web tool plus the shared prompt guidance block. */
export function applyWebTools(ctx: Context, resolveOptions: () => ResolvedOptions, gates: WebToolsGates, doctor?: DoctorWiring): void {
	const fetch = seamFetch(ctx);
	applyExtractTool(ctx, resolveOptions, fetch, { enabled: gates.extract });
	applyCrawlTool(ctx, resolveOptions, fetch, { enabled: gates.crawl });
	applyMapTool(ctx, resolveOptions, fetch, { enabled: gates.map });
	applyResearchSubmitTool(ctx, resolveOptions, fetch, { enabled: gates.research });
	applyResearchStatusTool(ctx, resolveOptions, { enabled: gates.research });
	if (gates.doctor && doctor !== undefined) {
		applyDoctorTool(ctx, doctor, { enabled: true });
	}
	if (!gates.extract && !gates.crawl && !gates.map && !gates.research) return;
	ctx.systemPrompt.section({
		name: "tool:dsh-web-search-extend",
		order: 112,
		text: [
			"When you already know the URL and clean text matters (several pages, or fetch's markdown noise hurts), prefer web_extract over web_fetch.",
			"web_crawl and web_map have native quality on some providers and fall back to a simpler built-in crawl/sitemap pass on others.",
			"web_research costs credits: submit once, then poll web_research_status patiently with gaps of at least 20 seconds instead of re-submitting.",
			"web_doctor prints an offline readiness report of every engine (key refs as booleans, endpoints, cooldowns, effective chain) when search behaves oddly.",
		].join(" "),
	});
}

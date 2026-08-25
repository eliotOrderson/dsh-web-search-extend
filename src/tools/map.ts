/**
 * The model-facing `web_map` tool. This module owns its schema, argument
 * validation, and the numbered URL-list formatter; the router picks the tier.
 * @module dsh-web-search-extend/tools/map
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import type { FetchLike, MapResult } from "../types.js";
import type { ResolvedOptions } from "../core/provider.js";
import { resolveExecution } from "../core/provider.js";
import { execute } from "../core/router.js";
import { DEFAULT_WEB_TOOL_TIMEOUT_MS, type ToolGate } from "./common.js";

/** Render a map result as a numbered URL list plus a count/truncation summary. */
function formatMapOutput(result: MapResult): string {
	const lines = result.urls.map((url, index) => `${index + 1}. ${url}`);
	const truncated = result.truncated ? " List truncated." : "";
	lines.push(`Mapped ${result.urls.length} URLs.${truncated}`);
	return lines.join("\n");
}

/** Register `web_map`; see `applyExtractTool` for the gating contract. */
export function applyMapTool(
	ctx: Context,
	resolveOptions: () => ResolvedOptions,
	fetch: FetchLike,
	options: ToolGate,
): void {
	if (!options.enabled) return;
	ctx.tools.register(defineTool({
		name: "web_map",
		description:
			"List the URLs of one site (sitemap-based). Native map quality varies by provider; a composite fallback serves every provider but only covers sitemap-bearing sites.",
		parameters: {
			url: { type: "string", required: true, description: "The HTTP(S) URL of the site to map." },
			maxUrls: { type: "number", description: "Optional URL-count cap (default and ceiling come from config limits)." },
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
			if (args.url.trim().length === 0) throw new Error("url must be a non-empty string");
			const target = await resolveExecution(resolveOptions(), exec.signal);
			const result = await execute({
				op: "map",
				request: { url: args.url, ...(args.maxUrls !== undefined ? { maxUrls: args.maxUrls } : {}) },
				adapter: target.adapter,
				runtime: target.runtime,
				fetch,
				signal: exec.signal,
			});
			return { text: formatMapOutput(result) };
		},
	}));
}

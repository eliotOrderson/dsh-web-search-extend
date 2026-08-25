/**
 * The model-facing `web_crawl` tool. This module owns its schema, argument
 * validation, and formatting; the router picks the native or composite tier.
 * @module dsh-web-search-extend/tools/crawl
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import type { FetchLike } from "../types.js";
import type { ResolvedOptions } from "../core/provider.js";
import { resolveExecution } from "../core/provider.js";
import { compositeLimits, execute } from "../core/router.js";
import { DEFAULT_WEB_TOOL_TIMEOUT_MS, formatPageResult, type ToolGate } from "./common.js";

/** Validate what the schema DSL cannot: a non-blank start URL and sane domains. */
function parseCrawlArgs(args: {
	url: string;
	maxPages?: number;
	includeDomains?: string[];
	excludeDomains?: string[];
}): { url: string; maxPages?: number; includeDomains?: string[]; excludeDomains?: string[] } {
	if (args.url.trim().length === 0) throw new Error("url must be a non-empty string");
	const domains = (values: string[] | undefined, name: string): string[] | undefined => {
		if (values === undefined) return undefined;
		if (values.some((value) => value.trim().length === 0)) throw new Error(`each ${name} entry must be a non-empty string`);
		return values;
	};
	return {
		url: args.url,
		...(args.maxPages !== undefined ? { maxPages: args.maxPages } : {}),
		...(domains(args.includeDomains, "includeDomains") !== undefined ? { includeDomains: args.includeDomains } : {}),
		...(domains(args.excludeDomains, "excludeDomains") !== undefined ? { excludeDomains: args.excludeDomains } : {}),
	};
}

/** Register `web_crawl`; see `applyExtractTool` for the gating contract. */
export function applyCrawlTool(
	ctx: Context,
	resolveOptions: () => ResolvedOptions,
	fetch: FetchLike,
	options: ToolGate,
): void {
	if (!options.enabled) return;
	ctx.tools.register(defineTool({
		name: "web_crawl",
		description:
			"Crawl pages breadth-first starting from one HTTP(S) URL and return readable content per visited page. Native crawl quality varies by provider; a composite fallback serves every provider.",
		parameters: {
			url: { type: "string", required: true, description: "The HTTP(S) URL to start crawling from." },
			maxPages: { type: "number", description: "Optional page-count cap (default and ceiling come from config limits)." },
			includeDomains: { type: "array", items: { type: "string" }, description: "Only visit pages on these domains." },
			excludeDomains: { type: "array", items: { type: "string" }, description: "Never visit pages on these domains." },
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
			const input = parseCrawlArgs(args);
			const target = await resolveExecution(resolveOptions(), exec.signal);
			const limits = compositeLimits(target.runtime.settings);
			const result = await execute({
				op: "crawl",
				request: input,
				adapter: target.adapter,
				runtime: target.runtime,
				fetch,
				signal: exec.signal,
			});
			return { text: formatPageResult("Crawled", result, limits.perPageChars) };
		},
	}));
}

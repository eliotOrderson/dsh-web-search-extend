/**
 * The model-facing `web_extract` tool. This module owns its schema, argument
 * validation, and formatting; the router owns native-vs-composite selection
 * and this module never knows which tier served the call.
 * @module dsh-web-search-extend/tools/extract
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import type { FetchLike } from "../types.js";
import type { ResolvedOptions } from "../core/provider.js";
import { resolveExecution } from "../core/provider.js";
import { compositeLimits, execute } from "../core/router.js";
import { DEFAULT_WEB_TOOL_TIMEOUT_MS, formatPageResult, type ToolGate } from "./common.js";

/** Validate what the schema DSL cannot: non-empty, non-blank, deduplicated URLs. */
function parseExtractArgs(args: { urls: string[]; query?: string; format?: string }): {
	urls: string[];
	query?: string;
	format?: "markdown" | "text";
} {
	const urls = [...new Set(args.urls)];
	if (urls.length === 0) throw new Error("urls must contain at least one URL");
	if (urls.some((url) => url.trim().length === 0)) throw new Error("each url must be a non-empty string");
	return {
		urls,
		...(args.query !== undefined ? { query: args.query } : {}),
		...(args.format !== undefined ? { format: args.format as "markdown" | "text" } : {}),
	};
}

/**
 * Register `web_extract`. Registration is gated by `options.enabled` so the
 * config layer stays declarative; a registered tool stays visible regardless
 * of the active provider and fails with a structured error when unsupported.
 */
export function applyExtractTool(
	ctx: Context,
	resolveOptions: () => ResolvedOptions,
	fetch: FetchLike,
	options: ToolGate,
): void {
	if (!options.enabled) return;
	ctx.tools.register(defineTool({
		name: "web_extract",
		description:
			"Extract readable content from known HTTP(S) URLs and return it as markdown or text. Prefer this over web_fetch when you need clean text from several URLs at once.",
		parameters: {
			urls: {
				type: "array",
				required: true,
				items: { type: "string" },
				description: "Required URLs to extract; duplicates are collapsed and the set is capped by the configured limit.",
			},
			query: { type: "string", description: "Optional guided-extraction hint; honored natively by some providers." },
			format: { type: "string", enum: ["markdown", "text"], description: "Content format (default markdown)." },
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
			const input = parseExtractArgs(args);
			const target = await resolveExecution(resolveOptions(), exec.signal);
			const limits = compositeLimits(target.runtime.settings);
			const capped = input.urls.slice(0, limits.extractMaxUrls);
			const dropped = input.urls.length - capped.length;
			const result = await execute({
				op: "extract",
				request: { urls: capped, ...(input.query !== undefined ? { query: input.query } : {}), ...(input.format !== undefined ? { format: input.format } : {}) },
				adapter: target.adapter,
				runtime: target.runtime,
				fetch,
				signal: exec.signal,
			});
			const body = formatPageResult("Extracted", result, limits.perPageChars);
			const note = dropped > 0 ? `(Capped at ${limits.extractMaxUrls} URLs; dropped ${dropped}. Extract fewer per call for full coverage.)` : "";
			return { text: [body, note].filter((part) => part.length > 0).join("\n") };
		},
	}));
}

/**
 * The model-facing research tool pair. `web_research` submits one asynchronous
 * research task; `web_research_status` polls it to a terminal phase. Both ride
 * the router's native tier only — research has no composite fallback — so a
 * search-only provider fails with a structured WEB_OP_UNSUPPORTED.
 * @module dsh-web-search-extend/tools/research
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import type { FetchLike, ResearchStatus } from "../types.js";
import type { ResolvedOptions } from "../core/provider.js";
import { resolveExecution } from "../core/provider.js";
import { compositeLimits, execute, pollResearch } from "../core/router.js";
import { isResearchComplete } from "../types.js";
import { DEFAULT_WEB_TOOL_TIMEOUT_MS, type ToolGate } from "./common.js";

/** Model-facing instruction repeated on every submit/pending outcome. */
const POLL_HINT = "Poll web_research_status with this requestId after at least 20 seconds.";

/** Render one numbered source line; URL-only sources render bare. */
function formatSourceList(status: ResearchStatus): string {
	const sources = status.sources ?? [];
	if (sources.length === 0) return "";
	const lines = sources.map((source, index) => `${index + 1}. ${source.title !== undefined && source.title.length > 0 ? `[${source.title}](${source.url})` : source.url}`);
	return `\n\nSources:\n${lines.join("\n")}`;
}

/** Register `web_research` (submit); see `applyExtractTool` for the gating contract. */
export function applyResearchSubmitTool(
	ctx: Context,
	resolveOptions: () => ResolvedOptions,
	fetch: FetchLike,
	options: ToolGate,
): void {
	if (!options.enabled) return;
	ctx.tools.register(defineTool({
		name: "web_research",
		description:
			"Submit one deep-research task (costs credits) and get its requestId immediately. Poll web_research_status for the outcome; the task runs asynchronously.",
		parameters: {
			input: { type: "string", required: true, description: "The research question or brief." },
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
			if (args.input.trim().length === 0) throw new Error("input must be a non-empty string");
			const target = await resolveExecution(resolveOptions(), exec.signal);
			const submission = await execute({
				op: "research",
				request: args.input,
				adapter: target.adapter,
				runtime: target.runtime,
				fetch,
				signal: exec.signal,
			});
			return { text: `Research submitted.\nrequestId: ${submission.requestId}\nstatus: ${submission.status}\n${POLL_HINT}` };
		},
	}));
}

/** Register `web_research_status` (poll); see `applyExtractTool` for the gating contract. */
export function applyResearchStatusTool(
	ctx: Context,
	resolveOptions: () => ResolvedOptions,
	options: ToolGate,
): void {
	if (!options.enabled) return;
	ctx.tools.register(defineTool({
		name: "web_research_status",
		description:
			"Poll one submitted web_research task. Returns the phase; once completed, also the report content and its numbered sources.",
		parameters: {
			requestId: { type: "string", required: true, description: "The requestId returned by web_research." },
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
			if (args.requestId.trim().length === 0) throw new Error("requestId must be a non-empty string");
			const target = await resolveExecution(resolveOptions(), exec.signal);
			const status = await pollResearch({
				requestId: args.requestId,
				adapter: target.adapter,
				runtime: target.runtime,
				signal: exec.signal,
			});
			if (!isResearchComplete(status.status)) {
				return { text: status.status === "pending" ? `Research ${status.requestId} still pending. ${POLL_HINT}` : `Research ${status.requestId} reported an unrecognized phase (${status.status}). ${POLL_HINT}` };
			}
			if (status.status === "failed") {
				return { text: `Research ${status.requestId} failed.${status.content !== undefined ? `\n\n${status.content}` : ""}` };
			}
			const limits = compositeLimits(target.runtime.settings);
			const content = (status.content ?? "").slice(0, limits.perPageChars);
			return { text: `Research ${status.requestId} completed.\n\n${content}${formatSourceList(status)}` };
		},
	}));
}

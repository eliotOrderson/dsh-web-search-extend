/**
 * Shared plumbing for the model-facing web tool suite: the cooperative
 * timeout budget and the page-list renderer shared by `web_extract` and
 * `web_crawl` (both answer "readable content per URL", so two renderers
 * would only drift).
 * @module dsh-web-search-extend/tools/common
 */
import type { PageResult } from "../types.js";

/** Cooperative tool-call budget (ms), aligned with dsh-tool-web's default. */
export const DEFAULT_WEB_TOOL_TIMEOUT_MS = 30000;

/** Registration gate; wiring stays declarative (config.tools.* maps onto this). */
export interface ToolGate {
	readonly enabled: boolean;
}

/** Render one fetched page: heading, URL line, fenced content; failures are one-line notes. */
function formatPage(page: PageResult["pages"][number], perPageChars: number): string {
	if (page.failureReason !== undefined) return `- ${page.url}: failed (${page.failureReason})`;
	const title = page.title !== undefined && page.title.length > 0 ? page.title : page.url;
	const content = page.content ?? "";
	const capped = content.slice(0, perPageChars);
	const cut = content.length > capped.length ? `\n(truncated at ${perPageChars} chars)` : "";
	return [`### ${title}`, page.url, "", "\`\`\`", `${capped}${cut}`, "\`\`\`"].join("\n");
}

/**
 * Render a page result to bounded markdown: per-page blocks, then one summary
 * line with extracted/visited vs failed counts plus the truncation note.
 *
 * @param verb - summary verb distinguishing the caller ("Extracted"/"Crawled").
 * @param result - the router's page outcome.
 * @param perPageChars - per-page content cap (the `limits.perPageChars` config).
 */
export function formatPageResult(verb: string, result: PageResult, perPageChars: number): string {
	const failed = result.pages.filter((page) => page.failureReason !== undefined).length;
	const ok = result.pages.length - failed;
	const blocks = result.pages.map((page) => formatPage(page, perPageChars));
	const counts = failed > 0 ? `${ok} of ${result.pages.length} pages (${failed} failed)` : `${ok} of ${result.pages.length} pages`;
	const truncated = result.truncated ? " Result truncated." : "";
	blocks.push(`${verb} ${counts}.${truncated}`);
	return blocks.join("\n\n");
}

/**
 * Naive HTML conversion for the composite tier — a documented compatibility
 * floor, not native-extraction parity (design §7/§15). Pure string functions:
 * no DOM, no network, trivially unit-testable against a fake fetch.
 * @module dsh-web-search-extend/core/html
 */

/** Elements whose entire subtree is noise for reading purposes (<title> surfaces via pageTitle instead). */
const DROPPED_ELEMENTS = /<(script|style|noscript|svg|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

const HTML_COMMENTS = /<!--[\s\S]*?-->/g;

/** Block-level containers; each boundary becomes a line break in text output. */
const BLOCK_BOUNDARY =
	/<\/?(?:p|div|h[1-6]|blockquote|pre|ul|ol|li|table|thead|tbody|tr|td|th|section|article|header|footer|nav|aside|main|figure|figcaption|dl|dt|dd|hr|br)\b[^>]*>/gi;

/** Paragraph-level containers; blank-line separated in markdown output. */
const PARAGRAPH_BOUNDARY = /<\/?(?:p|blockquote)\b[^>]*>/gi;

const HEADING = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;

const ANCHOR = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi;

const LIST_ITEM_OPEN = /<li\b[^>]*>/gi;

const TITLE = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;

const ANY_TAG = /<\/?[a-zA-Z][^>]*>/g;

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Plain visible text: boilerplate dropped, blocks on their own lines. */
export function htmlToText(html: string): string {
	const broken = stripBoilerplate(html).replace(BLOCK_BOUNDARY, "\n");
	return collapseWhitespace(decodeEntities(broken.replace(ANY_TAG, "")));
}

/**
 * Markdown approximation: h1-h6 headings, [text](href) anchors, dash list
 * items, blank-line paragraphs. Deliberately naive (design §15).
 */
export function htmlToMarkdown(html: string): string {
	let markdown = stripBoilerplate(html);
	markdown = markdown.replace(HEADING, (_, level: string, inner: string) => `\n${"#".repeat(Number(level))} ${inline(inner)}\n`);
	markdown = markdown.replace(
		ANCHOR,
		(_, doubleQuoted: string | undefined, singleQuoted: string | undefined, inner: string) =>
			`[${inline(inner)}](${doubleQuoted ?? singleQuoted ?? ""})`,
	);
	markdown = markdown.replace(LIST_ITEM_OPEN, "\n- ");
	markdown = markdown.replace(PARAGRAPH_BOUNDARY, "\n\n");
	markdown = markdown.replace(BLOCK_BOUNDARY, "\n");
	return collapseWhitespace(decodeEntities(markdown.replace(ANY_TAG, "")));
}

/** Document title (the <title> element) if present, normalized; undefined otherwise. */
export function pageTitle(html: string): string | undefined {
	const match = TITLE.exec(html);
	const inner = match?.[1];
	if (inner === undefined) return undefined;
	const title = inline(inner);
	return title.length > 0 ? title : undefined;
}

/**
 * Absolute hrefs from anchors, resolved against baseUrl, first-appearance
 * order, deduplicated. Non-http(s) schemes survive resolution; consumers
 * filter (the same-domain crawl gate rejects them for free).
 */
export function extractHrefs(html: string, baseUrl: string): string[] {
	const base = new URL(baseUrl);
	const seen = new Set<string>();
	for (const match of html.matchAll(ANCHOR)) {
		const href = match[1] ?? match[2];
		if (href === undefined || href.length === 0) continue;
		try {
			seen.add(new URL(href.replace(/&amp;/gi, "&"), base.href).href);
		} catch {
			// Unresolvable against the base (bad scheme/host) — skip, never throw.
		}
	}
	return [...seen];
}

function stripBoilerplate(html: string): string {
	return html.replace(DROPPED_ELEMENTS, " ").replace(HTML_COMMENTS, " ");
}

// `amp` decodes LAST so `&amp;lt;` yields the literal text "&lt;", not "<".
function decodeEntities(text: string): string {
	return text
		.replace(/&(lt|gt|quot|apos|nbsp);/gi, (_, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? "")
		.replace(/&#(\d+);/g, (_, digits: string) => fromCodePoint(Number(digits)))
		.replace(/&#x([0-9a-f]+);/gi, (_, digits: string) => fromCodePoint(Number.parseInt(digits, 16)))
		.replace(/&amp;/gi, "&");
}

function fromCodePoint(codePoint: number): string {
	return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
		? String.fromCodePoint(codePoint)
		: "";
}

function inline(fragment: string): string {
	return decodeEntities(fragment.replace(ANY_TAG, ""))
		.replace(/\s+/g, " ")
		.trim();
}

function collapseWhitespace(text: string): string {
	const lines = text
		.split("\n")
		.map((line) => line.replace(/[\t\f\v ]+/g, " ").trim())
		.join("\n");
	return lines.replace(/\n{3,}/g, "\n\n").trim();
}

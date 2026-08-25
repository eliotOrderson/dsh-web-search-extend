/**
 * HTML conversion for the composite tier using the official turndown stack:
 * turndown + GitHub-flavored markdown plugin + domino DOM. Pure string
 * functions: no network, trivially unit-testable against a fake fetch.
 * @module dsh-web-search-extend/core/html
 */
import TurndownService from "turndown";
import { gfm } from "@joplin/turndown-plugin-gfm";
import { createDocument } from "domino";

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});
turndown.use(gfm);
turndown.remove(["script", "style", "noscript", "title"]);

const MAX_CONVERSION_DEPTH = 512;
const VOID_ELEMENTS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "noscript"]);

function isTagBoundary(char: string | undefined): boolean {
	return char === undefined || char === ">" || char === "/" || /\s/.test(char);
}

function findRawTextEnd(lowerHtml: string, name: string, from: number): number {
	const prefix = `</${name}`;
	let candidate = lowerHtml.indexOf(prefix, from);
	while (candidate !== -1 && !isTagBoundary(lowerHtml[candidate + prefix.length])) {
		candidate = lowerHtml.indexOf(prefix, candidate + prefix.length);
	}
	return candidate;
}

function exceedsConversionDepth(html: string): boolean {
	const lowerHtml = html.toLowerCase();
	const openElements: string[] = [];
	let offset = 0;
	let inComment = false;
	while (offset < html.length) {
		const start = html.indexOf("<", offset);
		if (inComment) {
			const end = html.indexOf("-->", offset);
			if (end !== -1 && (start === -1 || end < start)) {
				inComment = false;
				offset = end + 3;
				continue;
			}
		}
		if (start === -1) break;
		if (!inComment && html.startsWith("<!--", start)) {
			inComment = true;
			offset = start + 4;
			continue;
		}
		let cursor = start + 1;
		const closing = html[cursor] === "/";
		if (closing) cursor += 1;
		const nameStart = cursor;
		while (/[a-zA-Z0-9-]/.test(html[cursor] ?? "")) cursor += 1;
		if (cursor === nameStart || !/[a-zA-Z]/.test(html.charAt(nameStart))) {
			offset = start + 1;
			continue;
		}
		const name = lowerHtml.slice(nameStart, cursor);
		let quote: string | undefined;
		while (cursor < html.length) {
			const char = html[cursor];
			cursor += 1;
			if (quote !== undefined) {
				if (char === quote) quote = undefined;
			} else if (char === '"' || char === "'") quote = char;
			else if (char === ">") break;
		}
		if (html[cursor - 1] !== ">") break;
		if (closing) {
			if (!inComment && openElements.at(-1) === name) openElements.pop();
		} else {
			let last = cursor - 2;
			while (/\s/.test(html.charAt(last))) last -= 1;
			if (!VOID_ELEMENTS.has(name) && html[last] !== "/") {
				openElements.push(name);
				if (openElements.length > MAX_CONVERSION_DEPTH) return true;
				if (!inComment && RAW_TEXT_ELEMENTS.has(name)) {
					const end = findRawTextEnd(lowerHtml, name, cursor);
					if (end === -1) break;
					offset = end;
					continue;
				}
			}
		}
		offset = cursor;
	}
	return false;
}

export function htmlToMarkdown(html: string): string {
	if (exceedsConversionDepth(html)) return html.trim();
	try {
		return turndown.turndown(html).trim();
	} catch {
		return html.trim();
	}
}

export function htmlToText(html: string): string {
	if (exceedsConversionDepth(html)) return html.trim();
	return (createDocument(html).body?.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function pageTitle(html: string): string | undefined {
	if (exceedsConversionDepth(html)) return undefined;
	const title = createDocument(html).querySelector("title")?.textContent?.trim();
	return title !== undefined && title.length > 0 ? title : undefined;
}

export function extractHrefs(html: string, baseUrl: string): string[] {
	if (exceedsConversionDepth(html)) return [];
	const doc = createDocument(html);
	const base = new URL(baseUrl);
	const seen = new Set<string>();
	for (const anchor of Array.from(doc.querySelectorAll("a[href]"))) {
		const href = anchor.getAttribute("href");
		if (href === undefined || href === null || href.length === 0) continue;
		try {
			seen.add(new URL(href.replace(/&amp;/gi, "&"), base.href).href);
		} catch {
			// Unresolvable against the base — skip, never throw.
		}
	}
	return [...seen];
}
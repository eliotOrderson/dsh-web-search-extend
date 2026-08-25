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

export function htmlToMarkdown(html: string): string {
	return turndown.turndown(html).trim();
}

export function htmlToText(html: string): string {
	return (createDocument(html).body?.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function pageTitle(html: string): string | undefined {
	const title = createDocument(html).querySelector("title")?.textContent?.trim();
	return title !== undefined && title.length > 0 ? title : undefined;
}

export function extractHrefs(html: string, baseUrl: string): string[] {
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

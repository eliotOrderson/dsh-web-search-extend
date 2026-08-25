import { describe, expect, it } from "vitest";
import { extractHrefs, htmlToMarkdown, htmlToText, pageTitle } from "../src/core/html.js";

describe("HTML conversion via turndown + GFM + domino", () => {
	it("converts GFM tables to pipe tables", () => {
		const html = [
			"<table>",
			"<thead><tr><th>A</th><th>B</th></tr></thead>",
			"<tbody><tr><td>1</td><td>2</td></tr></tbody>",
			"</table>",
		].join("");
		expect(htmlToMarkdown(html)).toContain("| A   | B   |");
		expect(htmlToMarkdown(html)).toContain("| 1   | 2   |");
	});

	it("converts strikethrough via GFM", () => {
		expect(htmlToMarkdown("<p><del>gone</del></p>")).toContain("~~gone~~");
	});

	it("collapses whitespace in htmlToText", () => {
		expect(htmlToText("<div>a\n\n   b</div>")).toBe("a b");
	});

	it("skips DOM conversion when nesting exceeds the official depth guard", () => {
		const html = "<div>".repeat(513) + "x" + "</div>".repeat(513);
		expect(htmlToMarkdown(html)).toBe(html.trim());
		expect(htmlToText(html)).toBe(html.trim());
		expect(pageTitle(html)).toBeUndefined();
		expect(extractHrefs(html, "https://example.com/")).toEqual([]);
	});
});
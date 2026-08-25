import { describe, expect, it } from "vitest";
import { htmlToMarkdown, htmlToText, pageTitle } from "../src/core/html.js";

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
});
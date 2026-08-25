import { describe, expect, it } from "vitest";
import { WebError, type WebFetchResult } from "@deepseek-ai/dsh-web";
import { compositeCrawl, compositeExtract, compositeMap } from "../src/core/composites.js";
import { htmlToMarkdown, htmlToText, pageTitle } from "../src/core/html.js";
import type { CompositeLimits, CrawlRequest, ExtractRequest, FetchLike, MapRequest } from "../src/types.js";

const SITE = "https://site.example";
const LIMITS: CompositeLimits = { extractMaxUrls: 10, crawlMaxPages: 10, mapMaxUrls: 100, perPageChars: 20000 };

interface FakeFetch extends FetchLike {
	calls: string[];
}

function page(finalUrl: string, statusCode: number, kind: "html" | "text", content: string): WebFetchResult {
	return { url: finalUrl, statusCode, body: { kind, content }, truncated: false };
}

/** Route-table fetch double: records every requested URL, throws on unmapped ones. */
function fetchFrom(routes: Record<string, WebFetchResult>): FakeFetch {
	const calls: string[] = [];
	const fetch = async ({ url }: { url: string }): Promise<WebFetchResult> => {
		calls.push(url);
		const hit = routes[url];
		if (hit === undefined) throw new Error("no fixture for " + url);
		return hit;
	};
	return Object.assign(fetch, { calls });
}

function runExtract(request: ExtractRequest, fetch: FetchLike, limits?: Partial<CompositeLimits>) {
	return compositeExtract({ request, fetch, limits: { ...LIMITS, ...limits } });
}

function runCrawl(request: CrawlRequest, fetch: FetchLike, limits?: Partial<CompositeLimits>) {
	return compositeCrawl({ request, fetch, limits: { ...LIMITS, ...limits } });
}

function runMap(request: MapRequest, fetch: FetchLike, limits?: Partial<CompositeLimits>) {
	return compositeMap({ request, fetch, limits: { ...LIMITS, ...limits } });
}

function sitemapUrlset(locs: readonly string[]): string {
	const entries = locs.map((loc) => "<url><loc>" + loc + "</loc></url>").join("");
	return '<?xml version="1.0" encoding="UTF-8"?><urlset>' + entries + "</urlset>";
}

function sitemapIndex(children: readonly string[]): string {
	const entries = children.map((loc) => "<sitemap><loc>" + loc + "</loc></sitemap>").join("");
	return '<?xml version="1.0" encoding="UTF-8"?><sitemapindex>' + entries + "</sitemapindex>";
}

const FIXTURE_HTML = [
	"<!doctype html>",
	"<html>",
	"<head>",
	"<title>Fixture Title</title>",
	"<style>body { color: red }</style>",
	"<script>console.log(\"secret-script-value\")</script>",
	"</head>",
	"<body>",
	"<h1>Welcome Heading</h1>",
	"<p>First &amp; foremost &lt;tagged&gt; &#65;</p>",
	"<ul><li>alpha</li><li>beta</li></ul>",
	"<p>Read <a href=\"/deep\">the deep dive</a>.</p>",
	"</body>",
	"</html>",
].join("\n");

describe("composite map", () => {
	it("expands a sitemapindex exactly one level", async () => {
		const child1 = SITE + "/child-1.xml";
		const child2 = SITE + "/child-2.xml";
		const grandChild = SITE + "/grandchild.xml";
		const routes: Record<string, WebFetchResult> = {
			[SITE + "/robots.txt"]: page(SITE + "/robots.txt", 404, "text", ""),
			[SITE + "/sitemap.xml"]: page(SITE + "/sitemap.xml", 200, "text", sitemapIndex([child1, child2])),
			[child1]: page(child1, 200, "text", sitemapUrlset([SITE + "/p1", SITE + "/p2"])),
			// A nested index must NOT be expanded a second level.
			[child2]: page(child2, 200, "text", sitemapIndex([grandChild])),
		};
		const fetch = fetchFrom(routes);
		const result = await runMap({ url: SITE + "/" }, fetch);
		expect(result.urls).toEqual([SITE + "/p1", SITE + "/p2"]);
		expect(result.truncated).toBe(false);
		expect(fetch.calls).not.toContain(grandChild);
	});

	it("honors Sitemap: directives from robots.txt and keeps same-registrable-domain URLs only", async () => {
		const listed = SITE + "/sitemap-index.xml";
		const foreign = "https://cdn.other.example/external.xml";
		const robots = "User-agent: *\nDisallow: /private\nSitemap: " + listed + "\nSitemap: " + foreign;
		const routes: Record<string, WebFetchResult> = {
			[SITE + "/sitemap.xml"]: page(SITE + "/sitemap.xml", 404, "text", ""),
			[SITE + "/robots.txt"]: page(SITE + "/robots.txt", 200, "text", robots),
			[listed]: page(listed, 200, "text", sitemapUrlset([SITE + "/a", SITE + "/b"])),
			[foreign]: page(foreign, 200, "text", sitemapUrlset(["https://cdn.other.example/x"])),
		};
		const result = await runMap({ url: SITE + "/" }, fetchFrom(routes));
		expect(result.urls).toEqual([SITE + "/a", SITE + "/b"]);
		expect(result.truncated).toBe(false);
	});

	it("fails structured with WEB_OP_FAILED when no sitemap exists anywhere", async () => {
		const routes: Record<string, WebFetchResult> = {
			[SITE + "/robots.txt"]: page(SITE + "/robots.txt", 404, "text", ""),
			[SITE + "/sitemap.xml"]: page(SITE + "/sitemap.xml", 404, "text", ""),
		};
		await expect(runMap({ url: SITE + "/" }, fetchFrom(routes))).rejects.toMatchObject({
			code: "WEB_OP_FAILED",
			message: expect.stringContaining("no sitemap found"),
		});
	});

	it("fails structured when sitemaps exist but list nothing usable on this site", async () => {
		const routes: Record<string, WebFetchResult> = {
			[SITE + "/robots.txt"]: page(SITE + "/robots.txt", 404, "text", ""),
			[SITE + "/sitemap.xml"]: page(
				SITE + "/sitemap.xml",
				200,
				"text",
				sitemapUrlset(["https://foreign.example/only"]),
			),
		};
		await expect(runMap({ url: SITE + "/" }, fetchFrom(routes))).rejects.toMatchObject({
			code: "WEB_OP_FAILED",
			message: expect.stringContaining("list no usable"),
		});
	});

	// Regression guard: collectSameSite must gather EVERY same-site entry BEFORE
	// the cap slice, so the truncated flag compares the true pre-cap total
	// against the post-slice count. A premature loop break used to suppress it.
	it("sets truncated by comparing the pre-cap total against the sliced count", async () => {
		const routes: Record<string, WebFetchResult> = {
			[SITE + "/robots.txt"]: page(SITE + "/robots.txt", 404, "text", ""),
			[SITE + "/sitemap.xml"]: page(
				SITE + "/sitemap.xml",
				200,
				"text",
				sitemapUrlset([
					SITE + "/p1",
					SITE + "/p2",
					SITE + "/p3",
					SITE + "/p4",
					SITE + "/p5",
					"https://foreign.example/x",
				]),
			),
		};
		const result = await runMap({ url: SITE + "/" }, fetchFrom(routes), { mapMaxUrls: 3 });
		expect(result.urls).toHaveLength(3);
		expect(result.truncated).toBe(true);
	});

	it("leaves truncated=false when every entry fits under the cap", async () => {
		const routes: Record<string, WebFetchResult> = {
			[SITE + "/robots.txt"]: page(SITE + "/robots.txt", 404, "text", ""),
			[SITE + "/sitemap.xml"]: page(
				SITE + "/sitemap.xml",
				200,
				"text",
				sitemapUrlset([SITE + "/p1", SITE + "/p2", SITE + "/p3"]),
			),
		};
		const result = await runMap({ url: SITE + "/" }, fetchFrom(routes));
		expect(result.urls).toHaveLength(3);
		expect(result.truncated).toBe(false);
	});

	it("min()s request.maxUrls against the config limit", async () => {
		const routes: Record<string, WebFetchResult> = {
			[SITE + "/robots.txt"]: page(SITE + "/robots.txt", 404, "text", ""),
			[SITE + "/sitemap.xml"]: page(
				SITE + "/sitemap.xml",
				200,
				"text",
				sitemapUrlset([SITE + "/p1", SITE + "/p2", SITE + "/p3", SITE + "/p4", SITE + "/p5"]),
			),
		};
		const result = await runMap({ url: SITE + "/", maxUrls: 2 }, fetchFrom(routes));
		expect(result.urls).toEqual([SITE + "/p1", SITE + "/p2"]);
		expect(result.truncated).toBe(true);
	});
});

describe("composite crawl", () => {
	function linkPage(targets: readonly string[], body: string): string {
		return targets.map((t) => '<a href="' + t + '">x</a>').join("") + body;
	}

	it("respects the visited set on an A-B-A cycle fixture", async () => {
		const routes: Record<string, WebFetchResult> = {
			[SITE + "/a"]: page(SITE + "/a", 200, "html", '<a href="' + SITE + '/b">to b</a>'),
			[SITE + "/b"]: page(SITE + "/b", 200, "html", '<a href="' + SITE + '/a">back home</a>'),
		};
		const fetch = fetchFrom(routes);
		const result = await runCrawl({ url: SITE + "/a" }, fetch);
		expect(result.pages.map((p) => p.url)).toEqual([SITE + "/a", SITE + "/b"]);
		expect(result.truncated).toBe(false);
		expect(fetch.calls).toEqual([SITE + "/a", SITE + "/b"]);
	});

	it("honors includeDomains filters", async () => {
		const routes: Record<string, WebFetchResult> = {
			[SITE + "/home"]: page(
				SITE + "/home",
				200,
				"html",
				'<a href="https://docs.site.example/start">docs</a><a href="' + SITE + '/other">other</a>',
			),
			"https://docs.site.example/start": page("https://docs.site.example/start", 200, "html", "<p>docs body</p>"),
			[SITE + "/other"]: page(SITE + "/other", 200, "html", "<p>never crawled</p>"),
		};
		const fetch = fetchFrom(routes);
		const result = await runCrawl({ url: SITE + "/home", includeDomains: ["docs.site.example"] }, fetch);
		expect(result.pages.map((p) => p.url)).toEqual([SITE + "/home", "https://docs.site.example/start"]);
		expect(fetch.calls).not.toContain(SITE + "/other");
	});

	it("honors excludeDomains filters", async () => {
		const routes: Record<string, WebFetchResult> = {
			[SITE + "/home"]: page(
				SITE + "/home",
				200,
				"html",
				'<a href="https://docs.site.example/start">docs</a><a href="' + SITE + '/other">other</a>',
			),
			"https://docs.site.example/start": page("https://docs.site.example/start", 200, "html", "<p>excluded body</p>"),
			[SITE + "/other"]: page(SITE + "/other", 200, "html", "<p>crawled body</p>"),
		};
		const fetch = fetchFrom(routes);
		const result = await runCrawl({ url: SITE + "/home", excludeDomains: ["docs.site.example"] }, fetch);
		expect(result.pages.map((p) => p.url)).toEqual([SITE + "/home", SITE + "/other"]);
		expect(fetch.calls).not.toContain("https://docs.site.example/start");
	});

	it("sets truncated when crawlMaxPages cuts a non-empty frontier", async () => {
		const routes: Record<string, WebFetchResult> = {
			[SITE + "/a"]: page(SITE + "/a", 200, "html", linkPage([SITE + "/b", SITE + "/c", SITE + "/d"], "")),
			[SITE + "/b"]: page(SITE + "/b", 200, "html", "<p>b</p>"),
			[SITE + "/c"]: page(SITE + "/c", 200, "html", "<p>c</p>"),
			[SITE + "/d"]: page(SITE + "/d", 200, "html", "<p>d</p>"),
		};
		const fetch = fetchFrom(routes);
		const result = await runCrawl({ url: SITE + "/a" }, fetch, { crawlMaxPages: 2 });
		expect(result.pages.map((p) => p.url)).toEqual([SITE + "/a", SITE + "/b"]);
		expect(fetch.calls).toEqual([SITE + "/a", SITE + "/b"]);
		expect(result.truncated).toBe(true);
	});

	it("min()s request.maxPages under the config limit", async () => {
		const routes: Record<string, WebFetchResult> = {
			[SITE + "/a"]: page(SITE + "/a", 200, "html", linkPage([SITE + "/b", SITE + "/c", SITE + "/d"], "")),
			[SITE + "/b"]: page(SITE + "/b", 200, "html", "<p>b</p>"),
			[SITE + "/c"]: page(SITE + "/c", 200, "html", "<p>c</p>"),
			[SITE + "/d"]: page(SITE + "/d", 200, "html", "<p>d</p>"),
		};
		const result = await runCrawl({ url: SITE + "/a", maxPages: 2 }, fetchFrom(routes));
		expect(result.pages).toHaveLength(2);
		expect(result.truncated).toBe(true);
	});

	it("reports truncated=false when the frontier drains exactly at the cap", async () => {
		const routes: Record<string, WebFetchResult> = {
			[SITE + "/a"]: page(SITE + "/a", 200, "html", linkPage([SITE + "/b"], "")),
			[SITE + "/b"]: page(SITE + "/b", 200, "html", "<p>leaf</p>"),
		};
		const result = await runCrawl({ url: SITE + "/a" }, fetchFrom(routes), { crawlMaxPages: 2 });
		expect(result.pages).toHaveLength(2);
		expect(result.truncated).toBe(false);
	});

	it("resolves hrefs against the FINAL post-redirect URL of each step", async () => {
		const routes: Record<string, WebFetchResult> = {
			// The fake fetch already followed a redirect: result.url is NOT the requested URL.
			[SITE + "/start"]: page(SITE + "/redirected/page", 200, "html", '<a href="page-2.html">next</a>'),
			[SITE + "/redirected/page-2.html"]: page(SITE + "/redirected/page-2.html", 200, "html", "<p>end</p>"),
		};
		const fetch = fetchFrom(routes);
		const result = await runCrawl({ url: SITE + "/start" }, fetch);
		expect(fetch.calls[1]).toBe(SITE + "/redirected/page-2.html");
		expect(result.pages.map((p) => p.url)).toEqual([SITE + "/start", SITE + "/redirected/page-2.html"]);
	});
});

describe("composite extract", () => {
	it("caps URLs at extractMaxUrls and flags truncated", async () => {
		const routes: Record<string, WebFetchResult> = {
			[SITE + "/one"]: page(SITE + "/one", 200, "html", "<p>one</p>"),
			[SITE + "/two"]: page(SITE + "/two", 200, "html", "<p>two</p>"),
		};
		const result = await runExtract(
			{ urls: [SITE + "/one", SITE + "/two", SITE + "/three"] },
			fetchFrom(routes),
			{ extractMaxUrls: 2 },
		);
		expect(result.pages.map((p) => p.url)).toEqual([SITE + "/one", SITE + "/two"]);
		expect(result.truncated).toBe(true);
	});

	it("isolates per-page failures into failureReason without throwing", async () => {
		const routes: Record<string, WebFetchResult> = {
			[SITE + "/ok"]: page(SITE + "/ok", 200, "html", "<p>fine</p>"),
			[SITE + "/boom"]: page(SITE + "/boom", 500, "text", ""),
		};
		const fetch: FetchLike = async ({ url }) => {
			if (url === SITE + "/throws") throw new Error("socket exploded");
			const hit = routes[url];
			if (hit === undefined) throw new Error("no fixture for " + url);
			return hit;
		};
		const result = await runExtract({ urls: [SITE + "/ok", SITE + "/boom", SITE + "/throws"] }, fetch);
		expect(result.truncated).toBe(false);
		expect(result.pages[0]).toMatchObject({ url: SITE + "/ok", content: "fine" });
		expect(result.pages[1]).toEqual({ url: SITE + "/boom", failureReason: "HTTP 500" });
		expect(result.pages[2]).toEqual({ url: SITE + "/throws", failureReason: "socket exploded" });
	});

	it("converts HTML to markdown by default and strips script/style/title boilerplate", async () => {
		const routes: Record<string, WebFetchResult> = {
			[SITE + "/doc"]: page(SITE + "/doc", 200, "html", FIXTURE_HTML),
		};
		const result = await runExtract({ urls: [SITE + "/doc"] }, fetchFrom(routes));
		expect(result.truncated).toBe(false);
		const doc = result.pages[0]!;
		expect(doc.title).toBe("Fixture Title");
		expect(doc.content).toContain("# Welcome Heading");
		expect(doc.content).toContain("[the deep dive](/deep)");
		expect(doc.content).toContain("- alpha");
		expect(doc.content).toContain("- beta");
		expect(doc.content).toContain("First & foremost <tagged> A");
		expect(doc.content).not.toContain("secret-script-value");
		expect(doc.content).not.toContain("color: red");
		expect(doc.content).not.toContain("Fixture Title");
	});

	it("converts HTML to plain text when format=text", async () => {
		const routes: Record<string, WebFetchResult> = {
			[SITE + "/doc"]: page(SITE + "/doc", 200, "html", FIXTURE_HTML),
		};
		const result = await runExtract({ urls: [SITE + "/doc"], format: "text" }, fetchFrom(routes));
		const body = result.pages[0]!.content ?? "";
		expect(body).toContain("Welcome Heading");
		expect(body).not.toContain("# Welcome Heading");
		expect(body).not.toContain("secret-script-value");
		expect(body).toContain("First & foremost <tagged> A");
	});

	it("passes text-kind bodies through without conversion", async () => {
		const routes: Record<string, WebFetchResult> = {
			[SITE + "/plain"]: page(SITE + "/plain", 200, "text", "just words"),
		};
		const result = await runExtract({ urls: [SITE + "/plain"] }, fetchFrom(routes));
		expect(result.pages[0]).toMatchObject({ url: SITE + "/plain", content: "just words" });
	});
});

describe("HTML conversion units (html.ts)", () => {
	// Decode-order regression: amp MUST decode last so a double-escaped entity
	// survives as literal text instead of collapsing into markup.
	it("decodes amp last so double escapes stay literal", () => {
		expect(htmlToText("<p>&amp;lt;</p>")).toBe("&lt;");
		expect(htmlToText("<p>&lt;</p>")).toBe("<");
		expect(htmlToMarkdown("<p>x</p>")).toBe("x");
	});

	it("extracts the normalized document title, or undefined when absent or blank", () => {
		expect(pageTitle("<html><title>  Spaced   Out  </title></html>")).toBe("Spaced Out");
		expect(pageTitle("<html><title>   </title></html>")).toBeUndefined();
		expect(pageTitle("<html><body>none</body></html>")).toBeUndefined();
	});
});

/**
 * Universal composite tier: extract/map/crawl as pure algorithms over an
 * injected `FetchLike` seam — never `ctx.web` directly — so they exist for
 * every adapter and unit tests can inject a recorded fake fetch (design §7).
 * Compat floor, not native parity; the router always prefers a native method.
 * @module dsh-web-search-extend/core/composites
 */
import type {
	AdapterRuntime,
	CompositeLimits,
	CrawlRequest,
	CrawlResult,
	ExtractedPage,
	ExtractRequest,
	ExtractResult,
	FetchLike,
	MapRequest,
	MapResult,
} from "../types.js";
import { throwIfSearchAborted } from "./abort.js";
import { opFailed } from "./errors.js";
import { extractHrefs, htmlToMarkdown, htmlToText, pageTitle } from "./html.js";

/** One composite invocation: request + injected fetch seam + bounds. */
export interface CompositeInput<RequestT> {
	readonly request: RequestT;
	/**
	 * Resolved adapter runtime, accepted so every caller can pass one uniform
	 * input object; the pure algorithms never read it (fetch seam only).
	 */
	readonly runtime?: AdapterRuntime;
	readonly fetch: FetchLike;
	readonly signal?: AbortSignal;
	readonly limits: CompositeLimits;
}

/**
 * Sequential extract over `urls`, capped at `limits.extractMaxUrls`. A page
 * failure (non-200, undecodable body, fetch error) becomes that page's
 * failureReason — never a thrown error.
 */
export async function compositeExtract(input: CompositeInput<ExtractRequest>): Promise<ExtractResult> {
	const { request, fetch, signal } = input;
	const format = request.format ?? "markdown";
	const capped = request.urls.slice(0, input.limits.extractMaxUrls);
	const pages: ExtractedPage[] = [];
	for (const url of capped) {
		throwIfSearchAborted(signal);
		pages.push(await readablePage(url, fetch, signal, format));
	}
	return { pages, truncated: request.urls.length > capped.length };
}

async function readablePage(
	url: string,
	fetch: FetchLike,
	signal: AbortSignal | undefined,
	format: "markdown" | "text",
): Promise<ExtractedPage> {
	try {
		const result = await fetch({ url }, signal);
		if (result.statusCode !== 200) return { url, failureReason: `HTTP ${result.statusCode}` };
		if (result.body.kind === "text") return { url, content: result.body.content };
		const html = result.body.content;
		return {
			url,
			title: pageTitle(html),
			content: format === "text" ? htmlToText(html) : htmlToMarkdown(html),
		};
	} catch (error) {
		throwIfSearchAborted(signal);
		return { url, failureReason: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Site URL enumeration: robots.txt `Sitemap:` directives first, then the
 * conventional /sitemap.xml, expanding <sitemapindex> children exactly one
 * level. Keeps same-registrable-domain URLs only, deduplicated, capped at
 * `limits.mapMaxUrls`. No usable sitemap -> WEB_OP_FAILED.
 */
export async function compositeMap(input: CompositeInput<MapRequest>): Promise<MapResult> {
	const { request, fetch, signal } = input;
	const origin = new URL(request.url).origin;
	const site = registrableDomain(request.url);
	const maxUrls = Math.min(input.limits.mapMaxUrls, request.maxUrls ?? Number.POSITIVE_INFINITY);

	const candidates = [`${origin}/sitemap.xml`];
	const robots = await tryRead(fetch, signal, `${origin}/robots.txt`);
	if (robots !== undefined) candidates.push(...sitemapDirectives(robots));

	const urls = new Set<string>();
	const childSitemaps = new Set<string>();
	let sawSitemap = false;
	for (const candidate of candidates) {
		throwIfSearchAborted(signal);
		const xml = await tryRead(fetch, signal, candidate);
		if (xml === undefined) continue;
		sawSitemap = true;
		if (isSitemapIndex(xml)) {
			for (const loc of locEntries(xml)) {
				if (loc !== undefined) childSitemaps.add(loc);
			}
		} else {
			collectSameSite(urls, locEntries(xml), site);
		}
	}
	for (const child of childSitemaps) {
		throwIfSearchAborted(signal);
		const xml = await tryRead(fetch, signal, child);
		if (xml === undefined || isSitemapIndex(xml)) continue;
		collectSameSite(urls, locEntries(xml), site);
	}

	const capped = [...urls].slice(0, maxUrls);
	if (capped.length === 0) {
		throw opFailed(
			"map",
			sawSitemap
				? `sitemaps under ${origin} list no usable ${site ?? "same-site"} URLs`
				: `no sitemap found under ${origin} (checked robots.txt Sitemap: directives and /sitemap.xml); only native providers can map sitemap-less sites`,
		);
	}
	return { urls: capped, truncated: urls.size > capped.length };
}

/**
 * Bounded breadth-first crawl from `request.url`. Every dequeued URL yields
 * one page record (failureReason on failure); only successful HTML pages
 * contribute links, gated to the start site minus/plus domain filters. Stops
 * at `limits.crawlMaxPages` pages or an empty frontier.
 */
export async function compositeCrawl(input: CompositeInput<CrawlRequest>): Promise<CrawlResult> {
	const { request, fetch, signal } = input;
	const maxPages = Math.min(input.limits.crawlMaxPages, request.maxPages ?? Number.POSITIVE_INFINITY);
	const site = registrableDomain(request.url);
	const visited = new Set<string>([request.url]);
	const frontier = [request.url];
	const pages: ExtractedPage[] = [];

	while (frontier.length > 0 && pages.length < maxPages) {
		throwIfSearchAborted(signal);
		const url = frontier.shift();
		if (url === undefined) break;
		const step = await crawlStep(url, fetch, signal);
		pages.push(step.page);
		for (const href of step.links) {
			if (visited.has(href)) continue;
			visited.add(href);
			if (admits(href, site, request)) frontier.push(href);
		}
	}
	return { pages, truncated: pages.length >= maxPages && frontier.length > 0 };
}

interface CrawlStep {
	page: ExtractedPage;
	links: string[];
}

async function crawlStep(url: string, fetch: FetchLike, signal: AbortSignal | undefined): Promise<CrawlStep> {
	try {
		const result = await fetch({ url }, signal);
		if (result.statusCode !== 200) {
			return { page: { url, failureReason: `HTTP ${result.statusCode}` }, links: [] };
		}
		if (result.body.kind === "text") {
			return { page: { url, content: result.body.content }, links: [] };
		}
		const html = result.body.content;
		// Hrefs resolve against the FINAL (post-redirect) URL, per HTML semantics.
		const links = extractHrefs(html, result.url);
		return { page: { url, title: pageTitle(html), content: htmlToMarkdown(html) }, links };
	} catch (error) {
		throwIfSearchAborted(signal);
		return { page: { url, failureReason: error instanceof Error ? error.message : String(error) }, links: [] };
	}
}

function admits(href: string, site: string | undefined, request: CrawlRequest): boolean {
	if (registrableDomain(href) !== site) return false;
	const include = request.includeDomains;
	if (include !== undefined && include.length > 0 && !matchesDomain(href, include)) return false;
	const exclude = request.excludeDomains;
	if (exclude !== undefined && exclude.length > 0 && matchesDomain(href, exclude)) return false;
	return true;
}

function matchesDomain(url: string, domains: readonly string[]): boolean {
	const host = hostnameOf(url);
	if (host === undefined) return false;
	return domains.some((domain) => host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`));
}

/** Fetch-and-return-body for the probe reads (robots.txt, sitemaps); any failure -> undefined. */
async function tryRead(fetch: FetchLike, signal: AbortSignal | undefined, url: string): Promise<string | undefined> {
	try {
		const result = await fetch({ url }, signal);
		if (result.statusCode !== 200) return undefined;
		return result.body.kind === "html" || result.body.kind === "text" ? result.body.content : undefined;
	} catch {
		throwIfSearchAborted(signal);
		return undefined;
	}
}

function sitemapDirectives(robots: string): string[] {
	const found: string[] = [];
	for (const line of robots.split(/\r?\n/)) {
		const match = /^\s*Sitemap:\s*(\S+)\s*$/i.exec(line);
		const directive = match?.[1];
		if (directive !== undefined) found.push(directive);
	}
	return found;
}

function isSitemapIndex(xml: string): boolean {
	return /<sitemapindex[\s>]/i.test(xml);
}

function locEntries(xml: string): (string | undefined)[] {
	return [...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((match) => {
		const raw = match[1];
		if (raw === undefined) return undefined;
		const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(raw.trim());
		const value = (cdata?.[1] ?? raw).trim().replace(/&amp;/gi, "&");
		return value.length > 0 ? value : undefined;
	});
}

// Collects EVERY same-site entry (the final slice applies the cap), so the
// truncated flag compares true pre-cap totals against post-slice counts.
function collectSameSite(urls: Set<string>, candidates: (string | undefined)[], site: string | undefined): void {
	for (const candidate of candidates) {
		if (candidate === undefined || registrableDomain(candidate) !== site) continue;
		urls.add(candidate);
	}
}

// Registrable-domain approximation: last two hostname labels ("a.b.example.co.uk"
// mis-splits to "co.uk"). Adequate compat-floor heuristic; real public-suffix-list
// parsing is deliberately out of scope.
function hostnameOf(url: string): string | undefined {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

function registrableDomain(url: string): string | undefined {
	const labels = (hostnameOf(url) ?? "").split(".").filter((label) => label.length > 0);
	return labels.length >= 2 ? labels.slice(-2).join(".") : undefined;
}

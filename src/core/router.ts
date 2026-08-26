/**
 * The single resolution ladder shared by the provider and every tool (spec
 * section 6): native adapter method -> composite -> structured
 * `WEB_OP_UNSUPPORTED`. One options object per call so new fields never break
 * call sites. Credential resolution and abort handling stay with the caller;
 * this layer only routes and normalizes failures into the WebError taxonomy.
 * @module dsh-web-search-extend/core/router
 */
import { WebError, type WebSearchRequest, type WebSearchResult } from "@deepseek-ai/dsh-web";
import type {
	AdapterRuntime,
	CompositeLimits,
	CrawlRequest,
	CrawlResult,
	ExtractRequest,
	ExtractResult,
	FetchLike,
	MapRequest,
	MapResult,
	ResearchStatus,
	ResearchSubmission,
	WebAdapter,
	WebOperation,
} from "../types.js";
import { abortable, isAbortError, searchAborted, throwIfSearchAborted } from "./abort.js";
import { opUnsupported, providerError } from "./errors.js";
import { compositeCrawl, compositeExtract, compositeMap } from "./composites.js";

/** Spec section 10 defaults, applied when config omits the matching limit. */
export const DEFAULT_EXTRACT_MAX_URLS = 10;
export const DEFAULT_CRAWL_MAX_PAGES = 10;
export const DEFAULT_MAP_MAX_URLS = 100;
export const DEFAULT_PER_PAGE_CHARS = 20000;

/** Per-op request payload accepted by `execute` (research submits a string). */
export type RequestOf<Op extends WebOperation> =
	Op extends "search" ? WebSearchRequest
	: Op extends "extract" ? ExtractRequest
	: Op extends "crawl" ? CrawlRequest
	: Op extends "map" ? MapRequest
	: string;

/** Per-op result returned by `execute` (research resolves its submission). */
export type ResultOf<Op extends WebOperation> =
	Op extends "search" ? WebSearchResult
	: Op extends "extract" ? ExtractResult
	: Op extends "crawl" ? CrawlResult
	: Op extends "map" ? MapResult
	: ResearchSubmission;

/** One `execute` call's inputs. `fetch` feeds the composite tier only. */
export interface ExecuteInput<Op extends WebOperation> {
	readonly op: Op;
	readonly request: RequestOf<Op>;
	readonly adapter: WebAdapter;
	readonly runtime: AdapterRuntime;
	readonly fetch: FetchLike;
	readonly signal?: AbortSignal;
}

/** Inputs for polling one submitted research task (native tier only). */
export interface PollResearchInput {
	readonly requestId: string;
	readonly adapter: WebAdapter;
	readonly runtime: AdapterRuntime;
	readonly signal?: AbortSignal;
}

interface SettingsWithLimits {
	limits?: Partial<CompositeLimits>;
}

/** Resolve the composite limits out of the active provider settings. */
export function compositeLimits(settings: Record<string, unknown>): CompositeLimits {
	const limits = (settings as SettingsWithLimits).limits ?? {};
	return {
		extractMaxUrls: limits.extractMaxUrls ?? DEFAULT_EXTRACT_MAX_URLS,
		crawlMaxPages: limits.crawlMaxPages ?? DEFAULT_CRAWL_MAX_PAGES,
		mapMaxUrls: limits.mapMaxUrls ?? DEFAULT_MAP_MAX_URLS,
		perPageChars: limits.perPageChars ?? DEFAULT_PER_PAGE_CHARS,
	};
}

/** Race one dispatch against cancellation; normalize failures like provider.ts. */
async function settle<T>(operation: Promise<T>, label: string, signal?: AbortSignal): Promise<T> {
	try {
		return await abortable(operation, signal);
	} catch (error) {
		if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
		if (error instanceof WebError) throw error;
		throw providerError(`${label} failed: ${String(error)}`, { cause: error });
	}
}

type LocalRoutableOp = "extract" | "crawl" | "map";

/** The two routing modes surfaced on the settings card. */
const PROVIDER_FIRST = "provider-first";
const LOCAL_ONLY = "local-only";

/**
 * Route one extract/crawl/map call per `settings.routeMode`:
 * - "provider-first" (default): try the adapter's native call; on failure retry
 *   through the zero-quota composite tier and mark the result with an additive
 *   `warnings` entry naming the failure. Aborts always rethrow.
 * - "local-only": go straight to the composite tier without touching the
 *   provider.
 * A missing native method always routes to the composite tier in both modes.
 */
async function routed<T extends object>(
	op: LocalRoutableOp,
	adapter: WebAdapter,
	runtime: AdapterRuntime,
	signal: AbortSignal | undefined,
	native: (() => Promise<T>) | undefined,
	composite: () => Promise<T>,
): Promise<T> {
	const mode = (runtime.settings as { routeMode?: string }).routeMode ?? PROVIDER_FIRST;
	if (mode === LOCAL_ONLY || native === undefined) return composite();
	try {
		return await native();
	} catch (error) {
		const aborted = signal?.aborted === true || isAbortError(error) || (error instanceof WebError && error.code === "WEB_ABORTED");
		if (aborted) throw error;
		const detail = error instanceof Error ? error.message : String(error);
		const result = await composite();
		return Object.assign(result, { warnings: [`${adapter.id} ${op} failed (${detail}); fell back to local ${op}`] });
	}
}

async function dispatch(
	op: WebOperation,
	request: unknown,
	adapter: WebAdapter,
	runtime: AdapterRuntime,
	fetch: FetchLike,
	signal?: AbortSignal,
): Promise<unknown> {
	switch (op) {
		case "search":
			return settle(adapter.search(request as WebSearchRequest, runtime, signal), `Search via "${adapter.id}"`, signal);
		case "extract":
			return routed(
				"extract",
				adapter,
				runtime,
				signal,
				adapter.extract !== undefined
					? () => settle(adapter.extract!(request as ExtractRequest, runtime, signal), `Extract via "${adapter.id}"`, signal)
					: undefined,
				() =>
					settle(
						compositeExtract({ request: request as ExtractRequest, fetch, limits: compositeLimits(runtime.settings), signal }),
						"Composite extract",
						signal,
					),
			);
		case "crawl":
			return routed(
				"crawl",
				adapter,
				runtime,
				signal,
				adapter.crawl !== undefined
					? () => settle(adapter.crawl!(request as CrawlRequest, runtime, signal), `Crawl via "${adapter.id}"`, signal)
					: undefined,
				() =>
					settle(
						compositeCrawl({ request: request as CrawlRequest, fetch, limits: compositeLimits(runtime.settings), signal }),
						"Composite crawl",
						signal,
					),
			);
		case "map":
			return routed(
				"map",
				adapter,
				runtime,
				signal,
				adapter.map !== undefined
					? () => settle(adapter.map!(request as MapRequest, runtime, signal), `Map via "${adapter.id}"`, signal)
					: undefined,
				() =>
					settle(
						compositeMap({ request: request as MapRequest, fetch, limits: compositeLimits(runtime.settings), signal }),
						"Composite map",
						signal,
					),
			);
		case "research":
			if (adapter.submitResearch === undefined) throw opUnsupported(op, adapter.id);
			return settle(adapter.submitResearch(request as string, runtime, signal), `Research via "${adapter.id}"`, signal);
	}
}

/** Route one operation through the native -> composite -> unsupported ladder. */
export function execute<Op extends WebOperation>(input: ExecuteInput<Op>): Promise<ResultOf<Op>> {
	throwIfSearchAborted(input.signal);
	return dispatch(input.op, input.request, input.adapter, input.runtime, input.fetch, input.signal) as Promise<ResultOf<Op>>;
}

/** Poll one submitted research task to a terminal phase (native tier only). */
export function pollResearch(input: PollResearchInput): Promise<ResearchStatus> {
	const { requestId, adapter, runtime, signal } = input;
	throwIfSearchAborted(signal);
	if (adapter.pollResearch === undefined) throw opUnsupported("research", adapter.id);
	return settle(adapter.pollResearch(requestId, runtime, signal), `Research status via "${adapter.id}"`, signal);
}

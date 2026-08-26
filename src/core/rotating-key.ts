/**
 * RotatingKeyAdapter decorator (Step 3). A key source may hold COMMA-
 * SEPARATED keys in one value (a literal `config.apiKey` or one credential
 * ref's stored value); when the backend answers with an auth/rate-limit/quota
 * class error, the decorator retries against the next key BEFORE the error
 * escapes to the chain. Rotation stays inside ONE provider's own resolved
 * value — it never borrows another provider's ref (AGENTS.md incident rule).
 * Diagnostics expose only which key INDEX acted, never key material.
 * @module dsh-web-search-extend/core/rotating-key
 */
import { WebError } from "@deepseek-ai/dsh-web";
import type {
	AdapterRuntime,
	CrawlRequest,
	CrawlResult,
	ExtractRequest,
	ExtractResult,
	MapRequest,
	MapResult,
	ResearchStatus,
	ResearchSubmission,
	SearchAdapter,
} from "../types.js";

/** Additive diagnostic on results of errors: zero-based index of the key used. */
export interface WithKeyIndex {
	readonly keyIndex?: number;
}

/** Serves diagnostics for the key that just served or failed last. */
export type KeyIndexSink = (index: number) => void;

export interface RotatingKeyOptions {
	/** Reports the zero-based index of the key that served a success. */
	readonly onKeyIndex?: KeyIndexSink;
}

/**
 * Auth/rate-limit/quota failures worth burning the next key on. Vendors
 * collapse these into WEB_PROVIDER_ERROR today, so — like quota cooldown —
 * classification is message inspection at this single boundary, test-pinned.
 */
const KEY_ERROR_MESSAGE = /\b(?:401|402|403|429)\b|unauthorized|forbidden|invalid api key|api key invalid|quota|rate limit/i;

export function isKeyError(error: unknown): boolean {
	if (!(error instanceof WebError) || error.code !== "WEB_PROVIDER_ERROR") return false;
	return KEY_ERROR_MESSAGE.test(error.message);
}

/** Split one resolved multi-key value; blanks are not keys. */
function parseKeys(apiKey: string | undefined): string[] {
	return (apiKey ?? "")
		.split(",")
		.map((key) => key.trim())
		.filter((key) => key.length > 0);
}

/**
 * Wrap an adapter so every keyed op rotates through the comma-separated keys
 * of its own resolved value: a non-key error rethrows immediately, a key
 * error tries the next key, and only exhausting ALL keys lets the ORIGINAL
 * last error escape (identity preserved, additive `keyIndex` attached).
 * Single-key and keyless runtimes pass through untouched.
 */
export function rotatingKey(adapter: SearchAdapter, options: RotatingKeyOptions = {}): SearchAdapter {
	async function withRotation<T>(runtime: AdapterRuntime, op: (rotated: AdapterRuntime) => Promise<T>): Promise<T> {
		const keys = parseKeys(runtime.apiKey);
		if (keys.length <= 1) return op(runtime);
		let lastError: unknown;
		for (let index = 0; index < keys.length; index += 1) {
			try {
				const result = await op({ ...runtime, apiKey: keys[index] });
				options.onKeyIndex?.(index);
				return result;
			} catch (error) {
				lastError = error;
				if (!isKeyError(error)) throw error;
			}
		}
		const failedIndex = keys.length - 1;
		options.onKeyIndex?.(failedIndex);
		if (lastError instanceof WebError) Object.assign(lastError as WebError & WithKeyIndex, { keyIndex: failedIndex });
		throw lastError;
	}
	return {
		id: adapter.id,
		label: adapter.label,
		requiresApiKey: adapter.requiresApiKey,
		defaultApiKeyEnv: adapter.defaultApiKeyEnv,
		baseURLEnv: adapter.baseURLEnv,
		defaultBaseURL: adapter.defaultBaseURL,
		available: (runtime) => adapter.available(runtime),
		search: (request, runtime, signal) => withRotation(runtime, (rotated) => adapter.search(request, rotated, signal)),
		...(adapter.extract !== undefined
			? { extract: (request: ExtractRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<ExtractResult> => withRotation(runtime, (rotated) => adapter.extract!(request, rotated, signal)) }
			: {}),
		...(adapter.crawl !== undefined
			? { crawl: (request: CrawlRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<CrawlResult> => withRotation(runtime, (rotated) => adapter.crawl!(request, rotated, signal)) }
			: {}),
		...(adapter.map !== undefined
			? { map: (request: MapRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<MapResult> => withRotation(runtime, (rotated) => adapter.map!(request, rotated, signal)) }
			: {}),
		...(adapter.submitResearch !== undefined && adapter.pollResearch !== undefined
			? {
					submitResearch: (input: string, runtime: AdapterRuntime, signal?: AbortSignal): Promise<ResearchSubmission> =>
						withRotation(runtime, (rotated) => adapter.submitResearch!(input, rotated, signal)),
					pollResearch: (requestId: string, runtime: AdapterRuntime, signal?: AbortSignal): Promise<ResearchStatus> =>
						withRotation(runtime, (rotated) => adapter.pollResearch!(requestId, rotated, signal)),
				}
			: {}),
	};
}

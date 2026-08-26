/**
 * ChainAdapter — ordered failover over registered adapters (Step 2). The chain
 * is itself a `SearchAdapter`, so the provider and router keep seeing a single
 * adapter: per op, members that support it NATIVELY run in chain order; a
 * switchable failure (backend/quota/rate-limit/missing-credential) moves to the
 * next member while non-switchable ones (cancellation, unsupported op, dead-end
 * op) rethrow immediately. Ops with no native member stay absent from the
 * chain, so the router's composite tier serves them exactly as before. Every
 * settled attempt flows through an injected `onAttempt` sink (no-op default)
 * that Step 5's degradation visibility will consume.
 * @module dsh-web-search-extend/core/chain
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
import { capabilitiesOf } from "./capabilities.js";
import { CooldownBoard, isQuotaError } from "./cooldown.js";

/** One member's recorded outcome for a single chain execution (surfaced in Step 5). */
export interface ChainAttempt {
	readonly adapterId: string;
	readonly outcome: "ok" | "failed" | "skipped";
	readonly durationMs: number;
	readonly errorCode?: string;
}

/** Receives every attempt as it settles; Step 5 wires the real consumer. */
export type AttemptSink = (attempt: ChainAttempt) => void;

/** Injection points for the chain; every field is optional with a no-op default. */
export interface ChainOptions {
	/** Attempt stream for degradation visibility; defaults to discarding records. */
	readonly onAttempt?: AttemptSink;
	/** Memory-only cooldown board (D2); cooling members are skipped, retried last-resort. */
	readonly cooldowns?: CooldownBoard;
}

/** Additive degradation trail: errors always carry attempts; degraded
 *  successes (and errors) carry human-readable warnings. Direct success
 *  produces neither. */
export interface WithAttempts {
	readonly attempts?: readonly ChainAttempt[];
	readonly warnings?: readonly string[];
}

/**
 * Errors worth failing over: backend failures (network / 429 / 5xx / quota /
 * vendor auth rejections all normalize to WEB_PROVIDER_ERROR today) and an
 * unresolvable credential on one member that a keyless fallback can still
 * serve. Everything else — cancellation, unsupported/dead-end ops — is either
 * global or structural, so failover would only repeat the same failure.
 */
function switchable(error: unknown): boolean {
	if (!(error instanceof WebError)) return false;
	return error.code === "WEB_PROVIDER_ERROR" || error.code === "WEB_PROVIDER_CREDENTIAL_MISSING";
}

/** Attach the attempt trail without replacing the original error identity. */
function withTrail(error: unknown, attempts: readonly ChainAttempt[], warnings: readonly string[]): unknown {
	if (error instanceof WebError) {
		Object.assign(error as WebError & WithAttempts, { attempts, ...(warnings.length > 0 ? { warnings } : {}) });
	}
	return error;
}

async function runMember<T>(member: SearchAdapter, record: AttemptSink, cooldowns: CooldownBoard | undefined, run: () => Promise<T>): Promise<T> {
	const startedAt = Date.now();
	try {
		const result = await run();
		record({ adapterId: member.id, outcome: "ok", durationMs: Date.now() - startedAt });
		cooldowns?.onSuccess(member.id);
		return result;
	} catch (error) {
		record({
			adapterId: member.id,
			outcome: "failed",
			durationMs: Date.now() - startedAt,
			...(error instanceof WebError ? { errorCode: error.code } : {}),
		});
		if (cooldowns !== undefined && isQuotaError(error)) cooldowns.onQuotaError(member.id);
		throw error;
	}
}

/**
 * Run `op` against the members that support it natively, in order. Members
 * serving a cooldown window are skipped (recorded as `skipped` + a warning)
 * unless EVERY capable member is cooling — then they are all tried
 * last-resort. A switchable failure tries the next member (a "fell back"
 * warning marks each hop); anything else rethrows the ORIGINAL error
 * immediately. Degraded outcomes carry the additive attempts/warnings trail;
 * a first-member success stays metadata-free.
 */
function dispatchOver<T>(members: SearchAdapter[], options: ChainOptions, run: (member: SearchAdapter) => Promise<T>): Promise<T> {
	return (async () => {
		const attempts: ChainAttempt[] = [];
		const warnings: string[] = [];
		const record: AttemptSink = (attempt) => {
			attempts.push(attempt);
			options.onAttempt?.(attempt);
		};
		const { cooldowns } = options;
		let ordered = members;
		if (cooldowns !== undefined) {
			const ready = members.filter((member) => !cooldowns.isCooling(member.id));
			for (const cold of members) {
				if (!ready.includes(cold)) {
					record({ adapterId: cold.id, outcome: "skipped", durationMs: 0 });
					warnings.push(`${cold.id} cooling until ${new Date(cooldowns.coolingUntil(cold.id)!).toISOString()}`);
				}
			}
			if (ready.length > 0) ordered = ready;
		}
		let lastError: unknown;
		let fallbackFrom: string | undefined;
		for (const member of ordered) {
			if (fallbackFrom !== undefined && fallbackFrom !== member.id) {
				warnings.push(`fell back ${fallbackFrom} -> ${member.id}`);
				fallbackFrom = undefined;
			}
			try {
				const result = await runMember(member, record, cooldowns, () => run(member));
				if (warnings.length > 0) Object.assign(result as object, { attempts, warnings });
				return result;
			} catch (error) {
				lastError = error;
				if (!switchable(error)) throw withTrail(error, attempts, warnings);
				fallbackFrom = member.id;
			}
		}
		throw withTrail(lastError, attempts, warnings);
	})();
}

/** Members of the chain that carry `op` natively, in chain order. */
function nativeMembers(members: SearchAdapter[], op: "extract" | "crawl" | "map"): SearchAdapter[] {
	return members.filter((member) => capabilitiesOf(member).has(op));
}

/** The first member whose research protocol is complete (submit + poll), if any. */
function researchMember(members: SearchAdapter[]): SearchAdapter | undefined {
	return members.find((member) => capabilitiesOf(member).has("research"));
}

/**
 * Build the failover adapter over an ordered member list; `undefined` when
 * fewer than two members remain, so a plain config needs no wrapper at all.
 * Research is delegated to the FIRST complete member without failover:
 * request ids are vendor-namespaced, so re-submitting a stranded task to
 * another vendor's protocol would mix incompatible polls.
 */
export function chainOf(members: readonly SearchAdapter[], options: ChainOptions = {}): SearchAdapter | undefined {
	const chain = [...members];
	if (chain.length < 2) return undefined;
	const primary = chain[0]!;
	const researcher = researchMember(chain);
	const adapter: SearchAdapter = {
		id: primary.id,
		label: `Chain(${chain.map((member) => member.id).join(" -> ")})`,
		// Keyless only has to be possible somewhere in the chain for a missing
		// key to be a failover case instead of a hard stop.
		requiresApiKey: chain.every((member) => member.requiresApiKey),
		defaultApiKeyEnv: primary.defaultApiKeyEnv,
		baseURLEnv: primary.baseURLEnv,
		defaultBaseURL: primary.defaultBaseURL,
		available(runtime: AdapterRuntime): boolean {
			return chain.some((member) => member.available(runtime));
		},
		search(request: Parameters<SearchAdapter["search"]>[0], runtime: AdapterRuntime, signal?: AbortSignal): ReturnType<SearchAdapter["search"]> {
			return dispatchOver(chain, options, (member) => member.search(request, runtime, signal));
		},
	};
	if (nativeMembers(chain, "extract").length > 0) {
		adapter.extract = (request: ExtractRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<ExtractResult> =>
			dispatchOver(nativeMembers(chain, "extract"), options, (member) => member.extract!(request, runtime, signal));
	}
	if (nativeMembers(chain, "crawl").length > 0) {
		adapter.crawl = (request: CrawlRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<CrawlResult> =>
			dispatchOver(nativeMembers(chain, "crawl"), options, (member) => member.crawl!(request, runtime, signal));
	}
	if (nativeMembers(chain, "map").length > 0) {
		adapter.map = (request: MapRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<MapResult> =>
			dispatchOver(nativeMembers(chain, "map"), options, (member) => member.map!(request, runtime, signal));
	}
	if (researcher !== undefined) {
		adapter.submitResearch = (input: string, runtime: AdapterRuntime, signal?: AbortSignal): Promise<ResearchSubmission> =>
			researcher.submitResearch!(input, runtime, signal);
		adapter.pollResearch = (requestId: string, runtime: AdapterRuntime, signal?: AbortSignal): Promise<ResearchStatus> =>
			researcher.pollResearch!(requestId, runtime, signal);
	}
	return adapter;
}

/** Cross-field validation problems for one resolved config's failover section. */
export interface ChainResolution {
	/** Effective members: primary followed by valid fallbacks in order. */
	readonly members: readonly SearchAdapter[];
	/** Human-readable rejections: unknown ids, duplicates, self-reference. */
	readonly problems: readonly string[];
}

/**
 * Resolve `[primary, ...fallbacks]` into chain members against the registry.
 * The primary id stays the runtime guard's job (unknown primary already fails
 * structured there); this validates the D3 fallbacks array: unknown ids,
 * duplicates, and self-reference are reported as settings-visible problems.
 */
export function resolveChain(registry: { get(id: string): SearchAdapter | undefined }, providerId: string, fallbacks: readonly string[]): ChainResolution {
	const problems: string[] = [];
	const seen = new Set<string>([providerId]);
	const members: SearchAdapter[] = [];
	const primary = registry.get(providerId);
	if (primary !== undefined) members.push(primary);
	for (const id of fallbacks) {
		if (id === providerId) {
			problems.push(`fallbacks: "${id}" is the active provider and cannot be its own fallback`);
			continue;
		}
		if (seen.has(id)) {
			problems.push(`fallbacks: "${id}" is duplicated`);
			continue;
		}
		const member = registry.get(id);
		if (member === undefined) {
			problems.push(`fallbacks: unknown adapter "${id}"`);
			continue;
		}
		seen.add(id);
		members.push(member);
	}
	return { members, problems: [...new Set(problems)] };
}

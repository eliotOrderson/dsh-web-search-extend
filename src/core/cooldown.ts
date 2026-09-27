/**
 * Cooldown state machine (Step 3). A quota-classified backend failure puts an
 * adapter id on cooldown: a `Retry-After` the upstream server actually sent
 * beats our estimate, because the server knows when its quota resets and we do
 * not; without one the window grows exponentially (base * 2^prior consecutive
 * failures, capped). Any success on that adapter resets the count.
 *
 * The board outlives the process: {@link saveBoard} publishes `{ failures,
 * until }` per adapter into the shared state file and {@link loadBoard} rebuilds
 * the board from it, so a restart no longer spends its first requests
 * rediscovering that a backend is out of quota. Restoration is deliberately
 * lossy — an already-expired window and one further out than the cap are
 * dropped (an uptime gap must not pin an adapter out of rotation indefinitely)
 * while the failure streak survives, because that streak is what keeps the
 * exponential estimate meaningful. Every disk path is best-effort: a missing or
 * corrupt document starts the board cold, and the board itself never touches
 * disk. The clock is injected so tests drive the schedule deterministically.
 * @module dsh-web-search-extend/core/cooldown
 */
import { WebError } from "@deepseek-ai/dsh-web";
import { readState, writeState } from "./state.js";

/** Monotonic-enough millisecond clock; injected for fake-clock tests. */
export type Clock = () => number;

/** First cooldown window; every later consecutive failure doubles it. */
export const DEFAULT_COOLDOWN_BASE_MS = 60_000;
/** Upper bound on any single cooldown window (~30 min, TASK.md step 3). */
export const DEFAULT_COOLDOWN_CAP_MS = 30 * 60_000;
/**
 * Lower bound on a server-supplied delay. `Retry-After: 0` — and an HTTP-date
 * that already passed, which clamps to the same 0 — would otherwise produce a
 * zero-length window, i.e. no cooldown at all, and the very next dispatch would
 * re-hit the endpoint that just refused us. One second is the smallest window
 * that still makes that dispatch skip the adapter.
 */
export const RETRY_AFTER_FLOOR_MS = 1_000;

/**
 * Server-supplied delay carried ON a thrown error. Only adapters whose
 * transport exposes response headers can populate it; vendor SDK errors that
 * drop the headers leave it unset and keep the exponential estimate.
 */
export interface RetryAfterSignal {
	readonly retryAfterMs?: number;
}

/** Name of the carrier property; adapters never spell it themselves. */
const RETRY_AFTER_PROPERTY = "retryAfterMs";

/**
 * Parse an RFC 9110 `Retry-After` header into milliseconds from `now`. Both
 * permitted forms are accepted — delta-seconds (`"120"`) and HTTP-date
 * (`"Wed, 21 Oct 2026 07:28:00 GMT"`) — because servers use both and a value we
 * cannot parse must not silently become a bogus window: a negative (or already
 * elapsed) point in time clamps to 0, anything else unusable yields undefined
 * so the caller falls back to its own estimate.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
	if (header === null) return undefined;
	const value = header.trim();
	if (value === "") return undefined;
	if (/^-?\d+$/.test(value)) {
		const ms = Number(value) * 1_000;
		return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
	}
	const at = Date.parse(value);
	return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Stamp a server-supplied delay onto a thrown error. `WebError` extends the
 * harness's mutable error base, so the signal rides beside the error instead of
 * being smuggled through its message; the chain reads it back with
 * {@link retryAfterMsOf}.
 */
export function markRetryAfter<T extends object>(error: T, retryAfterMs: number | undefined): T {
	if (retryAfterMs !== undefined) Object.assign(error, { [RETRY_AFTER_PROPERTY]: retryAfterMs });
	return error;
}

/** Read {@link markRetryAfter}'s signal back; undefined for anything unusable. */
export function retryAfterMsOf(error: unknown): number | undefined {
	if (error === null || typeof error !== "object") return undefined;
	const value = (error as RetryAfterSignal)[RETRY_AFTER_PROPERTY];
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, value);
}

/**
 * Cooldown trigger, REUSING the chain's switchable classification (captain
 * ruling): everything vendors collapse into WEB_PROVIDER_ERROR today —
 * 429 / quota / 5xx / network — can succeed on a later retry, so it cools the
 * member. WEB_PROVIDER_CREDENTIAL_MISSING is deliberately excluded: a missing
 * key does not heal with time, it rotates keys or fails through.
 */
export function isQuotaError(error: unknown): boolean {
	return error instanceof WebError && error.code === "WEB_PROVIDER_ERROR";
}

export interface CooldownOptions {
	readonly clock?: Clock;
	readonly baseMs?: number;
	readonly capMs?: number;
}

/**
 * One adapter's persisted state. `until` is absent for an adapter whose window
 * has run out but whose failure streak has not: that streak is what rounds the
 * next window up, so it is part of the document even without a live window.
 */
export interface CooldownEntryState {
	readonly failures: number;
	readonly until?: number;
}

/** Serialized board, published under `StateFile.cooldown`. */
export interface CooldownState {
	readonly adapters: Readonly<Record<string, CooldownEntryState>>;
}

/**
 * Adapter-id → cooldown state. Deterministic under an injected clock;
 * `toState`/`fromState` are its only persistence hooks, so the board owns no
 * file I/O of its own.
 */
export class CooldownBoard {
	private readonly failures = new Map<string, number>();
	private readonly until = new Map<string, number>();
	private readonly clock: Clock;
	private readonly baseMs: number;
	private readonly capMs: number;

	constructor(options: CooldownOptions = {}) {
		this.clock = options.clock ?? (() => Date.now());
		this.baseMs = options.baseMs ?? DEFAULT_COOLDOWN_BASE_MS;
		this.capMs = options.capMs ?? DEFAULT_COOLDOWN_CAP_MS;
	}

	/** Whether the adapter is currently serving out a cooldown window. */
	isCooling(adapterId: string): boolean {
		const until = this.until.get(adapterId);
		return until !== undefined && until > this.clock();
	}

	/** Epoch ms when the current window ends, or undefined when not cooling. */
	coolingUntil(adapterId: string): number | undefined {
		return this.isCooling(adapterId) ? this.until.get(adapterId) : undefined;
	}

	/**
	 * Record one quota-classified failure; returns the new window's end. A
	 * usable server-supplied delay replaces the window but never the failure
	 * count: the count is what keeps the exponential schedule meaningful for the
	 * failures where upstream tells us nothing, so it increments either way.
	 */
	onQuotaError(adapterId: string, retryAfterMs?: number): number {
		const priorFailures = this.failures.get(adapterId) ?? 0;
		this.failures.set(adapterId, priorFailures + 1);
		const delay = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
			? Math.min(Math.max(retryAfterMs, RETRY_AFTER_FLOOR_MS), this.capMs)
			: Math.min(this.baseMs * 2 ** priorFailures, this.capMs);
		const until = this.clock() + delay;
		this.until.set(adapterId, until);
		return until;
	}

	/** Any success wipes the failure count AND any active window, so a
	 *  last-resort success puts the adapter straight back into normal rotation. */
	onSuccess(adapterId: string): void {
		this.failures.delete(adapterId);
		this.until.delete(adapterId);
	}

	/** Faithful view of both maps, expired windows included: what the live board
	 *  would decide is what a later {@link fromState} must be able to decide. */
	toState(): CooldownState {
		const adapters: Record<string, CooldownEntryState> = {};
		for (const id of new Set([...this.failures.keys(), ...this.until.keys()])) {
			const failures = this.failures.get(id) ?? 0;
			const until = this.until.get(id);
			adapters[id] = until === undefined ? { failures } : { failures, until };
		}
		return { adapters };
	}

	/**
	 * Rebuild a board from {@link toState}'s output. Anything unrecognizable is
	 * skipped rather than thrown over: a hand-edited or truncated document must
	 * cost a cold start, never a broken search. A window is restored only while
	 * it is still running and within the cap; a longer one would have survived an
	 * uptime gap and kept an adapter out of rotation far past the design bound.
	 */
	static fromState(state: unknown, options: CooldownOptions = {}): CooldownBoard {
		const board = new CooldownBoard(options);
		const adapters = state !== null && typeof state === "object" ? (state as { adapters?: unknown }).adapters : undefined;
		if (adapters === null || typeof adapters !== "object") return board;
		const now = board.clock();
		for (const [id, entry] of Object.entries(adapters as Record<string, unknown>)) {
			if (entry === null || typeof entry !== "object") continue;
			const { failures, until } = entry as { failures?: unknown; until?: unknown };
			if (typeof failures !== "number" || !Number.isFinite(failures) || failures < 0) continue;
			board.failures.set(id, failures);
			if (typeof until === "number" && Number.isFinite(until) && until > now && until <= now + board.capMs) board.until.set(id, until);
		}
		return board;
	}
}

/** Restore a board from the state directory; a missing or unusable document
 *  starts it cold, so an unreadable home costs a backoff, not a failure. */
export function loadBoard(dir: string, options: CooldownOptions = {}): CooldownBoard {
	return CooldownBoard.fromState(readState(dir)?.cooldown, options);
}

/** Publish the board's view of the document. Read-modify-write because the
 *  cooldown slice shares the file with the cache tier: publishing only our own
 *  keys would delete the other writer's. */
export function saveBoard(dir: string, board: CooldownBoard): void {
	const existing = readState(dir);
	writeState(dir, { ...(existing ?? {}), version: existing?.version ?? 1, cooldown: board.toState() });
}

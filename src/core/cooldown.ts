/**
 * Cooldown state machine (Step 3). A quota-classified backend failure puts an
 * adapter id on cooldown for an exponentially growing window (base * 2^prior
 * consecutive failures, capped); any success on that adapter resets the count.
 * Per D2 the board is MEMORY-ONLY: restarts clear it, and there is no file
 * I/O anywhere in this module. The clock is injected so tests drive the
 * schedule deterministically.
 * @module dsh-web-search-extend/core/cooldown
 */
import { WebError } from "@deepseek-ai/dsh-web";

/** Monotonic-enough millisecond clock; injected for fake-clock tests. */
export type Clock = () => number;

/** First cooldown window; every later consecutive failure doubles it. */
export const DEFAULT_COOLDOWN_BASE_MS = 60_000;
/** Upper bound on any single cooldown window (~30 min, TASK.md step 3). */
export const DEFAULT_COOLDOWN_CAP_MS = 30 * 60_000;

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
 * Adapter-id → cooldown state. Pure in-memory logic: no persistence, no
 * network, deterministic under an injected clock.
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

	/** Record one quota-classified failure; returns the new window's end. */
	onQuotaError(adapterId: string): number {
		const priorFailures = this.failures.get(adapterId) ?? 0;
		this.failures.set(adapterId, priorFailures + 1);
		const delay = Math.min(this.baseMs * 2 ** priorFailures, this.capMs);
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
}

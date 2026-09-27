/**
 * Search-result cache (feature 2). A TTL + LRU store keyed by a canonical hash
 * of the logical call, so a repeated `web_search` costs no fresh Firecrawl
 * keyless credit and cannot push a free tier further into its rate limit. The
 * store is pure logic — injected clock, no fs, no network, no timers — and the
 * Lead owns persistence through `core/state.ts` via `toState`/`fromState`.
 *
 * A hit is a DEGRADATION, not a free win: the caller is serving a result that
 * was not fetched now, so it must say so on the warnings trail (see
 * {@link ResultCache.getWithAge}, which exposes the age that marker needs).
 * @module dsh-web-search-extend/core/cache
 */

import { createHash } from "node:crypto";

/** Freshness window: long enough to absorb a repeated query in one session,
 *  short enough that a result is never served an hour stale. */
export const DEFAULT_TTL_MS = 900_000;
/** Capacity cap; the least recently used entry past this is evicted. */
export const DEFAULT_MAX_ENTRIES = 200;
/** Persisted-shape version; an unrecognized version loads as an empty cache. */
const STATE_VERSION = 1;

/** The identity of one cacheable call. */
export interface CacheKeyInput {
	readonly op: string;
	readonly providerId: string;
	/** The vendor request. Only its canonical hash is stored, never the request. */
	readonly request: unknown;
	/** Config/semantics signature: anything else that changes the answer. */
	readonly signature: string;
}

/**
 * JSON text with every object's keys sorted at all depths, so two identical
 * requests written in a different key order encode identically; array order is
 * preserved because it is part of a request's meaning. Values JSON cannot
 * represent follow `JSON.stringify`'s own rules — dropped from objects, `null`
 * in arrays — so encoding is total instead of throwing on whatever the caller
 * passed. `ancestors` holds only the objects on the current path, so a shared
 * acyclic reference is still encoded in full while a true cycle becomes a
 * marker rather than unbounded recursion.
 */
export function canonicalize(value: unknown, ancestors: WeakSet<object> = new WeakSet()): string | undefined {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
			return JSON.stringify(value);
		case "number":
			// NaN/Infinity have no JSON form; JSON.stringify writes null for both.
			return Number.isFinite(value) ? String(value) : "null";
		case "boolean":
			return String(value);
		case "object":
			break;
		default:
			// undefined / function / symbol / bigint: representable nowhere in JSON.
			return undefined;
	}
	const object = value as object;
	if (ancestors.has(object)) return '"[circular]"';
	ancestors.add(object);
	let encoded: string;
	if (Array.isArray(object)) {
		encoded = `[${object.map((item) => canonicalize(item, ancestors) ?? "null").join(",")}]`;
	} else {
		const fields: string[] = [];
		for (const key of Object.keys(object).sort()) {
			const field = canonicalize((object as Record<string, unknown>)[key], ancestors);
			if (field !== undefined) fields.push(`${JSON.stringify(key)}:${field}`);
		}
		encoded = `{${fields.join(",")}}`;
	}
	ancestors.delete(object);
	return encoded;
}

/**
 * Stable sha256 identity of a logical call, unchanged across runs and
 * processes. The four fields are hashed as an array so a field boundary can
 * never be forged by concatenation (`op:"ab", providerId:"c"` must not collide
 * with `op:"a", providerId:"bc"`). The caller's request is only read.
 */
export function cacheKey(input: CacheKeyInput): string {
	const canonical = canonicalize([input.op, input.providerId, input.signature, input.request]) ?? "null";
	return createHash("sha256").update(canonical).digest("hex");
}

/** Injection points; every field is optional and defaults to the production value. */
export interface CacheOptions {
	readonly ttlMs?: number;
	readonly maxEntries?: number;
	/** Millisecond clock, injected so tests drive expiry deterministically. */
	readonly clock?: () => number;
}

/** One stored result with the moment it was stored. */
interface CacheEntry {
	readonly value: unknown;
	readonly storedAt: number;
}

/** A live lookup, carrying the age the hit marker needs. */
export interface CacheHit<T> {
	readonly value: T;
	readonly ageMs: number;
}

/** Counters for degradation visibility; `entries` describes live entries only. */
export interface CacheStats {
	readonly entries: number;
	readonly hits: number;
	readonly misses: number;
	readonly evicted: number;
}

/**
 * Whether a value survives the JSON round-trip persistence performs. A bigint,
 * symbol or function would either make `JSON.stringify` throw on the write path
 * or be silently stripped and later resurrected as a corrupted result, so such
 * a value is refused up front. Nested `undefined` is accepted because JSON
 * drops it exactly as a typed consumer's optional field expects.
 */
function persistable(value: unknown, ancestors: WeakSet<object> = new WeakSet()): boolean {
	switch (typeof value) {
		case "function":
		case "symbol":
		case "bigint":
			return false;
		case "object":
			break;
		default:
			return true;
	}
	if (value === null) return true;
	const object = value as object;
	if (ancestors.has(object)) return false;
	ancestors.add(object);
	const nested: readonly unknown[] = Array.isArray(object) ? object : Object.values(object as Record<string, unknown>);
	const ok = nested.every((item) => persistable(item, ancestors));
	ancestors.delete(object);
	return ok;
}

/**
 * In-memory result store: TTL expiry on read against the injected clock, LRU
 * eviction past `maxEntries`. `toState`/`fromState` move it through
 * `core/state.ts` as hashed keys, payloads and timestamps only — never the raw
 * request, and never credentials or key material of any kind.
 */
export class ResultCache {
	/** Insertion order IS recency order (oldest first), because every hit re-inserts. */
	private readonly entries = new Map<string, CacheEntry>();
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly clock: () => number;
	private hits = 0;
	private misses = 0;
	private evictions = 0;

	constructor(options: CacheOptions = {}) {
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.clock = options.clock ?? (() => Date.now());
	}

	/** Look up a live entry; an expired entry reads as a miss and is dropped. */
	get<T>(key: string): T | undefined {
		return this.getWithAge<T>(key)?.value;
	}

	/**
	 * {@link get} that also reports the entry's age in ms — the value a
	 * degradation marker needs (`cache hit (age 42s)`), and which only the store
	 * can supply because only it knows `storedAt`. Never throws: a hostile value
	 * or a broken injected clock must not fail a search.
	 */
	getWithAge<T>(key: string): CacheHit<T> | undefined {
		try {
			const entry = this.entries.get(key);
			if (entry === undefined) {
				this.misses += 1;
				return undefined;
			}
			const ageMs = this.clock() - entry.storedAt;
			if (ageMs >= this.ttlMs) {
				this.entries.delete(key);
				this.misses += 1;
				return undefined;
			}
			this.entries.delete(key);
			this.entries.set(key, entry);
			this.hits += 1;
			return { value: entry.value as T, ageMs };
		} catch {
			return undefined;
		}
	}

	/**
	 * Store a result and make it the most recently used. Values that cannot
	 * survive persistence (`undefined`, functions, symbols, bigints, cycles) are
	 * not cached at all, rather than served now and lost on restart. Never
	 * throws: a cache is an optimization and must not fail the caller's request.
	 */
	set<T>(key: string, value: T): void {
		try {
			if (value === undefined || !persistable(value)) return;
			this.entries.delete(key);
			this.entries.set(key, { value, storedAt: this.clock() });
			this.trim();
		} catch {
			// Deliberately silent: the search itself already succeeded.
		}
	}

	/** Empty the store and its counters, so a cleared cache reads as a fresh one. */
	clear(): void {
		this.entries.clear();
		this.hits = 0;
		this.misses = 0;
		this.evictions = 0;
	}

	/**
	 * Live counters. `entries` sweeps expiry first so it counts what a lookup can
	 * actually return; `evicted` counts capacity evictions only — a TTL expiry is
	 * reported as a miss and is never an eviction.
	 */
	stats(): CacheStats {
		this.sweep();
		return { entries: this.entries.size, hits: this.hits, misses: this.misses, evicted: this.evictions };
	}

	/**
	 * The persistable slice: hashed lookup keys, payloads and timestamps — never
	 * the raw request, and never credentials or key material. Oldest first, so
	 * `fromState` can restore LRU order, and never carrying an expired entry.
	 */
	toState(): unknown {
		this.sweep();
		return {
			version: STATE_VERSION,
			entries: [...this.entries].map(([key, entry]) => ({ key, value: entry.value, storedAt: entry.storedAt })),
		};
	}

	/**
	 * Rebuild a cache from {@link toState} output. Damaged or unrecognized input
	 * yields an empty cache instead of a throw, and entries already past their TTL
	 * are dropped: a stale state.json must never resurrect a stale result.
	 */
	static fromState(state: unknown, options: CacheOptions = {}): ResultCache {
		const cache = new ResultCache(options);
		try {
			if (typeof state !== "object" || state === null) return cache;
			const { version, entries } = state as { version?: unknown; entries?: unknown };
			if (version !== STATE_VERSION || !Array.isArray(entries)) return cache;
			const now = cache.clock();
			for (const raw of entries) {
				if (typeof raw !== "object" || raw === null) continue;
				const { key, value, storedAt } = raw as { key?: unknown; value?: unknown; storedAt?: unknown };
				if (typeof key !== "string" || typeof storedAt !== "number" || !Number.isFinite(storedAt)) continue;
				if (value === undefined || !persistable(value)) continue;
				if (now - storedAt >= cache.ttlMs) continue;
				cache.entries.set(key, { value, storedAt });
			}
			cache.trim();
		} catch {
			// A partially rebuilt cache is still a valid one; the caller just misses.
		}
		return cache;
	}

	/** Drop entries past their TTL without touching counters: expiry is a
	 *  freshness event, and `misses` stays reserved for lookups that asked. */
	private sweep(): void {
		const now = this.clock();
		for (const [key, entry] of this.entries) {
			if (now - entry.storedAt >= this.ttlMs) this.entries.delete(key);
		}
	}

	/** Enforce the capacity cap in LRU order. */
	private trim(): void {
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) return;
			this.entries.delete(oldest);
			this.evictions += 1;
		}
	}
}

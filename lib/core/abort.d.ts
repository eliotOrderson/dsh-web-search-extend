/**
 * Cancellation handling — a cross-cutting concern owned by the core, not by
 * any adapter. Mirrors the official web-search-provider pattern: race an
 * in-process async step against the caller's `AbortSignal` and surface a
 * stable `WEB_ABORTED` error.
 * @module dsh-web-search-extend/core/abort
 */
import { WebError } from "@deepseek-ai/dsh-web";
/**
 * Race `operation` against caller cancellation. Attached settlement handlers
 * keep observing an uncooperative operation after abort so a late rejection
 * cannot become unhandled.
 */
export declare function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T>;
/** Throw the stable cancellation error when the caller already aborted. */
export declare function throwIfSearchAborted(signal?: AbortSignal): void;
/** Build the stable cancellation error while retaining the caller's reason. */
export declare function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError;
/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
export declare function isAbortError(error: unknown): boolean;
//# sourceMappingURL=abort.d.ts.map
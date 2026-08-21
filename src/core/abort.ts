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
export function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) return operation;
	if (signal.aborted) return Promise.reject(searchAborted(signal));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(searchAborted(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(new Error(String(error).replace(/^Error: /u, ""), { cause: error }));
			},
		);
	});
}

/** Throw the stable cancellation error when the caller already aborted. */
export function throwIfSearchAborted(signal?: AbortSignal): void {
	if (signal?.aborted === true) throw searchAborted(signal);
}

/** Build the stable cancellation error while retaining the caller's reason. */
export function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
	return new WebError("Search aborted", "WEB_ABORTED", {
		cause: signal?.aborted === true ? signal.reason : fallback,
	});
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
export function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

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
export function abortable(operation, signal) {
    if (signal === undefined)
        return operation;
    if (signal.aborted)
        return Promise.reject(searchAborted(signal));
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(searchAborted(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        operation.then((value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
        }, (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(new Error(String(error).replace(/^Error: /u, ""), { cause: error }));
        });
    });
}
/** Throw the stable cancellation error when the caller already aborted. */
export function throwIfSearchAborted(signal) {
    if (signal?.aborted === true)
        throw searchAborted(signal);
}
/** Build the stable cancellation error while retaining the caller's reason. */
export function searchAborted(signal, fallback) {
    return new WebError("Search aborted", "WEB_ABORTED", {
        cause: signal?.aborted === true ? signal.reason : fallback,
    });
}
/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
export function isAbortError(error) {
    return error instanceof DOMException && error.name === "AbortError";
}
//# sourceMappingURL=abort.js.map
/**
 * WebError taxonomy — the single place the plugin's structured error codes are
 * constructed. Adapters and the provider both route through here so the codes
 * stay consistent and the consumer (`dsh-tool-web`) can switch on them.
 * @module dsh-web-search-extend/core/errors
 */
import { WebError } from "@deepseek-ai/dsh-web";
/** A backend/provider failure. */
export declare function providerError(message: string, cause?: unknown): WebError;
/** No credential could be resolved for a key-required backend. */
export declare function credentialMissing(ref: string): WebError;
//# sourceMappingURL=errors.d.ts.map
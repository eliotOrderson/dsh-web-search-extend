/**
 * WebError taxonomy — the single place the plugin's structured error codes are
 * constructed. Adapters and the provider both route through here so the codes
 * stay consistent and the consumer (`dsh-tool-web`) can switch on them.
 * @module dsh-web-search-extend/core/errors
 */
import { WebError } from "@deepseek-ai/dsh-web";
import type { WebOperation } from "../types.js";

/** A backend/provider failure. */
export function providerError(message: string, cause?: unknown): WebError {
	return new WebError(message, "WEB_PROVIDER_ERROR", cause === undefined ? undefined : { cause });
}

/** An operation has neither a native adapter method nor a composite path. */
export function opUnsupported(op: WebOperation, adapterId: string): WebError {
	return new WebError(
		`operation "${op}" is not supported by provider "${adapterId}" (native: none; composite: unavailable). Switch provider or use web_search.`,
		"WEB_OP_UNSUPPORTED",
	);
}

/** An operation ran but produced nothing usable (a composite dead end, not a tool crash). */
export function opFailed(op: WebOperation, reason: string): WebError {
	return new WebError(`operation "${op}" failed: ${reason}`, "WEB_OP_FAILED");
}

/** No credential could be resolved for a key-required backend. */
export function credentialMissing(ref: string): WebError {
	return new WebError(
		`Search has no API key for "${ref}"; store it through the credentials service (the web Models page writes it), export it in the launching environment, or set a literal "apiKey" in the dsh-web-search-extend config`,
		"WEB_PROVIDER_CREDENTIAL_MISSING",
	);
}

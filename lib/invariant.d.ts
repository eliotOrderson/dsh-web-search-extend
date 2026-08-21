/**
 * Package-owned invariant companion for `dsh-web-search-extend`.
 * @module dsh-web-search-extend/invariant
 */
import type { Context } from "@deepseek-ai/cordis";
/** Cordis companion plugin name. */
declare const name = "web-search-extend-invariant";
/** Service required before the companion can reserve package ownership. */
declare const inject: string[];
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
declare const apply: (ctx: Context) => Promise<() => void>;
export { apply, inject, name };
//# sourceMappingURL=invariant.d.ts.map
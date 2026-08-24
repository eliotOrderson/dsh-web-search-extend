//#region invariant
/**
 * Package-owned invariant companion for `dsh-web-search-extend`.
 * @module dsh-web-search-extend/invariant
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-invariants";
const PACKAGE_NAME = "@mr.robot/dsh-web-search-extend";
/** Cordis companion plugin name. */
const name = "web-search-extend-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
 * No runtime invariant: the package emits a pre-dispatch log event but owns no
 * later authoritative dispatch event to relate it to. Exact envelope equality
 * is pinned at the provider boundary instead.
 */
const install = (): void => {};
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
const apply = (ctx: Context): Promise<() => void> =>
	Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion

export { apply, inject, name };

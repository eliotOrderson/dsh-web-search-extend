/**
 * Plugin entry — a drop-in replacement for the official web-search provider.
 *
 * It takes over the official identity where it matters (so nothing downstream
 * changes), while keeping an independent cordis name so a normal bundle install
 * is not accidentally disabled by the patch that disables the official:
 * - settings namespace: `web-search-deepseek` (config page same position)
 * - provider id:        `deepseek-official` (seam/agent selection unchanged)
 * - cordis plugin name: `web-search-extend` (distinct loader identity)
 *
 * The agent keeps calling the OLD `web_search` tool; that tool stays on
 * `ctx.web.search`, which now routes through this plugin's provider into the
 * adapter selected by `config.provider` (deepseek / tavily / demo).
 * @module dsh-web-search-extend
 */
import type { Context } from "@deepseek-ai/cordis";
import { Config, type ConfigType } from "./config.js";
import { createDefaultRegistry } from "./adapters/index.js";
/** Cordis plugin name — independent from the official one on purpose. */
declare const name = "web-search-extend";
/** The web seam this provider registers into. */
declare const inject: string[];
/** Register the replacement search provider with `ctx.web`. */
declare function apply(ctx: Context, config: ConfigType): void;
export { Config, createDefaultRegistry, apply, inject, name };
//# sourceMappingURL=index.d.ts.map
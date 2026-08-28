// Client half for @mr.robot/dsh-web-search-extend.
// Build-free window.__ModuleLoader__ DOM module (same pattern as dsh-synapse).
// Injects into the core WebSearchCard: full provider selector + per-provider
// parameter fields (replacing the core's broken top-level maxUses), and hides
// the endpoint field (implied by provider).

import { createSettingsAccess } from "./settings.js";
import { startCard } from "./injection.js";

window.__ModuleLoader__.load({
  id: "@mr.robot/dsh-web-search-extend",
  factory: () => {
    const module = { exports: {} };
    module.exports.inject = ["settingsScope", "locale"];
    module.exports.apply = (ctx) => {
      let settings;
      try {
        settings = createSettingsAccess(ctx.settingsScope);
      } catch (error) {
        console.warn("[@mr.robot/dsh-web-search-extend] settings scope unavailable", error);
        return;
      }

      startCard({ ctx, settings });
    };
    return module.exports;
  },
});

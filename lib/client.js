// Client half for @mr.robot/dsh-web-search-extend.
// Build-free window.__ModuleLoader__ DOM module (same pattern as dsh-synapse).
// Injects into the core WebSearchCard: provider selector + deepseek.maxUses
// (replacing the core's broken top-level maxUses), and hides the endpoint field
// (implied by provider).
window.__ModuleLoader__.load({
  id: "@mr.robot/dsh-web-search-extend",
  factory: () => {
    const module = { exports: {} };
    module.exports.inject = ["settingsScope"];
    module.exports.apply = (ctx) => {
      let scope;
      try {
        scope = ctx.settingsScope.bind({ namespace: "web-search-deepseek" });
      } catch (error) {
        console.warn("[@mr.robot/dsh-web-search-extend] settings scope unavailable", error);
        return;
      }

      const PROVIDERS = [
        { value: "firecrawl-keyless", label: "Firecrawl（keyless 免注册，默认）" },
        { value: "tavily", label: "Tavily（免密钥）" },
        { value: "deepseek", label: "DeepSeek（官方后端）" },
      ];
      const PROVIDER_MARKER = "data-wse-provider";
      const MAXUSES_MARKER = "data-wse-maxuses";
      const DEFAULT_MAX_USES = 5;
      const DEFAULT_PROVIDER = "firecrawl-keyless";

      const currentProvider = () => {
        try {
          const snap = scope.getSnapshot();
          return snap?.value?.provider ?? snap?.base?.provider ?? DEFAULT_PROVIDER;
        } catch { return DEFAULT_PROVIDER; }
      };

      const currentMaxUses = () => {
        try {
          const snap = scope.getSnapshot();
          const v = snap?.value?.deepseek?.maxUses;
          return typeof v === "number" && v >= 1 ? v : DEFAULT_MAX_USES;
        } catch { return DEFAULT_MAX_USES; }
      };

      // ---- DOM helpers ----

      const findBody = () => {
        const key = document.getElementById("plugin-config-web-search-key");
        if (!key) return null;
        const card = key.closest("li");
        if (!card) return null;
        return [...card.children].find(
          (c) => c.tagName === "DIV" && c.querySelector("#plugin-config-web-search-key"),
        ) ?? null;
      };

      const hideCoreField = (id) => {
        const el = document.getElementById(id);
        if (!el) return;
        const field = el.closest(".At1oFq_field");
        if (field) field.style.display = "none";
      };

      const buildProviderSelect = () => {
        const field = document.createElement("div");
        field.className = "At1oFq_field";
        field.setAttribute(PROVIDER_MARKER, "");

        const head = document.createElement("div");
        head.className = "At1oFq_head";
        const label = document.createElement("label");
        label.className = "At1oFq_label";
        label.textContent = "搜索提供方 (Provider)";
        head.appendChild(label);

        const select = document.createElement("select");
        select.className = "At1oFq_input";
        for (const p of PROVIDERS) {
          const opt = document.createElement("option");
          opt.value = p.value;
          opt.textContent = p.label;
          select.appendChild(opt);
        }
        select.value = currentProvider();
        select.addEventListener("change", () => {
          try {
            scope.set("provider", select.value);
            syncMaxUsesVisibility();
          } catch (e) {
            console.warn("[@mr.robot/dsh-web-search-extend] failed to persist provider", e);
          }
        });

        const hint = document.createElement("p");
        hint.className = "At1oFq_hint";
        hint.textContent = "选择本次搜索使用的后端，接口地址由提供方自动决定。";

        field.appendChild(head);
        field.appendChild(select);
        field.appendChild(hint);
        return field;
      };

      const buildMaxUsesField = () => {
        const field = document.createElement("div");
        field.className = "At1oFq_field";
        field.setAttribute(MAXUSES_MARKER, "");

        const head = document.createElement("div");
        head.className = "At1oFq_head";
        const label = document.createElement("label");
        label.className = "At1oFq_label";
        label.textContent = "单次请求最多搜索次数";
        head.appendChild(label);

        const input = document.createElement("input");
        input.className = "At1oFq_input";
        input.type = "text";
        input.inputMode = "numeric";
        input.value = String(currentMaxUses());
        input.addEventListener("change", () => {
          const raw = input.value.trim();
          const n = raw === "" ? DEFAULT_MAX_USES : Number(raw);
          if (!Number.isFinite(n) || n < 1) { input.value = String(currentMaxUses()); return; }
          try {
            scope.write({ op: "set", path: ["deepseek", "maxUses"], value: n });
          } catch (e) {
            console.warn("[@mr.robot/dsh-web-search-extend] failed to persist maxUses", e);
          }
        });

        const hint = document.createElement("p");
        hint.className = "At1oFq_hint";
        hint.textContent = "仅 DeepSeek 后端有效。留空恢复默认值(5)。";

        field.appendChild(head);
        field.appendChild(input);
        field.appendChild(hint);
        return field;
      };

      // ---- inject / re-inject / sync ----

      const syncMaxUsesVisibility = () => {
        const el = document.querySelector(`[${MAXUSES_MARKER}]`);
        if (!el) return;
        el.style.display = currentProvider() === "deepseek" ? "" : "none";
      };

      const syncSelectValues = () => {
        const providerSel = document.querySelector(`[${PROVIDER_MARKER}] select`);
        if (providerSel) providerSel.value = currentProvider();
        const maxUsesInput = document.querySelector(`[${MAXUSES_MARKER}] input`);
        if (maxUsesInput) maxUsesInput.value = String(currentMaxUses());
        syncMaxUsesVisibility();
      };

      const inject = () => {
        const body = findBody();
        if (!body) return;

        hideCoreField("plugin-config-web-search-endpoint");
        hideCoreField("plugin-config-web-search-max-uses");

        if (!body.querySelector(`[${PROVIDER_MARKER}]`)) {
          body.insertBefore(buildProviderSelect(), body.firstChild);
        }
        if (!body.querySelector(`[${MAXUSES_MARKER}]`)) {
          const afterProvider = body.querySelector(`[${PROVIDER_MARKER}]`);
          if (afterProvider && afterProvider.nextSibling) {
            body.insertBefore(buildMaxUsesField(), afterProvider.nextSibling);
          } else {
            body.appendChild(buildMaxUsesField());
          }
        }

        syncMaxUsesVisibility();
      };

      inject();

      const debounce = (fn, ms) => {
        let t;
        return () => { clearTimeout(t); t = setTimeout(fn, ms); };
      };
      new MutationObserver(debounce(inject, 150)).observe(document.body, { childList: true, subtree: true });

      try {
        scope.subscribe(syncSelectValues);
      } catch { /* best-effort */ }
    };
    return module.exports;
  },
});

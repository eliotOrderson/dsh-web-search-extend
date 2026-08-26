// Client half for @mr.robot/dsh-web-search-extend.
// Build-free window.__ModuleLoader__ DOM module (same pattern as dsh-synapse).
// Injects into the core WebSearchCard: full provider selector + per-provider
// parameter fields (replacing the core's broken top-level maxUses), and hides
// the endpoint field (implied by provider).
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
      const DEFAULT_PROVIDER = "firecrawl-keyless";
      const PROVIDER_MARKER = "data-wse-provider";
      const PARAMS_MARKER = "data-wse-params";
      const paramMarker = (section, key) => `data-wse-param="${section}.${key}"`;

      // Field specs mirror the zod subsections in src/config.ts. Defaults MUST
      // stay aligned with those schema defaults (see AGENTS.md DRIFT RULE).
      // type: select | number | bool | text
      const FIELD_SPECS = {
        "firecrawl-keyless": [],
        tavily: [
          { key: "searchDepth", type: "select", label: "搜索深度", options: ["basic", "advanced"], default: "basic" },
          { key: "topic", type: "select", label: "话题类别", options: ["general", "news"], default: "general" },
          { key: "maxResults", type: "number", label: "单次返回结果数", default: 5 },
          { key: "includeAnswer", type: "bool", label: "附带摘要回答", default: false },
          { key: "timeRange", type: "text", label: "时间范围", default: "", hint: "留空不限；如 day / week / month。" },
          { key: "extractDepth", type: "select", label: "抽取深度", options: ["basic", "advanced"], default: "basic" },
          { key: "researchModel", type: "select", label: "Research 模型", options: ["auto", "mini", "pro"], default: "auto" },
        ],
        deepseek: [
          // model / apiVersion are wire-level internals consumed by the
          // Anthropic-compatible call (body.model / anthropic-version header);
          // kept in the schema for compatibility, deliberately NOT on the card.
          { key: "maxTokens", type: "number", label: "单次最大 Token", default: 4096 },
          { key: "maxUses", type: "number", label: "单次请求最多搜索次数", default: 5 },
        ],
      };

      // ---- config access ----

      const snapSection = (section) => {
        try {
          const snap = scope.getSnapshot();
          return snap?.value?.[section] ?? snap?.base?.[section] ?? {};
        } catch { return {}; }
      };
      const currentProvider = () => {
        try {
          const snap = scope.getSnapshot();
          return snap?.value?.provider ?? snap?.base?.provider ?? DEFAULT_PROVIDER;
        } catch { return DEFAULT_PROVIDER; }
      };

      const writeParam = (section, key, value) => {
        try {
          scope.write({ op: "set", path: [section, key], value });
        } catch (e) {
          console.warn("[@mr.robot/dsh-web-search-extend] failed to persist", section + "." + key, e);
        }
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

      const buildFieldShell = (label) => {
        const field = document.createElement("div");
        field.className = "At1oFq_field";
        const head = document.createElement("div");
        head.className = "At1oFq_head";
        const labelEl = document.createElement("label");
        labelEl.className = "At1oFq_label";
        labelEl.textContent = label;
        head.appendChild(labelEl);
        field.appendChild(head);
        return field;
      };

      const buildHint = (field, text) => {
        if (!text) return;
        const hint = document.createElement("p");
        hint.className = "At1oFq_hint";
        hint.textContent = text;
        field.appendChild(hint);
      };

      const buildProviderSelect = () => {
        const field = buildFieldShell("搜索提供方 (Provider)");
        field.setAttribute(PROVIDER_MARKER, "");
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
            syncParams();
          } catch (e) {
            console.warn("[@mr.robot/dsh-web-search-extend] failed to persist provider", e);
          }
        });
        field.appendChild(select);
        buildHint(field, "选择本次搜索使用的后端，接口地址由提供方自动决定。");
        return field;
      };

      const attachValueControl = (field, spec, section) => {
        const current = () => {
          const v = snapSection(section)[spec.key];
          return v === undefined || v === null ? spec.default : v;
        };
        if (spec.type === "select") {
          const select = document.createElement("select");
          select.className = "At1oFq_input";
          for (const o of spec.options) {
            const opt = document.createElement("option");
            opt.value = o;
            opt.textContent = o;
            select.appendChild(opt);
          }
          select.value = String(current());
          select.addEventListener("change", () => writeParam(section, spec.key, select.value));
          field.appendChild(select);
          return select;
        }
        if (spec.type === "bool") {
          const wrap = document.createElement("div");
          wrap.style.cssText = "display:flex;align-items:center;gap:8px;";
          const box = document.createElement("input");
          box.type = "checkbox";
          box.checked = Boolean(current());
          box.addEventListener("change", () => writeParam(section, spec.key, box.checked));
          const state = document.createElement("span");
          state.textContent = box.checked ? "开" : "关";
          state.style.cssText = "font-size:12px;color:var(--dsw-alias-label-secondary);";
          box.addEventListener("change", () => { state.textContent = box.checked ? "开" : "关"; });
          wrap.appendChild(box);
          wrap.appendChild(state);
          field.appendChild(wrap);
          return box;
        }
        const input = document.createElement("input");
        input.className = "At1oFq_input";
        input.type = spec.type === "number" ? "text" : "text";
        if (spec.type === "number") input.inputMode = "numeric";
        input.value = String(current());
        input.addEventListener("change", () => {
          if (spec.type === "number") {
            const raw = input.value.trim();
            const n = raw === "" ? spec.default : Number(raw);
            if (!Number.isFinite(n) || n < 1) { input.value = String(current()); return; }
            writeParam(section, spec.key, n);
            input.value = String(n);
            return;
          }
          writeParam(section, spec.key, input.value.trim());
        });
        field.appendChild(input);
        return input;
      };

      const buildParamFields = (container) => {
        for (const p of PROVIDERS) {
          const section = p.value;
          const specs = FIELD_SPECS[section] ?? [];
          if (specs.length === 0) continue;
          for (const spec of specs) {
            const field = buildFieldShell(spec.label);
            field.setAttribute("data-wse-param", `${section}.${spec.key}`);
            field.setAttribute("data-wse-for", section);
            attachValueControl(field, spec, section);
            buildHint(field, spec.hint);
            container.appendChild(field);
          }
        }
        const note = document.createElement("p");
        note.className = "At1oFq_hint";
        note.setAttribute("data-wse-param-note", "");
        note.textContent = "Firecrawl keyless 无额外参数；各参数仅对当前所选提供方生效。";
        container.appendChild(note);
      };

      // ---- inject / re-inject / sync ----

      const syncParams = () => {
        const active = currentProvider();
        const container = document.querySelector(`[${PARAMS_MARKER}]`);
        if (container) {
          for (const field of container.querySelectorAll("[data-wse-for]")) {
            field.style.display = field.getAttribute("data-wse-for") === active ? "" : "none";
          }
        }
        const providerSel = document.querySelector(`[${PROVIDER_MARKER}] select`);
        if (providerSel) providerSel.value = active;
      };

      const refreshParamValues = () => {
        for (const field of document.querySelectorAll("[data-wse-param]")) {
          const [section, key] = field.getAttribute("data-wse-param").split(".");
          const spec = (FIELD_SPECS[section] ?? []).find((s) => s.key === key);
          if (!spec) continue;
          const v = snapSection(section)[key];
          const shown = v === undefined || v === null ? spec.default : v;
          const control = field.querySelector("select, input[type=checkbox], input:not([type=checkbox])") ?? field.querySelector("input, select");
          if (!control) continue;
          if (spec.type === "bool") control.checked = Boolean(shown);
          else control.value = String(shown);
        }
      };

      const inject = () => {
        const body = findBody();
        if (!body) return;

        hideCoreField("plugin-config-web-search-endpoint");
        hideCoreField("plugin-config-web-search-max-uses");

        if (!body.querySelector(`[${PROVIDER_MARKER}]`)) {
          body.insertBefore(buildProviderSelect(), body.firstChild);
        }
        let container = body.querySelector(`[${PARAMS_MARKER}]`);
        if (!container) {
          container = document.createElement("div");
          container.setAttribute(PARAMS_MARKER, "");
          const providerSel = body.querySelector(`[${PROVIDER_MARKER}]`);
          if (providerSel && providerSel.nextSibling) {
            body.insertBefore(container, providerSel.nextSibling);
          } else {
            body.appendChild(container);
          }
          buildParamFields(container);
        }

        syncParams();
        refreshParamValues();
      };

      inject();

      const debounce = (fn, ms) => {
        let t;
        return () => { clearTimeout(t); t = setTimeout(fn, ms); };
      };
      new MutationObserver(debounce(inject, 150)).observe(document.body, { childList: true, subtree: true });

      try {
        scope.subscribe(() => { syncParams(); refreshParamValues(); });
      } catch { /* best-effort */ }
    };
    return module.exports;
  },
});

// Client half for @mr.robot/dsh-web-search-extend.
// Build-free window.__ModuleLoader__ DOM module (same pattern as dsh-synapse).
// Injects into the core WebSearchCard: full provider selector + per-provider
// parameter fields (replacing the core's broken top-level maxUses), and hides
// the endpoint field (implied by provider).

// ============================================================
// EDIT TEXTS HERE — all user-visible strings, per locale.
// Keys are stable identifiers; values are free-form. The active
// locale comes from the harness locale service ("zh" | "en");
// unknown keys fall back to zh, missing locales fall back too.
// ============================================================
const I18N = {
	zh: {
		providerLabel: "搜索提供方 (Provider)",
		providerHint: "选择本次搜索使用的后端，接口地址由提供方自动决定。",
        provider_tavily: "Tavily（免密钥 Search）",
		provider_firecrawl_keyless: "Firecrawl（免密钥 Search, default）",
		provider_deepseek: "DeepSeek（官方后端）",
		routeModeLabel: "路由模式（extract / crawl / map）",
		route_provider_first: "优先提供商，失败走本地",
		route_local_only: "仅本地",
		"tavily.searchDepth.label": "搜索深度",
		"tavily.searchDepth.hint": "basic 快而省（1 credit）；advanced 深挖更多来源并重排（约 2 credits）；fast / ultra-fast 为低延迟档。",
		"tavily.topic.label": "话题类别",
		"tavily.topic.hint": "general 常规网页；news 新闻源、时效优先；finance 财经数据源。",
		"tavily.maxResults.label": "单次返回结果数",
		"tavily.maxResults.hint": "单次搜索返回的结果条数上限。",
		"tavily.includeAnswer.label": "附带摘要回答",
		"tavily.includeAnswer.hint": "由后端在结果之外再生成一段摘要回答。",
		"tavily.timeRange.label": "时间范围",
		"tavily.timeRange.hint": "限制结果发布时间：day / week / month / year，留空不限。",
		"tavily.extractDepth.label": "抽取深度",
		"tavily.extractDepth.hint": "basic 常规抽取；advanced 提取更完整（含页面嵌入内容），更慢、更耗配额。",
		"tavily.researchModel.label": "Research 模型",
		"tavily.researchModel.hint": "research 异步任务所用模型：auto 自选 / mini 快 / pro 强。",
		"deepseek.maxTokens.label": "单次最大 Token",
		"deepseek.maxTokens.hint": "每次服务端搜索调用的响应 Token 上限，影响成本与截断点。",
		"deepseek.maxUses.label": "单次请求最多搜索次数",
		"deepseek.maxUses.hint": "单次对话内允许工具执行的搜索次数上限。",
	},
	en: {
		providerLabel: "Search provider",
		providerHint: "Choose the backend serving each search; the endpoint follows automatically.",
        provider_tavily: "Tavily (keyless-search)",
		provider_firecrawl_keyless: "Firecrawl (keyless-search, default)",
		provider_deepseek: "DeepSeek",
		routeModeLabel: "Router mode（extract / crawl / map）",
		route_provider_first: "Provider first, fall back to local",
		route_local_only: "Local only",
		"tavily.searchDepth.label": "Search depth",
		"tavily.searchDepth.hint": "basic is fast and cheap (1 credit); advanced digs deeper and re-ranks (~2 credits); fast / ultra-fast are low-latency tiers.",
		"tavily.topic.label": "Topic",
		"tavily.topic.hint": "general covers the open web; news favors news sources and recency; finance targets financial sources.",
		"tavily.maxResults.label": "Max results",
		"tavily.maxResults.hint": "Upper bound on results returned per search.",
		"tavily.includeAnswer.label": "Include answer",
		"tavily.includeAnswer.hint": "Generates a short summary answer alongside the results.",
		"tavily.timeRange.label": "Time range",
		"tavily.timeRange.hint": "Restrict results to day / week / month / year; leave empty for no limit.",
		"tavily.extractDepth.label": "Extract depth",
		"tavily.extractDepth.hint": "basic is standard extraction; advanced pulls fuller content (embedded data), slower and costlier.",
		"tavily.researchModel.label": "Research model",
		"tavily.researchModel.hint": "Model for async research tasks: auto / mini (fast) / pro (strongest).",
		"deepseek.maxTokens.label": "Max tokens per search",
		"deepseek.maxTokens.hint": "Response token ceiling of each server-side search call; affects cost and truncation.",
		"deepseek.maxUses.label": "Max searches per request",
		"deepseek.maxUses.hint": "How many times the tool may search within one conversation turn.",
	},
};

window.__ModuleLoader__.load({
  id: "@mr.robot/dsh-web-search-extend",
  factory: () => {
    const module = { exports: {} };
    module.exports.inject = ["settingsScope", "locale"];
    module.exports.apply = (ctx) => {
      let scope;
      try {
        scope = ctx.settingsScope.bind({ namespace: "web-search-deepseek" });
      } catch (error) {
        console.warn("[@mr.robot/dsh-web-search-extend] settings scope unavailable", error);
        return;
      }

      const readLang = () => {
        try {
          return ctx.locale?.getSnapshot?.()?.active === "en" ? "en" : "zh";
        } catch { return "zh"; }
      };

      const PROVIDERS = [
        { value: "tavily", labelKey: "provider_tavily" },
        { value: "firecrawl-keyless", labelKey: "provider_firecrawl_keyless" },
        { value: "deepseek", labelKey: "provider_deepseek" },
      ];
      const DEFAULT_PROVIDER = "firecrawl-keyless";
      const ROUTE_PROVIDER_FIRST = "provider-first";
      const ROUTE_LOCAL_ONLY = "local-only";
      const PROVIDER_MARKER = "data-wse-provider";
      const PARAMS_MARKER = "data-wse-params";

      // Field specs mirror the zod subsections in src/config.ts. Defaults MUST
      // stay aligned with those schema defaults (see AGENTS.md DRIFT RULE).
      // type: select | number | bool | text ; label/hint keys resolve via I18N.
      const FIELD_SPECS = {
        "firecrawl-keyless": [],
        tavily: [
          { key: "searchDepth", type: "select", options: ["basic", "advanced", "fast", "ultra-fast"], default: "basic" },
          { key: "topic", type: "select", options: ["general", "news", "finance"], default: "general" },
          { key: "maxResults", type: "number", default: 5 },
          { key: "includeAnswer", type: "bool", default: false },
          { key: "timeRange", type: "text", default: "" },
          { key: "extractDepth", type: "select", options: ["basic", "advanced"], default: "basic" },
          { key: "researchModel", type: "select", options: ["auto", "mini", "pro"], default: "auto" },
        ],
        deepseek: [
          // model / apiVersion are wire-level internals consumed by the
          // Anthropic-compatible call (body.model / anthropic-version header);
          // kept in the schema for compatibility, deliberately NOT on the card.
          { key: "maxTokens", type: "number", default: 4096 },
          { key: "maxUses", type: "number", default: 5 },
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

      const buildFieldShell = (labelText) => {
        const field = document.createElement("div");
        field.className = "At1oFq_field";
        const head = document.createElement("div");
        head.className = "At1oFq_head";
        const labelEl = document.createElement("label");
        labelEl.className = "At1oFq_label";
        labelEl.textContent = labelText;
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

      const ROUTE_OPTIONS = [
        { value: ROUTE_LOCAL_ONLY, labelKey: "route_local_only" },
        { value: ROUTE_PROVIDER_FIRST, labelKey: "route_provider_first" },
      ];

      const buildRouteModeSelect = (t) => {
        const field = buildFieldShell(t("routeModeLabel"));
        field.setAttribute("data-wse-route", "");
        const select = document.createElement("select");
        select.className = "At1oFq_input";
        for (const o of ROUTE_OPTIONS) {
          const opt = document.createElement("option");
          opt.value = o.value;
          opt.textContent = t(o.labelKey);
          select.appendChild(opt);
        }
        const current = () => {
          try {
            const snap = scope.getSnapshot();
            return snap?.value?.routeMode ?? snap?.base?.routeMode ?? ROUTE_PROVIDER_FIRST;
          } catch { return PROVIDER_FIRST; }
        };
        select.value = current();
        select.addEventListener("change", () => {
          try {
            scope.set("routeMode", select.value);
          } catch (e) {
            console.warn("[@mr.robot/dsh-web-search-extend] failed to persist routeMode", e);
          }
        });
        field.appendChild(select);
        return field;
      };

      // The official badge claims search is unavailable without a key - false
      // for firecrawl/tavily. Hide it; no replacement text is rendered.
      const hideOfficialBadge = () => {
        const body = findBody();
        if (!body) return;
        const badges = body.querySelector(".At1oFq_badges");
        if (badges) badges.style.display = "none";
      };

      const buildProviderSelect = (t) => {
        const field = buildFieldShell(t("providerLabel"));
        field.setAttribute(PROVIDER_MARKER, "");
        const select = document.createElement("select");
        select.className = "At1oFq_input";
        for (const p of PROVIDERS) {
          const opt = document.createElement("option");
          opt.value = p.value;
          opt.textContent = t(p.labelKey);
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
        buildHint(field, t("providerHint"));
        return field;
      };

      const attachValueControl = (field, spec, section, t) => {
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
          wrap.appendChild(box);
          field.appendChild(wrap);
          return box;
        }
        const input = document.createElement("input");
        input.className = "At1oFq_input";
        input.type = "text";
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

      const buildParamFields = (container, t) => {
        for (const p of PROVIDERS) {
          const section = p.value;
          const specs = FIELD_SPECS[section] ?? [];
          if (specs.length === 0) continue;
          for (const spec of specs) {
            const field = buildFieldShell(t(`${section}.${spec.key}.label`));
            field.setAttribute("data-wse-param", `${section}.${spec.key}`);
            field.setAttribute("data-wse-for", section);
            attachValueControl(field, spec, section, t);
            buildHint(field, t(`${section}.${spec.key}.hint`));
            container.appendChild(field);
          }
        }
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

      const teardownInjected = () => {
        for (const el of document.querySelectorAll(`[${PROVIDER_MARKER}],[${PARAMS_MARKER}]`)) el.remove();
      };

      const inject = () => {
        const body = findBody();
        if (!body) return;

        hideCoreField("plugin-config-web-search-endpoint");
        hideCoreField("plugin-config-web-search-max-uses");

        const t = (k) => I18N[readLang()]?.[k] ?? I18N.zh[k] ?? k;

        // Insert provider first, THEN the toggle - each lands at firstChild,
        // so final order is [fallback toggle, provider select, ...params].
        if (!body.querySelector(`[${PROVIDER_MARKER}]`)) {
          body.insertBefore(buildProviderSelect(t), body.firstChild);
        }
        if (!body.querySelector(`[data-wse-route]`)) {
          body.insertBefore(buildRouteModeSelect(t), body.firstChild);
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
          buildParamFields(container, t);
        }

        syncParams();
        refreshParamValues();
        hideOfficialBadge();
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

      try {
        ctx.locale?.subscribe?.(() => {
          teardownInjected();
          inject();
        });
      } catch { /* best-effort */ }
    };
    return module.exports;
  },
});

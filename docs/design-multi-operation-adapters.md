# Design: Multi-Operation Web Adapters

Status: DRAFT for review - no implementation yet.
Scope: `@mr.robot/dsh-web-search-extend` v0.2.0.

## 1. Summary

The plugin currently exposes exactly one operation (`search`) through one adapter interface method, so Tavily's native `extract` / `crawl` / `map` / `research` are unreachable. This design adds them via three tiers - **native -> composite -> structured error** - so a single provider can be used to its full depth while any other provider degrades predictably instead of breaking.

## 2. Background facts (verified against installed packages)

- The seam `@deepseek-ai/dsh-web` defines only two capability kinds: `WebSearchProvider.search()` and `WebFetchProvider.fetch()`, over deliberately closed result vocabularies. Crawl/map/research cannot pass through it; changing it is out of scope (upstream package).
- The seam service itself dispatches `ctx.web.search(request, signal)` and `ctx.web.fetch(request, signal)` with execution-time provider selection (`searchProvider`/`fetchProvider` config, or `DSH_WEB_SEARCH_PROVIDER` / `DSH_WEB_FETCH_PROVIDER` env). Composites can ride `ctx.web.fetch()`.
- `ctx.web.fetch` today resolves to the local fetch provider. Registering a second usable fetch provider without configuring `fetchProvider` throws `WEB_PROVIDER_AMBIGUOUS` at call time.
- Model-facing tools are registered by plugins through the `tools` + `systemPrompt` services (how `dsh-tool-web` registers `web_search`/`web_fetch`).
- `@tavily/core` 0.7.x surface (all confirmed in dist/index.d.ts):
  - `extract(urls, { format, extractDepth, query })` -> `{ results: [{url,title,rawContent}], failedResults: [{url,error}] }`
  - `crawl(url, { maxDepth, maxBreadth, limit, selectPaths, excludePaths, allowExternal, format, instructions })` -> `{ results: [{url, rawContent}] }`
  - `map(url, { maxDepth, maxBreadth, limit, selectDomains, excludePaths })` -> `{ results: string[] }`
  - `research(input, { model: mini|pro|auto, citationFormat })` -> `{ requestId, status }` (**async submit**), then `getResearch(requestId)` -> complete `{ status, content, sources:[{title,url}] }` or incomplete `{ requestId, status }`
  - Keyless mode covers search only; other endpoints reject without an API key (`TavilyKeylessLimitError`).

## 3. Confirmed decisions

1. **Full three-tier fallback**: native ops, universal composites for extract/map/crawl, structured errors otherwise.
2. **Research exposed, off by default** (`config.tools.research = false`).
3. **Fetch takeover as opt-in config** (`fetchBackend: "local" | "adapter"`, default `"local"`).
4. This document is approved before any code changes.

## 4. Operation vocabulary (plugin-owned)

New types live in `src/types.ts`. Nothing is added to `@deepseek-ai/dsh-web`.

```ts
export type WebOperation = "search" | "extract" | "crawl" | "map" | "research";

export interface ExtractRequest {
	readonly urls: readonly string[];
	/** Guided-extraction hint; honored natively by Tavily, ignored by the composite. */
	readonly query?: string;
	readonly format?: "markdown" | "text";
}

export interface ExtractedPage {
	readonly url: string;
	readonly title?: string;
	/** Readable content in the requested format. */
	readonly content?: string;
	/** Per-URL failure reason; a page-level failure is not a tool failure. */
	readonly failureReason?: string;
}

/** Shared by extract and crawl: a list of fetched-and-readable pages. */
export interface PageResult {
	readonly pages: readonly ExtractedPage[];
	readonly truncated: boolean;
}
export type ExtractResult = PageResult;
export type CrawlResult = PageResult;

export interface MapRequest { readonly url: string; readonly maxUrls?: number; }
export interface MapResult { readonly urls: readonly string[]; readonly truncated: boolean; }

/** research is a submit/poll protocol (the Tavily API is asynchronous). */
export type ResearchPhase = "pending" | "completed" | "failed" | "unknown";
export interface ResearchSubmission { readonly requestId: string; readonly status: ResearchPhase; }
export interface ResearchStatus {
	readonly requestId: string;
	readonly status: ResearchPhase;
	readonly content?: string;
	readonly sources?: readonly WebSearchSource[];
}

/** Terminal phases; consumers branch on this predicate instead of a redundant flag. */
export function isResearchComplete(status: ResearchPhase): boolean
```

Rationale: crawl reuses the extract shape because both answer "content per URL"; a separate identical type would be noise. `WebSearchSource` is imported from the seam for research citations. No `completed` boolean: it is derivable from `status` and two encodings of one fact can disagree — hence the closed `ResearchPhase` union plus the `isResearchComplete()` predicate living beside it. Vendor status strings that fall outside the union map to `"unknown"` (never invented states).

## 5. Adapter interface v2

Optional methods express vendor depth; **capabilities are derived from method presence**, never declared separately (one source of truth, cannot drift):

```ts
export interface WebAdapter extends SearchAdapterShape {
	extract?(request: ExtractRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<ExtractResult>;
	crawl?(request: CrawlRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<CrawlResult>;
	map?(request: MapRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<MapResult>;
	submitResearch?(input: string, runtime: AdapterRuntime, signal?: AbortSignal): Promise<ResearchSubmission>;
	pollResearch?(requestId: string, runtime: AdapterRuntime, signal?: AbortSignal): Promise<ResearchStatus>;
}

// src/core/capabilities.ts
export function capabilitiesOf(adapter: WebAdapter): ReadonlySet<WebOperation>
```

Existing `SearchAdapter` fields (`id`, `label`, credential/baseURL metadata, `available()`, `search()`) are unchanged; the interface gains optional methods only. `capabilitiesOf()` checks `typeof adapter.extract === "function"` etc.

Capability pinning: derivation is implicit knowledge (a renamed method silently shrinks capability, invisible to the compiler), so every bundled adapter gets one unit test asserting its exact derived capability set - tavily: all five; deepseek/demo: `search` only. The tests are the loud failure mode for what TypeScript cannot see.

### Native coverage after the change

- `tavily`: all five operations native (`submitResearch`+`pollResearch` wrap `client.research`/`client.getResearch`; poll maps `status`+`content`+`sources[].title/url` into `ResearchStatus`).
- `deepseek`, `demo`: `search` only - they get composites automatically.
- Future adapters (Firecrawl: extract/crawl/map native; Exa: search+extract native) plug in by implementing methods; the core does not change.

## 6. Core router

One resolution ladder in `src/core/router.ts`, used by the provider (for `search`) and by every new tool (for all ops):

```
execute(op):
  1. adapter[op] exists     -> call native, map errors via errors.ts
  2. COMPOSITES[op] exists  -> run composite (section 7)   [extract/crawl/map only]
  3. otherwise              -> throw opUnsupported(op, adapter)
```

Credential resolution, abort handling, and the WebError taxonomy stay exactly where they are today (`ExtensibleWebSearchProvider.apiKey` + `abort.ts`); the router reuses them so every tier fails identically on missing keys/cancellation.

Arity guardrail: `execute()` takes a single destructured options object (`{ op, request, adapter, runtime, limits, signal }`) - two parameters, and future fields never break call sites.

## 7. Composite tier (universal compatibility floor)

Composites do **not** use adapter primitives. They ride `ctx.web.fetch()`, so they exist for every provider - including pure-search backends - and reuse the local provider's redirect/size handling. Implementation: `src/core/composites.ts` (algorithms) + `src/core/html.ts` (the HTML-to-text converter as its own module - it iterates for quality reasons unrelated to routing policy).

- **extract(urls)**: per URL (capped by `limits.extractMaxUrls`, default 10, sequential, abort-aware): `ctx.web.fetch({url})` -> status 200 -> convert HTML to text/markdown (naive converter: drop script/style/nav noise, keep headings/links/lists, collapse whitespace); non-200 or undecodable body -> `failureReason` on that page. Never throws for single-page failures.
- **map(url)**: try `robots.txt` first (`Sitemap:` lines), then `/sitemap.xml` (+ one level of sitemap-index `<loc>` expansion). Parse `<loc>` entries, dedupe, keep same-registrable-domain URLs, cap at `limits.mapMaxUrls` (default 100). No sitemap found -> `WEB_OP_FAILED` with a hint that only native providers can map sitemap-less sites.
- **crawl(url)**: bounded BFS. Frontier seeded with the start URL; each step fetches via `ctx.web.fetch`, converts like extract, extracts same-domain `href`s for the next frontier (visited set prevents cycles), until `limits.crawlMaxPages` (default 10) or empty frontier. Honors request-level `includeDomains`/`excludeDomains`.

Quality statement (honest): composites are a compat floor, not parity. Naive HTML conversion loses layout-dependent content; BFS crawl is shallower than Tavily's semantic crawl. When a native path exists the router always prefers it.

## 8. Tool layer

New module tree `src/tools/`: one module per tool (`extract.ts`, `crawl.ts`, `map.ts`, `research.ts`), each owning its own schema, formatter, and registration; `index.ts` only wires them - mirroring how `dsh-tool-web` splits search/fetch instead of growing a five-tool god-file. `inject` becomes `["web", "tools", "systemPrompt"]`. Tools are registered once at `apply()` regardless of active provider - switching provider never changes the tool surface, only which tier serves each call.

| Tool | Arguments (schema) | Behavior |
| :--- | :--- | :--- |
| `web_extract` | `urls: string[]` (1-10), `query?`, `format?` | Router op `extract` |
| `web_crawl` | `url: string`, `maxPages?`, `includeDomains?`, `excludeDomains?` | Router op `crawl` |
| `web_map` | `url: string`, `maxUrls?` | Router op `map` |
| `web_research` | `input: string` | Router op `research` submit; returns requestId + status |
| `web_research_status` | `requestId: string` | Router op `research` poll; returns status/content/sources |

- Output v1 is formatted markdown text (per-page title + URL + fenced content, truncated per `limits.perPageChars`); UI cards can be layered later exactly like `dsh-tool-web` meta, but are explicitly out of scope here.
- Timeouts: each tool gets `ToolDefinition.timeoutMs` (default aligned with `DEFAULT_WEB_TOOL_TIMEOUT_MS = 30000`). Research polling is agent-driven (call `web_research_status` again later); no long-blocking tool call.
- Prompt guidance: short systemPrompt section describing when to prefer extract vs fetch, that crawl/map have native quality on some providers, and that research costs credits and should be polled with >=20 s gaps.
- Registration gating: `config.tools.{extract,crawl,map}` (default true) and `config.tools.research` (**default false**) control registration, not runtime capability. Runtime capability failures are structured errors:

```
WEB_OP_UNSUPPORTED: operation "research" is not supported by provider "deepseek"
  (native: none; composite: unavailable). Switch provider or use web_search.
```

Execution-time capability checks happen in the router (section 6), so keyless Tavily rejecting `extract` surfaces as its existing keyless-limit/credential error, not a silent fallback.

## 9. Fetch backend takeover (opt-in)

When `config.fetchBackend === "adapter"`, `apply()` additionally registers a `WebFetchProvider` with id `web-search-extend`: `fetch({url})` runs router op `extract` for that single URL and projects into `WebFetchResult { url, statusCode (200, or 502 mapping on page failure), body: { kind: "text", content }, truncated }`.

Selection stays explicit per the seam's ambiguity rule: users must set `fetchProvider: "web-search-extend"` (settings) or `DSH_WEB_FETCH_PROVIDER` (env). Default `"local"` registers nothing - zero behavior change today.

Note: active adapter = Tavily AND fetchBackend = "adapter" routes composite extract through the Tavily-backed fetch provider - an upgrade, not recursion (extract never calls extract).

## 10. Config schema additions (src/config.ts)

```ts
Config = z.object({
	provider, apiKey, apiKeyEnv, baseURL,          // unchanged
	fetchBackend: z.string().default("local"),     // "local" | "adapter"
	tools: z.object({
		extract: z.boolean().default(true),
		crawl:   z.boolean().default(true),
		map:     z.boolean().default(true),
		research: z.boolean().default(false),      // credits-heavy
	}),
	limits: z.object({
		extractMaxUrls: z.number().step(1).min(1).default(10),
		crawlMaxPages:  z.number().step(1).min(1).default(10),
		mapMaxUrls:     z.number().step(1).min(1).default(100),
		perPageChars:   z.number().step(1).min(1).default(20000),
	}),
	deepseek: { /* unchanged */ },
	tavily: z.object({
		searchDepth, topic, maxResults, includeAnswer, timeRange,   // unchanged
		extractDepth: z.string().default("basic"),                  // basic | advanced
		researchModel: z.string().default("auto"),                  // mini | pro | auto
	}),
	demo: { /* unchanged */ },
});
```

Deliberately excluded from v1: crawl `maxDepth/maxBreadth/instructions/selectPaths`, Tavily `outputSchema`/`citationFormat`, streaming research. Additive later without breaking this contract.

## 11. Error codes

| Code | Where | Meaning |
| :--- | :--- | :--- |
| `WEB_OP_UNSUPPORTED` | router tier 3 | Op has neither native nor composite path on the active adapter |
| `WEB_OP_FAILED` | composites | Ran but produced nothing usable (e.g. no sitemap found) |
| `WEB_PROVIDER_CREDENTIAL_MISSING` | existing | Reused; key-required op without key |
| `WEB_PROVIDER_ERROR` | existing | Reused for native backend failures |
| `WEB_ABORTED` | existing | Reused |

## 12. Provider capability matrix (after implementation)

| Provider | search | extract | crawl | map | research |
| :--- | :--- | :--- | :--- | :--- | :--- |
| tavily | native | native | native | native | native |
| deepseek | native | composite | composite | composite | unsupported |
| demo | native | composite | composite | composite | unsupported |
| firecrawl (future) | - | native | native | native | unsupported |
| exa (future) | native | native | composite | composite | unsupported |

## 13. File change list

| File | Change | Content |
| :--- | :--- | :--- |
| src/types.ts | modified | operation vocabulary (s4), WebAdapter v2 (s5) |
| src/core/capabilities.ts | new | capabilitiesOf() derivation |
| src/core/router.ts | new | execute(op) ladder shared by provider + tools |
| src/core/composites.ts | new | universal extract/map/crawl algorithms over ctx.web.fetch |
| src/core/html.ts | new | HTML-to-text converter shared by extract/map/crawl composites |
| src/core/errors.ts | modified | opUnsupported(), opFailed() |
| src/adapters/tavily.ts | modified | native extract/crawl/map/research implementations |
| src/tools/{extract,crawl,map,research}.ts | new | per-tool schema, formatter, registration |
| src/tools/index.ts | new | wiring only (no tool logic) |
| src/config.ts | modified | s10 schema additions |
| src/index.ts | modified | apply(): tool registration, optional fetch provider, inject list |
| package.json | modified | version 0.2.0 |

Compatibility red lines: provider id `deepseek-official`, settings namespace `web-search-deepseek`, old `web_search` behavior, and the DeepSeek adapter path are untouched.

## 14. Verification plan

1. Unit - router ladder: native wins; composite used when method absent; `WEB_OP_UNSUPPORTED` for research on search-only adapters. Includes the per-adapter capability-set pinning tests (section 5).
2. Unit - composites against recorded fixtures: sitemap.xml + robots.txt parse, HTML->text conversion, BFS cycle safety, per-page failure isolation.
3. Unit - Tavily mappings for every response shape quoted in section 2 (including failedResults and incomplete research status).
4. Regression - existing search tests pass; DeepSeek/demo paths unchanged.
5. Integration - normal-install cold path only (the plugin is a `link:` profile dependency assembled via `dsh.profile.bundles`; no runtime injection): run `scripts/build.sh` to refresh `lib/`, then the three-layer preflight before any restart - L1 composition dry-run (`loadProfile` + `composeEntries`), L2 entry resolution via `require.resolve` anchored at the profile dir, L3 `lib/client.js` registration identity vs package.json name - then restart the harness and read the startup log once; live smoke: web_map + web_extract on example.com, web_research submit/status round-trip with a real key; keyless extract confirms the structured-error path.
6. Acceptance check - with provider=tavily: all five ops return native results; with provider=demo: extract/crawl/map still work via composites and research fails with WEB_OP_UNSUPPORTED.

## 15. Risks / open items

- Naive HTML->text quality (composites): acceptable floor, documented, never shadows a native path.
- Sitemap-less sites fail composite map by design (honest error).
- Two usable fetch providers require explicit `fetchProvider` selection when fetchBackend="adapter"; misconfiguration produces the seam's standard WEB_PROVIDER_AMBIGUOUS, which names both ids.
- Five extra tool schemas add per-request prompt overhead; gated by config.tools.* so minimal setups can disable what they don't use.
- Composite quality rides whichever fetch provider is registered globally; a third-party fetch replacement silently changes the compat floor. Inherent to the cordis shared-seam model, documented rather than fought.

Deliberate trade-offs (recorded, not fixed):

- **LSP tension is intentional**: adapters are not fully substitutable (a search-only backend cannot research). Non-substitutability fails fast as a structured `WEB_OP_UNSUPPORTED` instead of being papered over with not-supported stubs - honest modeling beats interface purity here.
- **COMPOSITES is a hardcoded map inside core**: adding a composite operation edits core, a local OCP friction. Accepted until a second consumer exists; a composite registry with one client would be ceremony without an audience.
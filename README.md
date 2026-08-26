# dsh-web-search-extend

English | [中文](README.zh.md)

An **in-place replacement** for the official DeepSeek Harness web-search plugin
(`@deepseek-ai/dsh-web-search-deepseek`). After install:

- the **official web-search plugin is disabled** and this plugin takes over its exact slots:
  - cordis plugin name → `web-search-deepseek`
  - Settings namespace → `web-search-deepseek` (**same config-page position & layout**, just extended)
  - registered `ctx.web` provider id → `deepseek-official` (seam selection unchanged)
- the agent **keeps using the old `web_search` tool** — nothing on the agent side changes;
  the tool still calls `ctx.web.search`, which now routes through this plugin into the configured
  **search provider** (Firecrawl keyless / Tavily / DeepSeek / Demo).
- the config page keeps the stock **Web search** card (api_key / baseURL / maxUses);
  the STOCK card's provider dropdown only offers DeepSeek and Tavily — switching to
  Firecrawl keyless or Demo, and configuring `fallbacks`, is done via the settings
  file or API (the card form is hardcoded upstream; a dedicated card is planned).

It is layered and modular (contract / config / core / adapter), and the adapter layer is
**pluggable — not locked to Tavily**: Firecrawl (keyless out of the box), DeepSeek (official
backend, preserved), Tavily (**keyless-capable**), and a Demo adapter ship out of the box.

## Install (official `dsh plugin add`, replace the official)

This package is a **standard DSH bundle plugin**: it declares `dsh.bundle` → `./cordis.patch.yml`,
so the official `dsh plugin` CLI installs it as a profile layer (no super-injector needed).
No manual profile-overlay edit is required: the package's OWN bundle layer inserts the
`dsh-web-search-extend` loader entry AND carries the trailing `- id: web-search-deepseek /
disabled: true` marker that turns off the official plugin — that bundled entry is the
authoritative takeover mechanism (a leftover manual disable from older setups is redundant
but harmless).

1. **Install normally:**

   ```bash
   dsh plugin --profile web add /path/to/dsh-web-search-extend
   ```

   This adds the package to profile dependencies and to `dsh.profile.bundles`; the package's own
   `cordis.patch.yml` then inserts the `web-search-extend` loader entry and disables the official
   `web-search-deepseek` entry at boot.

2. **Restart DSH** (or reload the profile). The plugin then loads as the `web-search-extend`
   entry, registers the official Settings namespace (`web-search-deepseek`) and provider slot
   (`deepseek-official`), and the agent's existing `web_search` tool routes through it.

The super-injector is only used for live development; production setup is the normal CLI install.

## Architecture (layered, single-responsibility)

```
src/
  index.ts            # cordis entry: wears official identity, wires layers, registers provider
  invariant.ts        # package-ownership companion (ctx.invariants)
  types.ts            # contract layer: SearchAdapter + AdapterRuntime interfaces
  config.ts           # config layer: superset schema of the official config + defaults
  core/               # seam-integration layer (harness wiring, no vendor code)
    provider.ts       # ExtensibleWebSearchProvider (id = deepseek-official)
    capabilities.ts   # capabilitiesOf(): capability derived from method presence
    router.ts         # execute(): native -> composite -> WEB_OP_UNSUPPORTED ladder
    composites.ts     # universal extract/map/crawl over an injected FetchLike
    html.ts           # naive HTML -> text/markdown converter (compat floor)
    registry.ts       # AdapterRegistry (the pluggability mechanism)
    abort.ts          # cancellation handling (cross-cutting)
    errors.ts         # WebError taxonomy (cross-cutting)
  adapters/           # adapter layer (one file per backend — pluggable)
  tools/              # model-facing tools (extract/crawl/map/research) + formatters
    deepseek.ts       # DeepSeekAdapter (official Anthropic-compatible API, preserved)
    tavily.ts         # TavilyAdapter (keyless) + response mapping
    firecrawl.ts      # FirecrawlKeylessAdapter (keyless search) + response mapping
    demo.ts           # DemoAdapter (example, no network)
    index.ts          # createDefaultRegistry() registers all bundled adapters
```

Adding a provider = add one `adapters/<vendor>.ts` implementing `SearchAdapter` and register it
in `createDefaultRegistry()`. The core never changes.

## The adapter contract (WebAdapter v2)

```ts
interface WebAdapter {
  readonly id: string;                        // also the registered ctx.web provider id
  readonly label: string;
  readonly requiresApiKey: boolean;
  readonly defaultApiKeyEnv: string;
  readonly baseURLEnv: string;
  readonly defaultBaseURL: string;
  available(runtime: AdapterRuntime): boolean;
  search(request, runtime, signal?): Promise<WebSearchResult>;
  // Optional native ops - capability is DERIVED from method presence:
  extract?(req: ExtractRequest, runtime, signal?): Promise<ExtractResult>;
  crawl?(req: CrawlRequest, runtime, signal?): Promise<CrawlResult>;
  map?(req: MapRequest, runtime, signal?): Promise<MapResult>;
  submitResearch?(input: string, runtime, signal?): Promise<ResearchSubmission>;
  pollResearch?(requestId: string, runtime, signal?): Promise<ResearchStatus>;
}
```

Every op runs through the router ladder: **native method -> composite (universal
extract/map/crawl over the fetch seam) -> structured WEB_OP_UNSUPPORTED**. Adding a
provider = one file implementing WebAdapter; the core never changes.

## Engines

| id | Credential ref | Keyless behavior | Native ops |
| :--- | :--- | :--- | :--- |
| `firecrawl-keyless` (**default**) | `FIRECRAWL_API_KEY` (optional; upgrades quota) | search out of the box (~1000 credits/month/IP; HTTP 402 when exhausted) | search |
| `tavily` | `TAVILY_API_KEY` | search only (rate-limited) | all five (search/extract/crawl/map/research) |
| `deepseek` | `DEEPSEEK_API_KEY` (required) | none - refuses without a key | search |
| `demo` | none | everything, offline and canned | search |

Ops an adapter does not serve natively fall through the router ladder to the
universal composite tier (plain fetch + readability), so extract/crawl/map stay
usable on every provider.

## Config (the extended web-search-deepseek section)

| Key | Default | Meaning |
| :--- | :--- | :--- |
| `provider` | `firecrawl-keyless` | Which adapter serves each search: firecrawl-keyless / tavily / deepseek / demo. |
| `apiKey` | omitted | Literal key (secret role). The stock settings card writes the value into the ref named by `apiKeyEnv`, NOT into the settings file. |
| `apiKeyEnv` | `FIRECRAWL_API_KEY` | Top-level credential ref: the settings card badge and save target. When it holds a managed ref (`TAVILY_API_KEY` / `DEEPSEEK_API_KEY` / `FIRECRAWL_API_KEY`), `apply()` re-syncs it to the active provider's default on provider change so the badge follows the provider. An arbitrary custom ref is respected untouched. |
| `baseURL` | per-provider | Endpoint host root; falls back to the adapter env (`DEEPSEEK_SEARCH_BASE_URL` / `TAVILY_BASE_URL` / `FIRECRAWL_BASE_URL`). |
| `fetchBackend` | `"local"` | `local`: existing fetch provider untouched. `"adapter"`: additionally registers a `web-search-extend` WebFetchProvider serving single-URL extract (requires NATIVE extract on the active adapter, e.g. tavily; select via `fetchProvider` / `DSH_WEB_FETCH_PROVIDER`). |
| `fallbacks` | `[]` | Ordered adapter ids tried after the primary when it fails switchably (backend / quota / rate-limit / missing credential). Unknown ids, duplicates, and self-reference reject the settings write with a visible error; the provider then runs `[primary, ...fallbacks]` as one ChainAdapter. |
| `tools.extract` | `true` | Register `web_extract`. |
| `tools.crawl` | `true` | Register `web_crawl`. |
| `tools.map` | `true` | Register `web_map`. |
| `tools.research` | `false` | Register `web_research` + `web_research_status` (credits-heavy, off by default). |
| `tools.doctor` | `true` | Register `web_doctor` (offline diagnostics; zero network/quota). |
| `limits.extractMaxUrls` | `10` | Max URLs per web_extract call. |
| `limits.crawlMaxPages` | `10` | Max pages per web_crawl call. |
| `limits.mapMaxUrls` | `100` | Max URLs per web_map call. |
| `limits.perPageChars` | `20000` | Per-page render cap for extracted/crawled content. |
| `deepseek.model` | `deepseek-v4-flash` | Official DeepSeek model id. |
| `deepseek.apiVersion` | `2023-06-01` | Messages API version. |
| `deepseek.maxTokens` | `4096` | Max completion tokens. |
| `deepseek.maxUses` | `5` | Max searches per request before answering. |
| `deepseek.apiKeyEnv` | `DEEPSEEK_API_KEY` | Credential ref for deepseek (per-provider override). |
| `tavily.searchDepth` | `basic` | basic / advanced / fast / ultra-fast. |
| `tavily.topic` | `general` | general / news / finance. |
| `tavily.maxResults` | `5` | Result cap. |
| `tavily.includeAnswer` | `false` | Also return a generated answer (mapped to content). |
| `tavily.timeRange` | `""` | day / week / month / year restriction. |
| `tavily.extractDepth` | `basic` | basic / advanced used by native extract + crawl. |
| `tavily.researchModel` | `auto` | mini / pro / auto for research tasks. |
| `tavily.apiKeyEnv` | `TAVILY_API_KEY` | Credential ref for tavily (per-provider override). |

```yaml
- id: web-search-deepseek
  name: 'dsh-web-search-extend'
  config:
    provider: firecrawl-keyless # or: tavily | deepseek | demo
    tools:
      research: true            # opt in to the credits-heavy research tools
    limits:
      extractMaxUrls: 10
    tavily:
      searchDepth: basic
      includeAnswer: true
```

Key refs are resolved per provider with NO cross-provider fallback (config.apiKeyEnv
then provider-subsection apiKeyEnv then adapter default; see AGENTS.md for the badge
mechanism and the managed-ref auto-sync).


## Model-facing tools

| Tool | Args | Behavior |
| :--- | :--- | :--- |
| `web_search` | `queries: string[]` | Official tool, unchanged - routes through the selected provider. |
| `web_extract` | `urls: string[]`, `query?`, `format?` | Readable content of known URLs (markdown/text). Native on tavily; universal composite fallback. |
| `web_crawl` | `url`, `maxPages?`, `includeDomains?`, `excludeDomains?` | Bounded crawl of a site. Native on tavily; BFS composite fallback. |
| `web_map` | `url`, `maxUrls?` | Enumerate site URLs. Native on tavily; sitemap/robots composite fallback. |
| `web_research` | `input` | Submit an async deep-research task (credits!); returns requestId. |
| `web_research_status` | `requestId` | Poll one research task to a terminal phase; then returns content + sources. |
| `web_doctor` | (none) | Offline readiness report: every registered engine with key-ref status (booleans only, never values), endpoint source (config/env/default), cooldown windows, availability verdict, and the resolved effective chain. Zero network, zero quota. |

Tools stay registered regardless of the active provider - switching provider only
changes which tier (native / composite / unsupported) serves each call. Research is
gated off by default (tools.research: false).

**Doctor usage**: when search behaves oddly (wrong engine served, sudden 402/429,
"unavailable" verdicts), call `web_doctor`. It prints, offline and quota-free,
per-engine readiness — key-ref resolution as booleans only, endpoint source
(config/env/default), cooldown windows, availability — plus the effective chain
and any fallbacks validation problems. Use it to confirm which engine actually
serves before touching credentials or settings.


## Keyless Tavily

`TavilyAdapter.requiresApiKey = false` - available() is true and search() runs with no
key. Keyless mode covers SEARCH ONLY: extract/crawl/map/research surface a credential
error (WEB_PROVIDER_ERROR: keyless rate limit / endpoint unavailable). Set
TAVILY_API_KEY in the credentials service (Models page) for full access. The ref is
resolved per provider with no cross-provider fallback (see AGENTS.md).


## Firecrawl keyless

`FirecrawlKeylessAdapter` is the default `provider`: search works with zero
configuration against the hosted Firecrawl v2 endpoint. Caveats:

- **Monthly credit quota** - the keyless tier is free but capped (~1000 credits per
  IP per month; search costs 2 credits per 10 results). When exhausted, Firecrawl
  answers HTTP 402 and the plugin surfaces `WEB_PROVIDER_ERROR` naming the quota and
  `FIRECRAWL_API_KEY`.
- **Key upgrades the quota** - store an `fc-...` key in `FIRECRAWL_API_KEY`
  (credentials service / Models page) to lift the cap; a present key is sent as a
  Bearer token, while any non-empty non-`fc-` value makes the adapter unavailable
  (treated as a mis-stored ref).
- **Search ONLY by design** - extract/crawl/map stay on the composite tier so the
  shared monthly credits are spent on search alone, and those tools keep working
  (quota-free) even after the credit pool runs out.


## Failover chain

With `fallbacks` set, the provider wraps `[primary, ...fallbacks]` into one
`ChainAdapter` (core/chain.ts), so the router and tools see a single adapter:

- **Switchable failures** - `WEB_PROVIDER_ERROR` (backend failure / 402 quota /
  429 rate limit / network) and `WEB_PROVIDER_CREDENTIAL_MISSING` - try the next
  member. Note the coarseness: vendors collapse bad-request and server errors
  into the same code today, so a hard 400 also burns one fallback attempt.
- **Non-switchable** - `WEB_ABORTED`, `WEB_OP_UNSUPPORTED`, `WEB_OP_FAILED`,
  non-WebError crashes - rethrow the ORIGINAL error immediately without trying
  the rest.
- Per op only members with the NATIVE method run; an op no member supports
  natively stays absent from the chain, so the composite tier keeps serving it
  exactly as before. Once any member is native for an op, that op never reaches
  the composite tier.
- `capabilitiesOf(chain)` = union over members; research requires BOTH methods
  on one member and delegates to the first complete member WITHOUT failover
  (request ids are vendor-namespaced).
- Every attempt appends a `{adapterId, outcome, durationMs}` record through an
  injected `onAttempt` sink, and the trail surfaces ADDITIVELY on degraded
  outcomes (Step 5): a result or error that involved a fallback/skip carries
  `attempts[]` plus human-readable `warnings[]` ("fell back X -> Y", "X cooling
  until T"). A direct first-member success carries neither — silence means no
  degradation happened.
- **Cooldown (memory-only, D2)** - any `WEB_PROVIDER_ERROR` (429 / quota / 5xx /
  network — the same switchable class the chain fails over on) puts the member on
  cooldown for `60s * 2^(prior consecutive failures)`, capped at ~30 min.
  `WEB_PROVIDER_CREDENTIAL_MISSING` never cools: a missing key does not heal with
  time. Cooling members are skipped (recorded as `skipped` attempts) but still
  tried last-resort when every capable member is cooling; any success clears that
  member's window and count. State lives in memory only — restarts clear it.
- **Key rotation** - the primary adapter's resolved key value may hold
  COMMA-SEPARATED keys (`k1,k2,k3`, literal or one credential ref's value). Auth /
  quota / rate-limit failures rotate to the next key before escaping to the chain;
  other failures rethrow immediately, and exhausting all keys rethrows the original
  last error with an additive `keyIndex` diagnostic. Rotation stays inside ONE
  provider's own ref — never borrowed across providers (AGENTS.md incident rule).
  Only the index is ever exposed, never key material.
- Known limitation: members share ONE runtime built from the PRIMARY's config
  subsection, so a fallback's own `tavily.*`-style knobs are not applied while
  it serves as a fallback (provider seam hands down a single settings object).


## Error taxonomy

- `WEB_PROVIDER_CREDENTIAL_MISSING` - key-required backend with no resolvable key.
- `WEB_PROVIDER_ERROR` - backend failure / keyless limit.
- `WEB_ABORTED` - caller cancelled.
- `WEB_OP_UNSUPPORTED` - op has neither native nor composite path on the active adapter
  (e.g. research on deepseek/demo).
- `WEB_OP_FAILED` - a composite ran but produced nothing usable (e.g. no sitemap found
  for web_map).


## Verified

- **102 vitest tests** (`tests/`): router ladder, capability pinning (tavily: all five
  ops; deepseek/demo/firecrawl: search-only), composite fixtures (sitemap parse, HTML conversion,
  BFS cycle safety, per-page failure isolation), Tavily mappings for every response
  shape, Firecrawl keyless search (mocked fetch: mapping, auth-header rules, 402/429
  quota/rate-limit errors), ChainAdapter failover (switchable vs non-switchable,
  native-capability skipping, D3 validation), fake-clock cooldown schedule
  (exponential backoff, reset-on-success, all-cooling last-resort), multi-key
  rotation (first key 401s -> second serves), loud-degradation trails (warnings +
  attempts on degraded results/errors, silence on direct success), and the offline
  doctor report (every member listed; nothing key-like in output) - all hermetic
  (fake fetch / mocked SDK, zero network).
- Three-layer cold-path preflight (composition dry-run / resolve / client identity) passes.
- Live (human): key storage per provider ref verified; badge follows provider; real
  Tavily search/extract through the active provider.


## Development

```bash
npx tsc -p tsconfig.json      # compile src/ -> lib/ (preserves the layer layout)
npm test                      # vitest (tests/), hermetic
bash scripts/build.sh         # bundle lib/index.js + lib/invariant.js (esbuild)
```

Note: `test/search.test.mjs` is a pre-existing legacy harness importing
`lib/core/provider.js`, which the current bundle build does not emit - use `tests/`
(vitest) instead.

Publishing note (recorded ahead of npm release): consumers installing via pnpm may
run under a `minimumReleaseAge` supply-chain policy that holds back freshly
published versions, so an unpinned range can silently resolve an older release or
refuse to install. Pin EXACT versions when depending on this package
(`pnpm add @mr.robot/dsh-web-search-extend@<x.y.z> --save-exact` or
`npm i @mr.robot/dsh-web-search-extend@<x.y.z>`). For profile-dir lockfile
reconciles, use `pnpm install --no-frozen-lockfile`; a pure maintenance reconcile
that changes no locked versions can be exempted once via
`--config.minimumReleaseAge=0`.

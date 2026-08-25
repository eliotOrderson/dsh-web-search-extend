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
  **search provider** (DeepSeek / Tavily / Demo).
- the config page supports **choosing the search provider** and configuring each provider's
  **api_key**, plus provider-specific parameters.

It is layered and modular (contract / config / core / adapter), and the adapter layer is
**pluggable — not locked to Tavily**: DeepSeek (official backend, preserved), Tavily
(**keyless-capable**), and a Demo adapter ship out of the box.

## Install (official `dsh plugin add`, replace the official)

This package is a **standard DSH bundle plugin**: it declares `dsh.bundle` → `./cordis.patch.yml`,
so the official `dsh plugin` CLI installs it as a profile layer (no super-injector needed).

1. **Disable the official provider** in the profile overlay (this repo's active profile already has it):

   ```yaml
   # ~/.dsh/profiles/web/cordis.patch.yml
   - id: web-search-deepseek
     disabled: true
   ```

2. **Install normally:**

   ```bash
   dsh plugin --profile web add /path/to/dsh-web-search-extend
   ```

   This adds the package to profile dependencies and to `dsh.profile.bundles`; the package's own
   `cordis.patch.yml` inserts the `web-search-extend` loader entry at boot.

3. **Restart DSH** (or reload the profile). The plugin then loads as the `web-search-extend`
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


## Config (the extended web-search-deepseek section)

| Key | Default | Meaning |
| :--- | :--- | :--- |
| `provider` | `tavily` | Which adapter serves each search: tavily / deepseek / demo. |
| `apiKey` | omitted | Literal key (secret role). The stock settings card writes the value into the ref named by `apiKeyEnv`, NOT into the settings file. |
| `apiKeyEnv` | `TAVILY_API_KEY` | Top-level credential ref: the settings card badge and save target. When it holds a managed ref (`TAVILY_API_KEY` / `DEEPSEEK_API_KEY`), `apply()` re-syncs it to the active provider's default on provider change so the badge follows the provider. An arbitrary custom ref is respected untouched. |
| `baseURL` | per-provider | Endpoint host root; falls back to the adapter env (`DEEPSEEK_SEARCH_BASE_URL` / `TAVILY_BASE_URL`). |
| `fetchBackend` | `"local"` | `local`: existing fetch provider untouched. `"adapter"`: additionally registers a `web-search-extend` WebFetchProvider serving single-URL extract (requires NATIVE extract on the active adapter, e.g. tavily; select via `fetchProvider` / `DSH_WEB_FETCH_PROVIDER`). |
| `tools.extract` | `true` | Register `web_extract`. |
| `tools.crawl` | `true` | Register `web_crawl`. |
| `tools.map` | `true` | Register `web_map`. |
| `tools.research` | `false` | Register `web_research` + `web_research_status` (credits-heavy, off by default). |
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
    provider: tavily            # or: deepseek | demo
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

Tools stay registered regardless of the active provider - switching provider only
changes which tier (native / composite / unsupported) serves each call. Research is
gated off by default (tools.research: false).


## Keyless Tavily

`TavilyAdapter.requiresApiKey = false` - available() is true and search() runs with no
key. Keyless mode covers SEARCH ONLY: extract/crawl/map/research surface a credential
error (WEB_PROVIDER_ERROR: keyless rate limit / endpoint unavailable). Set
TAVILY_API_KEY in the credentials service (Models page) for full access. The ref is
resolved per provider with no cross-provider fallback (see AGENTS.md).


## Error taxonomy

- `WEB_PROVIDER_CREDENTIAL_MISSING` - key-required backend with no resolvable key.
- `WEB_PROVIDER_ERROR` - backend failure / keyless limit.
- `WEB_ABORTED` - caller cancelled.
- `WEB_OP_UNSUPPORTED` - op has neither native nor composite path on the active adapter
  (e.g. research on deepseek/demo).
- `WEB_OP_FAILED` - a composite ran but produced nothing usable (e.g. no sitemap found
  for web_map).


## Verified

- **48 vitest tests** (`tests/`): router ladder, capability pinning (tavily: all five
  ops; deepseek/demo: search-only), composite fixtures (sitemap parse, HTML conversion,
  BFS cycle safety, per-page failure isolation), Tavily mappings for every response
  shape - all hermetic (fake fetch / mocked SDK, zero network).
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

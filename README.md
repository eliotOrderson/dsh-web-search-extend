# dsh-web-search-extend

English | [中文](README.zh.md)

In-place replacement for the official DeepSeek Harness web-search plugin. It disables `@deepseek-ai/dsh-web-search-deepseek`, takes over the same Settings namespace (`web-search-deepseek`) and provider slot (`deepseek-official`), and keeps the existing `web_search` tool routing through a pluggable search adapter.

## Engines

| id | Credential ref | Native ops |
| :--- | :--- | :--- |
| `firecrawl-keyless` (default) | `FIRECRAWL_API_KEY` (optional; upgrades keyless quota) | search / extract / crawl / map / research |
| `tavily` | `TAVILY_API_KEY` (keyless search only) | search / extract / crawl / map / research |
| `deepseek` | `DEEPSEEK_API_KEY` (required) | search |

Non-native extract/crawl/map fall back to a local composite tier (fetch + Readability). Research has no composite fallback.

## Install

```bash
dsh plugin --profile web add /path/to/dsh-web-search-extend
```

Restart DSH. The bundled `cordis.patch.yml` inserts this plugin and disables the official one. The shipped patch enables `tools.research` by default.

## Config

The plugin extends the official `web-search-deepseek` settings section. Main keys:

| Key | Default | Meaning |
| :--- | :--- | :--- |
| `provider` | `firecrawl-keyless` | Active adapter: `firecrawl-keyless` / `tavily` / `deepseek` |
| `apiKeyEnv` | `FIRECRAWL_API_KEY` | Top-level credential ref; auto-synced to the active provider default on provider change |
| `routeMode` | `provider-first` | `provider-first`: native call then local composite; `local-only`: skip provider |
| `fetchBackend` | `local` | `local` registers a fallback fetch provider; `adapter` also exposes native extract as the `web-search-extend` fetch provider |
| `fallbacks` | `[]` | Ordered adapter ids tried after the primary on switchable failures |
| `tools.research` | `false` (schema); `true` in shipped patch | Register `web_research` / `web_research_status` |
| `limits.*` | see code | extract/crawl/map caps and per-page render limit |
| `tavily.*` | see code | search/extract/research knobs, incl. `researchModel` |
| `deepseek.*` | see code | model / apiVersion / maxTokens / maxUses |

Example:

```yaml
config:
  provider: firecrawl-keyless
  tools:
    research: true
```

`fetchProvider` is a DSH global setting, not plugin config: select `web-search-extend` when using `fetchBackend: adapter`.

## Architecture

```
src/
  index.ts            # cordis entry: official identity, layer wiring, provider registration
  types.ts            # SearchAdapter + AdapterRuntime contract
  config.ts           # extended web-search-deepseek schema + defaults
  core/               # harness wiring, no vendor code
    provider.ts       # ExtensibleWebSearchProvider (id = deepseek-official)
    capabilities.ts   # capability derived from method presence
    router.ts         # native -> composite -> WEB_OP_UNSUPPORTED ladder
    composites.ts     # universal extract/map/crawl over injected FetchLike
    html.ts           # HTML -> text/markdown (Readability + turndown)
    registry.ts       # AdapterRegistry
    abort.ts          # cancellation
    errors.ts         # WebError taxonomy
    localFetch.ts     # local web_fetch fallback provider
    secureFetch.ts    # SSRF/DNS-rebinding-safe local fetch
  adapters/           # one file per backend (pluggable)
    deepseek.ts
    tavily.ts
    firecrawl.ts
  tools/              # model-facing tools + formatters
  ui/client.js        # settings-card injector, bundled into lib/client.js
```

Adding a provider = implement `SearchAdapter` in `adapters/<vendor>.ts` and register it in `createDefaultRegistry()`.

## Tools

| Tool | Behavior |
| :--- | :--- |
| `web_search` | Routes through the active provider (official tool, unchanged) |
| `web_extract` | Readable content from known URLs |
| `web_crawl` | Bounded crawl of a site |
| `web_map` | Site URL enumeration |
| `web_research` | Submit an async deep-research task |
| `web_research_status` | Poll research to completion |
| `web_doctor` | Offline engine readiness report (zero network/quota) |

Research notes:

- Tavily research uses `tavily.researchModel` (`mini` is the cheapest).
- Firecrawl research always submits a built-in structured schema (`summary` / `analysis` / `sources` / `recommendations`) for detailed reports; it is not configurable.

## Failover & errors

- `fallbacks` wraps adapters into a chain. Switchable failures (`WEB_PROVIDER_ERROR`, `WEB_PROVIDER_CREDENTIAL_MISSING`) try the next member; non-switchable errors (`WEB_ABORTED`, `WEB_OP_UNSUPPORTED`, `WEB_OP_FAILED`) rethrow immediately.
- Quota/rate-limit failures put a member on memory-only cooldown (exponential backoff, ~30 min cap); success clears it.
- The primary key may be comma-separated; auth/quota/rate-limit failures rotate keys before chain fallback.
- Research requires both `submitResearch` + `pollResearch` on one member; there is no cross-member research failover.

## Development

```bash
npm test                 # vitest (127 tests, hermetic)
bash scripts/build.sh    # bundle lib/index.js + lib/invariant.js + lib/client.js
```

`src/ui/client.js` is bundled into `lib/client.js`; never edit `lib/client.js` directly.

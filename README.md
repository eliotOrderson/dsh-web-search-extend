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
    registry.ts       # AdapterRegistry (the pluggability mechanism)
    abort.ts          # cancellation handling (cross-cutting)
    errors.ts         # WebError taxonomy (cross-cutting)
  adapters/           # adapter layer (one file per backend — pluggable)
    deepseek.ts       # DeepSeekAdapter (official Anthropic-compatible API, preserved)
    tavily.ts         # TavilyAdapter (keyless) + response mapping
    demo.ts           # DemoAdapter (example, no network)
    index.ts          # createDefaultRegistry() registers all bundled adapters
```

Adding a provider = add one `adapters/<vendor>.ts` implementing `SearchAdapter` and register it
in `createDefaultRegistry()`. The core never changes.

## The adapter contract

```ts
interface SearchAdapter {
  readonly id: string;
  readonly label: string;
  readonly requiresApiKey: boolean;
  readonly defaultApiKeyEnv: string;
  readonly baseURLEnv: string;
  readonly defaultBaseURL: string;
  available(runtime: AdapterRuntime): boolean;
  search(request: WebSearchRequest, runtime: AdapterRuntime, signal?: AbortSignal): Promise<WebSearchResult>;
}
```

## Adapters shipped

| adapter id | Backend | requiresApiKey | Notes |
|---|---|---|---|
| `deepseek` | DeepSeek Anthropic-compatible Messages API | **yes** | Preserves the official backend (model/apiVersion/maxTokens/maxUses). |
| `tavily` | Tavily Search (`@tavily/core`) | **no** (keyless) | `answer` → `content` (opt-in), `results[]` → `sources[]`. |
| `demo` | none (canned) | no | Zero-config example proving pluggability. |

## Config (the extended `web-search-deepseek` section)

| Key | Default | Meaning |
|---|---|---|
| `provider` | `tavily` | Which adapter serves each search. |
| `apiKey` | omitted | Literal key (secret role). |
| `apiKeyEnv` | per-provider | Credential ref: `DEEPSEEK_API_KEY` / `TAVILY_API_KEY` (fallback `DEEPSEEK_API_KEY`). |
| `baseURL` | per-provider | Endpoint host root; falls back to the adapter's env (`DEEPSEEK_SEARCH_BASE_URL` / `TAVILY_BASE_URL`). |
| `deepseek.*` | `model`=`deepseek-v4-flash`, `apiVersion`=`2023-06-01`, `maxTokens`=4096, `maxUses`=5 | Official deepseek knobs. |
| `tavily.*` | `searchDepth`=`basic`, `topic`=`general`, `maxResults`=5, `includeAnswer`=false, `timeRange`=`""` | Tavily knobs. |

```yaml
- id: web-search-deepseek
  name: 'dsh-web-search-extend'
  config:
    provider: tavily          # or: deepseek | demo
    tavily:
      searchDepth: basic
      includeAnswer: true
```

## Keyless Tavily

`TavilyAdapter.requiresApiKey = false` → `available()` is true and `search()` runs with no key.
If the keyless quota is exhausted the adapter surfaces a clear `WEB_PROVIDER_ERROR` ("Tavily
keyless rate limit reached; set TAVILY_API_KEY for full access"). Set `TAVILY_API_KEY` for
unlimited access.

## Error taxonomy

`WEB_PROVIDER_CREDENTIAL_MISSING` (key-required backend, no key) · `WEB_PROVIDER_ERROR`
(backend failure / keyless limit) · `WEB_ABORTED` (caller cancelled).

## Verified

- Unit/smoke: registered id is always `deepseek-official`; DeepSeek map+body, Tavily keyless
  mapping/dedupe/maxResults/errors/abort, Demo pluggability, credential-missing — all pass.
- Live: with the official provider disabled, the harness's **built-in `web_search` tool** (unchanged)
  returned real results through Tavily keyless — no API key, no agent-side change.

## Development

```bash
npx tsc -p tsconfig.json      # compile src/ -> lib/ (preserves the layer layout)
node smoke.mjs                # smoke: identity + adapters + apply registration
node test/search.test.mjs     # search tests (mocked backends)
```

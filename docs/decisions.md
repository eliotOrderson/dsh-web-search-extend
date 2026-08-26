# Decision Log

Append-only record of decisions that shape implementation. One entry per
decision: status, context, decision, consequences. Superseded entries stay.

## 2026-08-26 — Adopt ModSearch-inspired resilience plan

Status: APPROVED (user).

Context: Comparison against `@liustack/modsearch` (2026-08-26) showed parity gaps
that are operational, not architectural: no keyless out-of-box engine, no
runtime failover, no quota cooldown / key rotation, no offline diagnostics, no
degradation visibility. Our `SearchAdapter` contract can absorb all of these at
the registry/decorator level without core changes.

Decision: Execute TASK.md steps 1-6 (P0-P3). Full plan with per-step verify
gates lives in `TASK.md`; that file is the execution plan, this log records the
binding choices.

Consequences: Core (`src/core/*`) changes only where TASK.md says so
(chain.ts, cooldown.ts, rotating-key.ts are additive modules); provider keeps
seeing a single adapter.

## 2026-08-26 — D1: default search provider switches to firecrawl-keyless

Status: APPROVED (user).

Context: Out-of-box UX gap - default provider `tavily` is unusable without an
API key, while Firecrawl's keyless tier searches with zero setup (~1000 free
credits/month).

Decision: `config.ts` default `provider` becomes `"firecrawl-keyless"`. Existing
profiles with a saved provider value are unaffected.

Consequences:
- `PROVIDER_DEFAULT_API_KEY_ENVS` gains `firecrawl-keyless → FIRECRAWL_API_KEY`
  (ref allowed to stay unset) so apply()'s onChange keeps the stock settings-card
  badge truthful on provider switch — per AGENTS.md incident rule.
- Keyless tier covers search only; extract/crawl/map keep flowing through the
  composite tier for this adapter.
- Verified against schemastery/dsh-settings layering (t2 audit): schema-default
  changes never override saved profile values (user layer always wins). Residual
  edge, accepted as non-blocking: a profile with saved `provider` but an
  apiKeyEnv NEVER persisted resolves FIRECRAWL_API_KEY transiently, degrading
  tavily keyed→keyless until the next settings interaction re-syncs via onChange.
  Reachable only through hand-edited state files (AGENTS.md-flagged practice);
  search stays functional throughout.

## 2026-08-26 — D2: quota cooldown is memory-only

Status: APPROVED (user).

Context: Cooldown state must survive or not across restarts. Disk persistence
(temp file + atomic rename, modsearch-style) adds a state file and a failure
surface.

Decision: Cooldown state lives in memory only; restarts clear it. Injected clock
for testability. No file I/O in cooldown code.

Consequences: A quota-exhausted engine may be retried once after a process
restart. Acceptable; disk layer can be added later behind the same interface if
restart churn ever makes re-probing expensive.

## 2026-08-26 — D3: failover chain configured as top-level fallbacks array

Status: APPROVED (user).

Context: Chain shape alternatives: top-level `config.fallbacks: string[]` vs
per-provider subsections each carrying their own chain.

Decision: Top-level `fallbacks?: string[]` of adapter ids, ordered, validated
against the registry at apply time (unknown ids / duplicates / self-reference
rejected with a settings-visible error).

Consequences: Simpler schema and settings rendering; switching the primary does
not require rewriting chains per provider. Per-provider chains remain possible
later as a backward-compatible extension (subsection overriding the flat list).

## 2026-08-26 — Custom settings card approved as next work item

Status: APPROVED direction (user), design pending.

Context: Live verification in the Docker cold-boot replica showed the stock
Web search card hardcodes its provider dropdown (DeepSeek/Tavily only) and its
form fields (api_key/baseURL/maxUses). firecrawl-keyless, demo selection and
`fallbacks` editing are therefore settings-file/API operations only.

Decision: Ship the plugin's own web card for our namespace (package already has a
`dsh.client` web half). Scope: full provider dropdown, fallbacks editor with the
same validation as `hooks.validate`, cooldown glance, doctor shortcut.

Consequences: Design discussion precedes code; stock card keeps working until then.
READMEs now state the limitation honestly instead of promising UI switching.

## 2026-08-26 — P4 x_search shelved

Status: DEFERRED (user).

Context: X/Twitter corpus requires the external `grok` CLI signed in, plus
Electron subprocess handling (`ELECTRON_RUN_AS_NODE=1`) if we ever spawn CLIs.

Decision: Not in scope for the current plan. No task, no stub, no config key.

Consequences: Revisit only after P0-P3 land; would enter as a new adapter +
tool registration design discussion, not a TASK.md step.

## 2026-08-26 — Non-goals carried from the comparison (standing)

Status: APPROVED (user).

- No external config file (~/.modsearch-style): dsh-native settings + credentials
  integration stays the single configuration surface.
- No multi-host skill distribution: dsh-only plugin.
- Do NOT adopt modsearch's minimal-contact-surface philosophy wholesale — it
  conflicts with our drop-in takeover goal; we adopt its loud-degradation
  visibility instead (TASK.md Step 5).

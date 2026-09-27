# Independent adversarial verification — features #1 and #2

Date: 2026-09-27
Verifier: `feature-verifier` (shared task `task-4`), independent of the three authors.
Artifacts: `tests/verified-features.test.ts` (new), this report. No `src/`, existing test,
`package.json`, `README`, `lib/` or live state file was modified. `scripts/build.sh` was **not** run.

Method: every claim in `task-4` was treated as a hypothesis and attacked through the real modules
(`src/core/cooldown.ts`, `src/core/state.ts`, `src/core/cache.ts`, `src/core/provider.ts`,
`src/core/chain.ts`, `src/adapters/deepseek.ts`, `src/adapters/tavily.ts`, `src/index.ts`,
`src/config.ts`, `src/tools/doctor.ts`) with fake clocks, injected adapters, real temp directories,
a stubbed global `fetch` for the DeepSeek transport and a mocked `@tavily/core` transport. No network.

## Verdict summary

| Claim | Verdict |
| --- | --- |
| 1. Retry-After parsing, clamping, real read site, Tavily mapping, chain pass-through | **VERIFIED** (all sub-items) |
| 2. Cooldown persistence across restart, degraded state, streak survival | **VERIFIED** (deviation judged coherent) |
| 3. Cache identity / TTL / LRU / key coverage | **REFUTED in part (F1)**: nested settings are invisible to the signature; everything else VERIFIED |
| 4. Hit visibility, attempts hygiene, mutation isolation | **REFUTED in part (F2)**: a hit re-plays `attempts[]` when the cached fetch was a failover success; the direct-success case is VERIFIED |
| 5. No secrets in the state document or the doctor output | **VERIFIED** (literal grep, no match) |
| Edge (a) Retry-After 0 / negative / `"abc"` / past date / far future / over cap | all observed, all sane |
| Edge (b) truncated JSON / wrong shape / non-numeric `failures` | all observed, all cold-start |
| Edge (c) `until` beyond cap / adapter no longer exists | all observed, both inert |
| Edge (d) deep nested set→get / two providers, identical request | all observed, no cross-serve |
| Edge (e) identical `providerId`, different settings | all observed, no cross-serve |

## Verify commands

```
$ node_modules/.bin/tsc -p tsconfig.json --noEmit
tsc exit=0                      # clean, no output
```

```
$ cd tests && ./node_modules/.bin/vitest run
...
 Test Files  1 failed | 16 passed (17)
      Tests  1 failed | 247 passed (248)
   Start at  21:14:19
   Duration  576ms (transform 727ms, setup 2.73s, tests 424ms, environment 0ms, prepare 971ms)
```

The single failure is the deliberately RED test that encodes finding **F2**. With my file excluded the
pre-existing suite is green:

```
$ cd tests && ./node_modules/.bin/vitest run --exclude '**/verified-features.test.ts'
 Test Files  16 passed (16)
      Tests  198 passed (198)
   Duration  522ms
```

## Claim 1 — VERIFIED

Evidence (`tests/verified-features.test.ts`, block "claim 1"):

* `parseRetryAfter("120", now) === 120000`, `"0" → 0`, `"  90  " → 90000`; an HTTP-date
  `new Date(now + 75000).toUTCString()` → `75000`.
* Edge (a): elapsed HTTP-date → `0`; `"-5"` → `0`; `"abc"` / `""` / `"   "` / `null` → `undefined`
  (falls back to the estimate). `"999999999999"` → `999999999999000`, kept finite and left to the cap.
* `markRetryAfter` / `retryAfterMsOf`: unmarked error → `undefined`; marked → the value; `NaN` →
  `undefined`; `-9` → `0`; a non-object → `undefined`.
* Board clamping: server `0` → `now + 1000` (`RETRY_AFTER_FLOOR_MS`); `250` → `now + 1000`;
  `120000` → `now + 120000`; `cap + 1` → `now + cap`; `Infinity` → falls back to `base`.
* No-header schedule unchanged: `base`, `2·base`, `4·base`, then saturated at `cap` after enough
  failures. `git diff src/core/cooldown.ts` shows the new branch is added **beside** the untouched
  line `const delay = Math.min(this.baseMs * 2 ** priorFailures, this.capMs);` — byte-identical.
* A server window does not rewrite the streak: after `onQuotaError(x)` then `onQuotaError(x, 5000)`,
  the third call uses `priorFailures = 2` → `4·base`.
* Real read site: `DeepSeekAdapter.search` with a stubbed global `fetch` returning 429 +
  `retry-after: 120` rejects with `WebError`/`WEB_PROVIDER_ERROR` carrying `retryAfterMs === 120000`;
  a 503 with an HTTP-date header maps to `29999 < ms <= 30000`; a 500 without the header leaves the
  signal `undefined`. `git diff src/adapters/deepseek.ts` confirms this is
  `parseRetryAfter(response.headers.get("retry-after"))` on the `!response.ok` path.
* One-line pass-through: `chainOf([DeepSeekAdapter, backup], { cooldowns: board })` with the same
  stubbed 429 gives `board.coolingUntil("deepseek") === clock + 120000` — the server window, not the
  60 s estimate. Without the header the same wiring gives `clock + 60000`.
* Tavily: mocked `@tavily/core` client throwing a real `TavilyKeylessLimitError({ retryAfter: 45 })`
  makes `TavilyAdapter.search` reject with a `WebError`/`WEB_PROVIDER_ERROR` whose `retryAfterMs` is
  `45000`; `retryAfter: null` leaves it `undefined`; end-to-end the board records `clock + 90000` for
  `retryAfter: 90`. A plain SDK error carrying `retryAfter` is **not** mapped (it passes through
  unchanged) — that is outside the documented rule, which names `TavilyKeylessLimitError` only.

## Claim 2 — VERIFIED

Evidence (blocks "claim 2: persist then load" / "damaged state"):

* Round trip: `saveBoard(dir, board)` then `loadBoard(dir, { clock: () => t + 30000 })` keeps
  `isCooling("tavily") === true` with the original `until`.
* Expired window + surviving streak: after `now > until`, the restored board is not cooling, yet its
  next failure yields `2·base` instead of `1·base` — the streak survived.
* Edge (c): an `until` exactly `now + cap` is restored; `now + cap + 1` is dropped (streak kept).
* Edge (c): an adapter id that no longer exists stays inert in the board and does not disturb a chain
  built from the ids that do exist (verified with `chainOf([live, backup], { cooldowns: restarted })`).
* Restart integration: a board saved with `primary` cooling makes a freshly restored chain skip
  `primary` (`primaryCalls === 0`), serve from `backup`, record a `skipped` attempt and the warning
  `primary cooling until <ISO>`.
* Edge (b): a document truncated mid-JSON → `readState` `undefined`, `loadBoard` cold. Non-object roots
  (`"str"`, `123`, `null`, `true`, `[1,2,3]`) → `readState` `undefined`. Object roots without a numeric
  `version`, with `cooldown: "nope"`, `adapters: []`, an entry that is a string, `failures: "3"`, or
  `failures: -2` → all cold; a valid sibling entry still restores while the broken ones are dropped and
  keep no streak.
* Unwritable directory (fresh module graph via `vi.resetModules()` + dynamic import so the process-wide
  `writesDisabled` latch cannot contaminate other tests): `saveBoard` does not throw, no file appears,
  and a full `ExtensibleWebSearchProvider.search` with `onCacheWrite → saveBoard(blocked)` still returns
  the fresh result.
* Extra: `saveBoard` preserves the cache slice it does not own (read-modify-write verified), and
  `ResultCache.fromState` can still read it afterwards.
* Extra: **6 concurrent processes × 25 writes to one directory** (`node --experimental-strip-types`,
  inline script, same dir) — every process ended `consistent` (one adapter key, padding matching that
  key), no `*.tmp` litter, and the final document parses. The `pid + counter` temp name holds up.

Judgment on the deliberate deviation (expired window dropped, streak kept): **coherent**. It never
resurrects a window, the streak can only round the *next* window up to the cap (30 min), so a long
uptime gap cannot pin an adapter out of rotation indefinitely, and it keeps the exponential estimate
meaningful across restarts. `toState` does publish expired windows too, which is harmless and makes
`toState`/`fromState` symmetric. One consequence worth knowing: the latch is permanent for the process
— a *single* transient write failure (ENOSPC, a permission blip) disables persistence until restart.
That is the documented design, not a defect, but it is the failure mode to expect if state ever
"stops saving".

## Claim 3 — REFUTED in part (F1)

VERIFIED:

* Identical request + config: second `provider.search` is a hit, adapter called once.
* Changed top-level setting (`settings.maxResults` 5 → 9): miss, adapter called twice.
* Changed request (`query`, and `maxResults: 3` vs `5`): miss.
* TTL boundary: `ageMs === ttlMs` is a miss and the entry is dropped; `ttlMs - 1` is a hit.
* LRU: with `maxEntries: 2`, `set a; set b; get a; set c` evicts `b` (the least recently used), keeps
  `a` and `c`, `stats().evicted === 1`.
* Key coverage: `op`, `providerId`, `signature` and `request` all move the key; object key order does
  not (`{b:2,a:1}` === `{a:1,b:2}`); array order does (`["a","b"]` ≠ `["b","a"]`); the
  concatenation-forgery pair (`op:"ab",providerId:"c"` vs `op:"a",providerId:"bc"`) does not collide;
  a cyclic request still yields a stable 64-hex key instead of throwing.
* Edge (d): a deeply nested result survives `set → get` and `set → toState → fromState` unchanged;
  `undefined` fields and `null` are preserved. Two providers with byte-identical requests and a shared
  cache each get their own answer (adapter calls 1 + 1).
* Edge (e): two providers with the same adapter id (`tavily`) but `searchDepth` `basic` vs `advanced`
  each get their own answer.

**F1 — a nested setting is invisible to the cache signature.**

```
$ cd tests && ./node_modules/.bin/vitest run verified-features -t "FINDING F1"
   ✓ claim 3: cache identity > [FINDING F1] nested settings are invisible to the signature
```

`cacheSignature` (`src/core/provider.ts:48-50`) is
`JSON.stringify([adapterId, provider, baseURL, settings], Object.keys(settings).sort())`. An **array
replacer is a whitelist applied at every depth**, so a nested object only keeps keys that also exist at
the *top level* of `settings`. With `settings = { maxResults: 5, limits: { perPageChars: 20000 } }` the
serialized signature contains `"limits":{}` — and the test observes the consequence through the real
provider: two searches whose `limits.perPageChars` differ by 20 000× are served from **one** cache
entry (adapter called once).

Impact: **latent today**. `src/index.ts:80` builds `settings = { ...providerSettings, limits: config.limits, routeMode }`;
`providerSettings` is a flat per-provider subsection, and `limits` is read only by the composite tier
(`src/core/router.ts:73-80`, extract/crawl/map/research), which the cache does not cover. So no
*search-visible* wrong answer exists right now — but the literal claim "different config (settings
snapshot) misses" is false for any nested field, and the next nested search-relevant field added to
`settings` silently inherits the bug. Fix direction (Lead's call): canonicalise the settings object
yourself (e.g. `JSON.stringify(settings, Object.keys(settings).sort())` is the trap — use a sorted-key
deep encode, or hash `canonicalize`-style text from `core/cache.ts`) instead of relying on the replacer
array.

## Claim 4 — REFUTED in part (F2)

VERIFIED (direct-success origin):

* A hit carries `warnings === ["cache hit (age 5s)"]` (exact marker, age from the store clock), and
  `"attempts" in hit === false` — not `[]`.
* A first-fetch direct success carries neither key (`hasOwn(first,"warnings") === false`,
  `hasOwn(first,"attempts") === false`).
* Two consecutive hits do not stack markers on the stored entry (`age 0s`, then `age 3s`, one marker each).
* `onCacheWrite` fires once per stored result and never on a hit.
* Mutation isolation: after `sources.push({url:"https://evil.test/2"})`, `sources[0].url = "mutated"`,
  `content = "mutated"`, `truncated = true` on the handed-out result, the next hit still returns one
  source with the original url, the original `content`, and `truncated: false`; the two results are
  distinct objects.

**F2 — a hit re-plays `attempts[]` when the cached fetch was a failover success.**

```
$ cd tests && ./node_modules/.bin/vitest run verified-features -t "FINDING F2"
 FAIL  tests/verified-features.test.ts > ... > [FINDING F2] a hit carries no attempts[], even after a failover success
AssertionError: expected { ownKeys: [ 'attempts', …(3) ], …(1) } to deeply equal { ownKeys: [ 'sources', …(2) ], …(1) }

-   "attempts": undefined,
+   "attempts": [
+     { "adapterId": "primary", "durationMs": 0, "errorCode": "WEB_PROVIDER_ERROR", "outcome": "failed" },
+     { "adapterId": "backup", "durationMs": 0, "outcome": "ok" },
+   ],
    "ownKeys": [
+     "attempts",
      "sources",
      "truncated",
      "warnings",
    ],
```

Reproduction: `chainOf([failingPrimary, backup])` (primary throws `WebError`/`WEB_PROVIDER_ERROR`),
`ExtensibleWebSearchProvider` with a `ResultCache`, two identical `search({query:"q"})` calls. The
first is a failover success, so `dispatchOver` stamps `attempts` (and `warnings`) onto the result
(`src/core/chain.ts:136`). `search` then stores `copyResult(result)` (`src/core/provider.ts:120`) —
`copyResult` spreads, so the trail lands in the cache. On the second call the hit path does
`Object.assign(copyResult(cached), { warnings })` (`src/core/provider.ts:104`) and never removes
`attempts`, so the caller receives an attempt trail for members that did **not** run for that call.

This contradicts the documented rule twice over — the provider comment ("never an attempts entry: no
member ran, and a fabricated one would surface in doctor output as a real engine") and AGENTS.md
("must carry **no** `attempts[]` — not `[]`"). It is in the shipped bundle too:
`lib/index.js` contains `this.cache.set(n,Mr(o))` with `function Mr(t){return{...t,sources:t.sources.map(e=>({...e}))}}`.

Impact: no current consumer renders `attempts` (`grep -rn "attempts" src/` matches only `core/chain.ts`
and `core/provider.ts`), so there is no wrong user-visible output yet; the invariant is broken and any
Step-5 degradation view would report engines that did not run. Fix direction: build the hit from the
payload only (or delete `attempts` on the hit path) — the cache entry itself may keep the original trail.

## Claim 5 — VERIFIED

The state document and the doctor output were produced through the real code (provider with a literal
`apiKey`, a raw query, the cache and the board persisted through `writeState`; `buildDoctorReport` +
`renderDoctorReport`), then grepped literally:

```
$ grep -n -e 'SUPERSECRET' -e 'RAW-QUERY-TEXT' -e 'do-not-persist' -e 'authorization' -e 'Bearer' \
       -e 'x-api-key' -e 'searchDepth' /tmp/vfeat-evidence/state.json /tmp/vfeat-evidence/doctor.txt
grep exit=1 (1 = no match, 2 = file missing)
```

`state.json` (278 B) stores the sha256 lookup key plus the payload only:

```
{"version":1,"cooldown":{"adapters":{}},"cache":{"version":1,"entries":[{"key":"a6711270babbc37d66e93970ea230958765238c2518f4c97ecad3d857f7b92fa","value":{"content":"answer body","sources":[{"url":"https://a.test/1","snippet":"snippet text"}],"truncated":false...
```

`doctor.txt` (425 B) contains only booleans and names:

```
provider: tavily
effective chain: tavily
cache: enabled (ttl 900s, max 200, entries 1, hits 1, misses 1, evicted 0)
state dir: /tmp/vfeat-evidence
adapters:
- tavily (stub tavily)
  role: primary
  requiresApiKey: false
  credential FIRECRAWL_API_KEY resolves: true
  baseURL: default (https://tavily.test)
  available: true
  cooldown: 1970-01-01T00:01:00.000Z
```

The test additionally asserts `runtime.apiKey === SECRET` (so the secret really did flow through the
search) and that neither artifact contains the secret, the query, or credential-shaped header text.
Note the doctor reports the reference **name** (`FIRECRAWL_API_KEY`, the schema default for
`apiKeyEnv`) plus a boolean — consistent with the `resolveOptions` ladder.

## Live state file — untouched (before/after)

`$DSH_HOME/state/dsh-web-search-extend/state.json` **did not exist before this run and does not exist
after it**; the parent directory `~/.dsh/state/` does not exist either, so nothing could have been
written there.

```
before: 2026-09-27T21:08:56+08:00
$ ls -la /home/hydenix/.dsh/state/dsh-web-search-extend/state.json
ls: cannot access '...': No such file or directory
$ sha256sum /home/hydenix/.dsh/state/dsh-web-search-extend/state.json
sha256sum: ...: No such file or directory

after:  2026-09-27T21:13:39+08:00
$ ls -la /home/hydenix/.dsh/state/dsh-web-search-extend/state.json
ls: cannot access '...': No such file or directory
$ ls -la /home/hydenix/.dsh/state/
ls: cannot access '/home/hydenix/.dsh/state/': No such file or directory
$ find /home/hydenix/.dsh -maxdepth 4 -name "vfeat*"
(no output)
```

Every persistence test passes its own `fs.mkdtempSync` directory into
`writeState`/`readState`/`saveBoard`/`loadBoard`; `resolveStateDir` is never called in the test file.
(The sandbox gives each shell invocation a private `/tmp`, which is also why the grep above runs in the
same invocation as the test that writes the artifact.)

## Build claim — inspected, not run

`lib/index.js` (mtime `21:06:44`) is newer than every `src/` file it bundles (latest `21:06:18`), and
the bundle carries the new behaviour: `cache hit (age ${...}s)`, `state.json`, `"retryAfterMs"`,
`ttlSeconds`, `maxEntries`, and the temp name `` `${target}.${process.pid}.${counter}.tmp` ``. Store and
hit sites in the minified output match `src/core/provider.ts` exactly
(`this.cache.set(n,Mr(o))`, `Object.assign(Mr(u),{warnings:p})`). The stale-`lib/` risk is therefore
not present, and F2 is present in the shipped bundle.

## Findings outside the claim list

* **F3 (static, not reproduced)** — `src/index.ts:175-198` snapshots the cache settings at `apply`
  time: `ttlMs`/`maxEntries` are read once into `ResultCache.fromState`, and `cacheEnabled` is captured
  into a `const` used both for the provider's cache and for `cacheInfo()` (whose local is even named
  `live`). Because the config reference is volatile and updated in place across a settings write, a
  runtime change of `cache.enabled` / `ttlSeconds` / `maxEntries` does **not** re-arm the tier (hits
  keep being served after disabling; a new TTL waits for a restart) and the doctor reports the boot
  snapshot. `persist()` does re-read `current().cache?.enabled`, so a runtime disable stops *writes*
  while hits continue. Not reproduced because it needs a booted harness; the reading of the three lines
  is unambiguous.
* **O1 (verified)** — `ResultCache.set` stores its argument by reference
  (`expect(cache.get("deep")).toBe(nested)` passes). Isolation lives entirely in
  `provider.copyResult`; a future direct user of the store would alias an entry.
* **O2 (verified, modelled with real code)** — `saveBoard` is read-modify-write, but production never
  calls it: `src/index.ts:180-186` publishes `{ cooldown, cache }` from in-memory state on every write.
  Two writers that booted from the same document therefore clobber each other wholesale: in the test,
  writer B's stored entry disappears when writer A publishes. The file stays valid JSON (atomic rename),
  and the loss is a missed cache hit, not corruption. `grep -rn "saveBoard" src/` matches only its own
  definition — the read-modify-write path is test-only today.

## What is NOT verified

* F3 above: needs a booted `dsh` to flip a live settings value; verified from source only.
* O2's cross-process consequence: modelled in one process with the real writers, not with two live
  `dsh` processes.
* Anything requiring the harness (`apply(ctx, …)`, real settings projection, real `dsh` boot) — out of
  scope for this task and not attempted.

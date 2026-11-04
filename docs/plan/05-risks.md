# 05 — Risk register

L = likelihood, I = impact (H/M/L). Detection runs through `diagnostics` and health unless noted.

| # | Risk | L | I | Mitigation | Early detection |
|---|---|---|---|---|---|
| R1 | **Hermes canary churn**: methods, params or events change; `model.options` isn't in `x-canonical-methods` (11 §1); unknown keys are refused | M | H | Wire protocol only in TS; capability detection; strict fake from a vendored contract | Worker drift check on each version change; manual check before `hermes update` (D20) |
| R2 | **Private Hermes symbols** in `bb_tools` (`admission_author`, `get_session_env`) | M | M | One shim with `inspect.signature`; echo falls back to `echo.json`; tools fail closed | Drift check imports each symbol |
| R3 | **Private store schema**: the store reader is now primary for reads (`message_uid`, metadata) | M | H | `mode=ro`; `schema_version` check; named columns; a field that fails → no sync for that field, never a guess | Drift check runs the queries |
| R4 | **Experimental bb SDK APIs** (`experimental_*`); host 0.6.104 vs main 0.6.120 | M | H | Pin SDK 0.6.104; e2e at the live version; bb upgrade runbook (04) | `bb plugin types --check` per release and per bb upgrade |
| R5 | **Host-worker lifetime**: killed at 300 s with no exit event (S7 §6) | H | H | 60 s `ensureWatch`; `worker_boot_id` → full reconcile; WAL stat | Boot id changes; last-sync age |
| R6 | **Process count**: one bridge per hosted thread | M | M | Release after import; 30 min idle release; no keep-alive turns | Hosted count |
| R7 | **Concurrency limits**: $HERMES_HOST host limit 18 (07 §4) | L | M | Serial import; short mirror turns | Wake → `turn/start` delay > 30 s |
| R8 | **Duplicate or lost messages**: re-lists, compaction clones, `/retry`, merged sends (R1 M1, M2, M6) | M | H | `turns` keyed by `message_uid`, inserted with the wake in one transaction; input segmentation | Unit tests; dogfood `/retry` check |
| R9 | **Wrong-turn control**: steer or Stop hits another client's turn (R1 M4) | M | H | Fence on our own `admission_id`; `prompt.cancel` for queued prompts | Fencing tests |
| R10 | **Irreversible Hermes writes from reads**: `session.resume` adopts legacy rows (R1 M7); detach can end rows (R1 S7) | M | H | Store reads; adopt on first send only (D16); `end_reason:null` (A24) | 0 revision changes after import |
| R11 | **Duplicate bindings**: bb accepts a duplicate handle, then 409s (S1-S3 fact 4) | M | H | `UNIQUE` key; one serial queue; `pluginMetadata` origin check on `thread.created` | Duplicate-binding query |
| R12 | **Hung mirror turns** with no canonical events (Conduit legacy writer; R1 M5) | M | M | Store polling; 10 min cap → `partial`, the rest later | Turn age |
| R13 | **Release path**: the private repo isn't readable by the server's git; exact tags pin; no downgrade (R3 M1, M2) | H | H | P0 `git ls-remote` + `gh auth setup-git` (D29); `@^0` range; roll forward; `VACUUM INTO` before removal | P0 gate |
| R14 | **Tests hit live Hermes** if the root falls back (R3 M3) | M | H | `hermesRoot` required, no fallback; e2e aborts unless the instance id is the fake's | e2e step 7 |
| R15 | **Import timestamps**: items stamped "now" (S1-S3 §S1b) | H | L | Dated tags `[CLI · Oct 12]`; oldest-first import (Q7) | Dogfood P2 |
| R16 | **Notification noise**: double pushes with Conduit and Discord | M | M | D26 (`input-only` for user-started outside turns); silent imports | Push counts in dogfood |
| R17 | **Conduit co-writing Bot Chats**: legacy writer lease; turns serialised (08 §4) | M | M | Never adopt or move Bot Chats; store-rendered turns | Refusals in logs; P3 dogfood |
| R18 | **Discord echo**: re-ingest or `reply_to` rejection (11 §4) | M | L | Author check; ship without the echo if A11 fails | Supervised try |
| R19 | **Discord rollover**: replies after the daily reset don't reach Discord (08 §4) | H | M | Notice (D23); thread per session (Q4) | P5 dogfood |
| R20 | **bb tools security**: Discord users can drive bb; the Discord approval is self-approvable (R1 M10) | M | H | Off on cron; approval in Discord-origin sessions (D24); allowlist; no `tell` to its own thread; 0600 env file | pytest; log review |
| R21 | **Privacy**: transcripts enter bb's thread store | L | H | Ids only in db, logs and `diagnostics`; no network credentials | Log review per release |
| R22 | **bb auto-answers approvals** under a permission mode (A2) | L | H | One declared mode; never-auto-approve tests | P1 gate |
| R23 | **$HERMES_HOST outage** (sleep is off: keep-awake mode "all", D21) | L | M | Thread banner; reconnect diff; reconcile | `watch` state; Wi-Fi-off dogfood |
| R24 | **UI limits**: project catalog clash (Q9); `threads.open` moves every client; bb's own handoff drops the profile; init artifacts; mobile slots (A30) | M | L | Model mapping + warning; `useBbNavigate`; documented limitations; mute + `markRead`; pinned bots on the phone | Dogfood P1 |
| R26 | **Parity gaps**: slash commands and fork are unverified on canonical (A31–A34); either can block ACP retirement (D25) | M | M | Protocol check in P0 (T0.12); tip-only fork fallback; legacy-only catalog → raise with the user before P1 | T0.12 result |
| R25 | **`bb_tools` config change** in 4 profiles; `reload-plugins` reloads Conduit too | L | M | User approval at T4.3; while Conduit is idle; `plugins disable` rollback | Conduit link status |

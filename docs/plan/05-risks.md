# 05 — Risk register

L = likelihood, I = impact (H/M/L). Detection runs through `diagnostics` and health unless noted.

| # | Risk | L | I | Mitigation | Early detection |
|---|---|---|---|---|---|
| R1 | **Hermes canary churn**: methods, params or events change; `model.options` isn't in `x-canonical-methods` (r11 §1); unknown keys are refused | M | H | Wire protocol only in TS; capability detection; strict fake from a vendored contract | Worker drift check on each version change; `contract:check --incoming` before `hermes update` (D20) |
| R3 | **Private store schema**: the store reader is now primary for reads (`message_uid`, metadata) | M | H | T0.4 picks the reader that fails loudly (TS `node:sqlite` or Hermes' Python reader); mismatch policy: drift queries pass → warn, fail → pause import and mirror (02 store rules); scaffolding rows excluded | Drift check runs the queries and hashes Hermes' dedupe functions |
| R4 | **Experimental bb SDK APIs** (`experimental_*`); host 0.6.104 vs main 0.6.120 | M | H | Pin SDK 0.6.104; e2e at the live version; bb upgrade runbook (04) | `bb plugin types --check` per release and per bb upgrade |
| R5 | **Host-worker lifetime**: killed at 300 s with no exit event (S7 §6) | H | H | 60 s `ensureWatch`; `worker_boot_id` → full reconcile; WAL stat | Boot id changes; last-sync age |
| R6 | **Process count**: one bridge per hosted thread | M | M | Release after import; 30 min idle release; no keep-alive turns | Hosted count |
| R7 | **Concurrency limits**: $HERMES_HOST host limit 18 (r07 §4) | L | M | Serial import; short mirror turns | Wake → `turn/start` delay > 30 s |
| R8 | **Duplicate or lost messages**: re-lists, compaction clones, `/retry`, merged sends (R1 M1, M2, M6) | M | H | `turns` keyed by `message_uid`, inserted with the wake in one transaction; input segmentation | Unit tests; dogfood `/retry` check |
| R9 | **Wrong-turn control**: steer or Stop hits another client's turn (R1 M4) | M | H | Fence on our own `admission_id`; `prompt.cancel` for queued prompts | Fencing tests |
| R10 | **Irreversible Hermes writes from reads**: `session.resume` adopts legacy rows (R1 M7); detach can end rows (R1 S7) | M | H | Store reads; adopt on first send only (D16); `end_reason:null` (A24) | 0 revision changes after import |
| R11 | **Duplicate bindings**: bb accepts a duplicate handle, then 409s (S1-S3 fact 4) | M | H | `UNIQUE` key; one serial queue; `pluginMetadata` origin check on `thread.created` | Duplicate-binding query |
| R12 | **Hung mirror turns** with no canonical events (Conduit legacy writer; R1 M5) | M | M | Render persisted rows, close `partial`; the rest by re-list (no polling) | Turn age; audit |
| R13 | **Release path**: the private repo isn't readable by the server's git; exact tags pin; no downgrade (R3 M1, M2) | H | H | P0 `git ls-remote` + `gh auth setup-git` (D29); `@^0` range; roll forward; `VACUUM INTO` before removal | P0 gate |
| R14 | **Tests hit live Hermes** if the root falls back (R3 M3) | M | H | Hermes host + root required, no fallback; e2e aborts unless the instance id is the fake's | e2e step 7 |
| R15 | **Import timestamps**: items stamped "now" (S1-S3 §S1b) | H | L | Dated tags `[CLI · Oct 12]`; oldest-first import (Q7) | Dogfood P2 |
| R16 | **Notification noise**: double pushes with Conduit and Discord | M | M | D26 (user-started outside turns auto-read, no push); silent imports | Push counts in dogfood |
| R20 | **Accepted risk (user decision, D37): Hermes → bb is unguarded by the plugin.** Any Hermes chat in a profile with the bb skills, Discord included, can read and act on work threads through the bb CLI, including via prompt injection. The only guards are the skill guidance and Hermes' smart approvals; Desktop "Approvals: off" bypasses the approvals (`tools/approval.py:1017-1021`, R5 C3) | M | H | Guidance in `dev-setup`; smart approvals; kill criterion below | Log review; the user noticing work data outside bb or Conduit |
| R21 | **Privacy**: transcripts enter bb's thread store on $BB_SERVER_HOST, incl. tool results | L | H | Sensitive tools by name only in every Hermes thread (D36; the model's reply can still mention them); ids only in db, logs and `diagnostics`; no network credentials | Log review per release |
| R22 | **bb auto-answers approvals** under a permission mode (A2) | L | H | One declared mode, `auto` (D17); never-auto-approve tests; a smart-escalated command in dogfood | P1 gate |
| R23 | **Hermes host outage** (no idle sleep: keep-awake already on, D21) | L | M | Thread banner; push on reconnect; reconcile | `watch` state; Wi-Fi-off dogfood |
| R24 | **UI limits**: project catalog clash (Q9); `threads.open` moves every client; bb's own handoff drops the profile; init artifacts; mobile slots (A30) | M | L | Model mapping + warning; `useBbNavigate`; documented limitations; mute + `markRead`; pinned bots on the phone | Dogfood P1 |
| R26 | **Parity gaps**: slash commands ride legacy methods (A31); fork is verified in code only (A34); either can block ACP retirement (D25) | M | M | Protocol check in P0 (T0.12); tip-only fork fallback; legacy-only catalog → raise with the user before P1 | T0.12 result |
| R27 | **Silent semantic drift**: new row kinds, a moved author field, changed adoption rules or event order pass every structure check and show as duplicate or missing turns (R5 C2) | M | H | Semantic canary after each `hermes update`; daily audit; 7-day soak per gate; the Python reader option (T0.4) | Audit; canary diff |
| R28 | **Upkeep treadmill**: Hermes canary (~389 commits/day) and bb (7–13 releases/month) both move; the plugin can delay `hermes update` | H | M | Upkeep log; budget in the kill criteria; `contract:check --incoming` | `docs/operations.md` §Upkeep |
| R29 | **Recalled source tags**: ↑ recall resends `[Discord] …` into a thread (D15) | M | L | `message.dispatch` hook refuses tagged sends without a marker | Unit test |
| R30 | **One-way state**: Hermes-side pins, archives and renames never reach bb (D38); a refused push (duplicate title) leaves the two differing | M | L | Accepted (user decision); refusals logged in `diagnostics` | `diagnostics` |
| R31 | **Read-only Discord chip** (A41): the `discord` current value may not render or fire a pick | L | L | Fallback: Continue in bb from the rail panel's recent list (navPanel + RPC, verified surfaces) | T2.3 |

## Success metric and kill criteria (D34, R5)

- **Success metric:** bb-started Hermes messages per week (`diagnostics`) at or above the ACP baseline (~10/week: 19 visible in 14 days) for the 3 weeks after P1, with ACP unused and upkeep within budget. From P2 on, outside turns also mirror with a clean audit.
- **Kill criteria:**
  - **Usage:** 3 weeks after P1, bb-started Hermes messages per week below the baseline → no-go; stop at P1.
  - **Upkeep:** over 4 h/month averaged over 2 months, or the plugin delays a `hermes update` by over 7 days twice → freeze features; consider a retreat to ACP plus skills.
  - **Silent drift:** the audit finds duplicates or gaps in more than one week of a month → live mirror off; imports stay static.
  - **Security** (D37): work data shows up outside bb or Conduit → remove the bb skills from that profile.
  - **Obsolescence:** bb ships Hermes profiles or a canonical provider, or Hermes exposes message uids and authors publicly → migrate within one release. Hermes moves Conduit's legacy writer to canonical → delete the no-events mirror mode.
- **Exit cost** (~1 h, SUSPECTED):
  - Reversible:
    - `bb plugin disable hermes`;
    - in default, alex and david: the bb skill symlinks, `BB_SERVER_URL` and its passthrough entry (TS.1);
    - the server git helper (D29).
  - Irreversible but benign: adopted legacy rows, pushed pins, archives and renames, and deleted ACP probes (backed up).
  - bb's Hermes threads stay, read-only. Never `remove` the plugin without the `VACUUM INTO` copy.


# bb-plugin-hermes — implementation plan

Status: revised 2026-11-04 after reviews R1–R3 (`docs/plan/reviews/`). Integrates:
- S7 (`docs/spikes/S7-bb-profile-entry-sync.md`, cited `S7 §n`);
- H2 (`docs/research/11-hermes-profiles-tools.md`, cited `11 §n`).

Supersedes `docs/design/00-architecture-draft.md`. `ASSUMED` items have verify steps (04 §Assumptions). Items pending a user decision use the recommended default, marked "Qn default".

## Goal

Make Hermes Agent a first-class citizen in bb: every Hermes session is a real bb thread, with profiles, bots, live mirroring and two-way sync.

## Scope

In:
- New Hermes chats from bb: profile, optional project, model, reasoning, attachments, approvals, clarify, Stop and steer; Hermes slash commands and fork (D25).
- Import of recent Hermes sessions (deny-list); live mirror of outside activity.
- Bot threads (Hermes, Alex, David, Neo) on each profile's `Bot Chat`.
- Discord replies with echo; two-way pin, archive, rename and read.
- The `bb_tools` Hermes plugin; Settings v1; ACP retirement.

Out:
- Hermes config changes for the transport; network credentials; new ports; the dashboard.
- Remote transports A/E (S0-S4 fallbacks); editor-MCP tools (lose `clarify`, S0-S4 §T3).
- Service tiers; cron and one-shot import by default; re-importing ACP sessions; Hermes off $HERMES_HOST.

## Decisions log

D1–D15 and D22–D29 are user decisions (00 v2, BRIEF, parent, user batches 1–2). D16–D21 are parent triage of R1–R3. All dated 2026-11-04.

| # | Decision | Source |
|---|---|---|
| D1 | Local: bridge (one process per hosted thread) and host worker on $HERMES_HOST, via `~/.hermes/gateway.sock` + `hermes-gateway-v1`. No transport config change, credential or port | 00, S0-S4 §S0 |
| D2 | Every Hermes session is a real bb thread: Hermes icon, pin/archive/rename, no machine or harness picker, hidden from bb's picker, interoperates with `bb thread tell/spawn/…` | 00 |
| D3 | Profile chip in every composer and in New Hermes chat; models follow the profile; a profile change in a started chat hands off with context | 00 |
| D4 | Optional project ($HERMES_HOST only); imports with a matching cwd land in it | 00 |
| D5 | One pinned thread per bot (Hermes, Alex, David, Neo) bound to its `Bot Chat`; hide `todoist` | 00, 04 §3 |
| D6 | Import interactive and Discord sessions, last 30 days; subagents nested; one-shot and cron off | 00 |
| D7 | Outside activity mirrored live with progress, unread and notifications; outside user messages are the user's bubble with a source tag | 00 |
| D8 | bb replies post to Discord; `bb_tools` echoes "$OWNER_NAME (via bb): …" first | 00 |
| D9 | Two-way pin, archive, rename, read | 00 |
| D10 | bb tools: native Hermes plugin tools wrapping the `bb` CLI (spawn, tell, list, read, wait), per profile, in every session | 00, 10 |
| D11 | Approvals and `clarify` become bb interactions. Never auto-approve | 00 |
| D12 | Retire `acp-hermes-agent` at parity; its 18 threads stay viewable, read-only; never re-import their sessions | 00 |
| D13 | Settings v1: health; default and hidden profiles; import sources and window; hidden models; default notification level | 00 |
| D14 | Delegated execution: one writer per seam in its own jj workspace; a gate per phase; Claude-family subagents in the background | BRIEF |
| D15 | Tagged outside messages may land in bb prompt history | S7 §8 |
| D16 | Pre-migration sessions render read-only from Hermes' store; Hermes adopts one (`session.resume`) only on the first bb send | R1 M7 |
| D17 | Reasoning effort ships in P1 (bb always draws the control); one permission mode is declared | R2 M1 |
| D18 | bb tools always off on cron. `tell` is not limited to descendants (D2); args allowlist; no `tell` to its own bound thread | R1 M10 |
| D19 | P1 gate: start a Hermes chat and chat with a bot from bb on the phone | R2 U3 |
| D20 | The host worker runs the drift check whenever the Hermes version or instance changes; `npm run contract:check` is manual before `hermes update` | R3 Q2, M4 |
| D21 | $HERMES_HOST doesn't idle-sleep (`bb keep-awake` enabled, mode "all"); offline UX covers real outages only | R2 U2 |
| D22 | Hermes icon on rows: a row-metadata badge (Hermes SVG + profile name). The user turns the metadata option on once; if the spike fails, rows have no glyph | user, was Q10 |
| D23 | Discord rollover: the reply stays in bb and Hermes with "Not posted to Discord: this conversation rolled over". No rerouting | user, was Q3 |
| D24 | bb tools: spawn and tell need a Hermes approval in Discord-origin sessions; elsewhere no prompt; cron always off; args allowlist; self-tell refused | user, was Q5 |
| D25 | Before ACP retires: reasoning, Hermes slash commands and fork are required; service tier is not | user, was Q6 |
| D26 | Notifications: no push for outside turns the user started (CLI, Desktop, Conduit, Discord). Unread still set. Push for approvals, clarify and turns the user didn't start (subagents, Conduit Pulse) | user, was Q12 |
| D27 | Stop during a mirrored outside turn interrupts that Hermes turn, fenced by its admission/generation | user, was Q11 |
| D28 | bb tools may target work ($WORK_HOST) projects only from bb-bound and Conduit sessions, with an explicit `project` argument; never from Discord, cron, CLI or one-shot. If Conduit can't be told from Desktop (A5), Desktop counts as Conduit. Personal projects follow the normal tool rules | user, was Q13 |
| D29 | Repo access: `gh auth setup-git` on the bb server (reuses its gh login); P0 `git ls-remote https://github.com/AndrewBird81/bb-plugin-hermes` as the bb server's user | user, was Q14 |

Plan-level choices (reversible):
- **Reads and writes:** reads come from a read-only store reader, writes and live events from canonical. `session.resume` adopts legacy rows and carries no `message_uid` (R1 M2, M7).
- **Mirror path:** one path for hosted and idle threads, a tagged `threads.send` per outside turn. No bridge-opened turns.
- **Single writers:** the server is the only writer of bb → Hermes state; the worker is the only writer of `bindings.json`.
- **Lazy sessions:** a Hermes session is created on the first visible message (09 M6).
- **Chips:** profile and model are picked in bb's own composer chips; the profile chip always lists every profile (S7 §1a). The model list is per thread (`models.scope:"workspace"`); no profile-namespaced ids.
- **Navigation:** `useBbNavigate` first; `threads.open` moves every client, so it is a fallback (S7 finding 3).
- **Bots:** pinned; no "Bots" section (S7 §4). Settings ship with the phase that reads them.

Possible gold-plating (scheduled late, droppable): subagent sub-threads (1 subagent session exists, 04 §6); the Discord echo (one private contextvar, 11 §4); "Older Hermes chats" (P6); webui retirement (P6, optional).

Approvals needed at execution time:
- `gh auth setup-git` on the bb server, reusing its gh login (D29).
- `hermes plugins install` + `enable bb_tools` into 4 live profile homes, `tools disable bb --platform cron`, and the new `~/.hermes/bb_tools/` files. D1's "no config change" covers the transport only.
- A live gateway restart in P1 dogfood (drops every live Hermes session, Discord and Conduit included).
- The first live import; any live Discord test.
- Deleting ACP probe sessions (after a backup); disabling `acp-hermes-agent`; webui retirement.
- Pushes, tags and live installs.

## Glossary

| Term | Meaning |
|---|---|
| server part / host worker / bridge | Plugin code in the bb server / a long-lived $HERMES_HOST worker holding one Hermes connection / one $HERMES_HOST process per hosted thread |
| hosted | A thread with a live bridge process; released after 30 min idle |
| canonical | `hermes-gateway-v1` on `/api/ws` (08 §1) |
| store reader | Read-only SQLite access (`mode=ro`) to each profile's `state.db` |
| profile home | Hermes `profile_id` (home path) |
| lineage root | Hermes logical id (`chat_id` owner), stable across compaction. **Tip** = current physical id |
| anchor | `message_uid` of a turn's user message (or first assistant message); the mirror dedupe key |
| legacy session | A pre-migration row (not gateway-owned) that a `session.resume` would adopt |
| binding | Mapping-db row: bb thread ↔ (profile home, lineage root) |
| marker | Agent-only `<hermes-bb>{…}</hermes-bb>` input; never rendered |
| replay / mirror turn | A bb turn rendering past history / an outside turn; never calls `prompt.submit` |
| wake | A server `threads.send(queue-if-active)` that starts a mirror turn |
| outside activity | Turns not started from bb: CLI, TUI, Desktop, Conduit, Discord, subagents |
| Bot Chat | A profile's hidden canonical session titled `Bot Chat` |
| tombstone | A row that blocks a session from import |

## Files

| File | Content |
|---|---|
| `01-product.md` | Behaviour by flow (F1–F14), with acceptance criteria |
| `02-architecture.md` | Components, mapping db, contracts, protocol mapping, 16 flows, invariants, security |
| `03-testing.md` | Test layers, strict fake, fixtures, e2e recipe, drift check, dogfood, gates |
| `04-delivery.md` | Layout, phases, tasks, assumptions, release, rollout, rollback, cleanup |
| `05-risks.md` | Risk register |

## Plan defaults (reversible)

No user decisions are pending: Q3, Q5, Q6, Q10–Q14 became D22–D29. The defaults below were not asked as questions. They were shown to the user on 2026-11-04 ("taking unless you object"), with no objection, and the reviews found them consistent with intent (R2 "checked and fine").

| # | Question | Default (applied) | Alternatives |
|---|---|---|---|
| Q1 | Delete policy | No cross-delete. bb delete → tombstone; Hermes delete → archive + "Deleted in Hermes", sends refused | Mirror deletes |
| Q2 | Bot threads vs two-way rename/archive (conflicts with D9): Bot Mode finds `Bot Chat` by its exact title | Bot titles never sync; archive bb-only | Sync anyway (breaks Bot Mode) |
| Q4 | One thread per Discord conversation across resets? | No: per session | Merge by route |
| Q7 | Imported items show import time | Accept; dated tags `[CLI · Oct 12]`; oldest-first import | — |
| Q8 | Uncommitted hermes-host bb adapter (04 §5) | Ask the user before touching hermes-host (P0). Recommended: commit it, then delete it at P6 | Delete now |
| Q9 | Project chats share one model list per folder (S7 finding 1) | Accept; unoffered model → profile default + warning | Worktree per chat (Hermes then works in a worktree) |

## Review resolution

| Finding | Fixed in, or why not |
|---|---|
| R1 M1 duplicate wakes | 02 `turns` table (wake + insert in one transaction), flow 4; 03 §1 |
| R1 M2 row ids unstable | 02 `turns` keyed by `message_uid`, store reader; A8; T2.0 fixtures |
| R1 M3 id before spawn | 02 identity rules (binding after spawn; `pluginMetadata.hermes.origin`); 03 §1 |
| R1 M4 steer/Stop fencing | 02 protocol mapping; 01 F8; 03 bridge tests |
| R1 M5 mirror never closes | 02 flow 4.3 (three modes, poll, 10 min `partial`); T2.0 Conduit fixture |
| R1 M6 merged queued sends | 02 input parsing; A25; 03 bridge tests |
| R1 M7 import adopts legacy rows | D16; 02 placement rules, flow 3; A23; `importPreview` legacy count |
| R1 M8 handoff context | 02 flow 7.4 + bridge state. The block comes from the store, not `session.export`, so a legacy source is never adopted |
| R1 M9 "has messages" | 02 flow 7 (binding state); `init` refused unless `pending:`; 03 §1 |
| R1 M10 bb tools security | D18, D24; 02 flow 15 + security; 01 F11. Not applied: bb-bound-only spawn/tell (conflicts with D10 "every session"); `tell` limited to descendants (conflicts with D2). The Discord-platform disable became the D24 approval |
| R1 S1 hidden outside approvals | 02 event filter (session-scoped prompts; re-raise on attach) |
| R1 S2 mid-turn text loss | 02 flow 4.3 (`events.since` from turn start, else final text); 03 test |
| R1 S3 admission matching | 02 flow 4.3 (close on matching `persisted_turn`) |
| R1 S4 import vs live | 02 flow 4.1 (skip `replaying`); replay rows in `turns` |
| R1 S5 bot titles | 01 F4; 02 flows 8–9, invariants |
| R1 S6 missing params | 02 protocol mapping; 03 §9 used surface |
| R1 S7 detach ends rows | 02 `end_reason:null`; A24; store reads |
| R1 S8 worker restart | 02 `worker_boot_id`; first WAL stat = changed |
| R1 S9 unverified assumptions | A4 extended; A19; A20 |
| R1 S10 david cwd | 01 F2; 02 flow 1 (`~` fallback) |
| R1 S11 `bindings.json` | 02 files (atomic, 0700/0600, route → newest); A12 includes `HOME` |
| R1 S12 child notifications | 02 flow 15 (`parentNotifications:"off"`); 01 F7 |
| R1 S13 Bot Chat on Discord | 01 F4 banner; 02 flow 10 (`handed_off`) |
| R1 S14 outbox | 02: dropped; reconnect diff; `synced.title_bb/title_hermes` |
| R1 S15 `running` | 02 `listSessions` (field removed) |
| R1 questions | D24, D27; pre-migration → D16 |
| R2 M1 reasoning | D17, D25; 01 F2/F3; 02 `initialize` + mapping; T1.5b |
| R2 M2 attachments | 02 mapping; T1.12; T1.0 fixture; 01 F2 AC, F6 (text-only mirror); voice in dogfood |
| R2 M3 source allow-list | 02 invariants (deny-list); 01 F5, F12; `e2e/eligibility` |
| R2 M4 icon | D22; 01 F1; T1.4 (A28); `assets/hermes.svg` |
| R2 S1 type-first | 01 F1/F2; T1.4 (A27; fallback message box) |
| R2 S2 titles | 02 invariants, flow 8; 01 F2 AC, F5 fallback |
| R2 S3 notification noise | D26; 02 flow 4.2/4.4; 01 F6, F10 |
| R2 S4 $WORK_HOST | 01 F1 (hidden row, error text); 02 mapping; D28; dogfood P1 two hosts |
| R2 S5 asleep UX | 02 flow 14 banner; D21; A9 |
| R2 S6 older sessions | 01 F5 (backfill on window raise; older chats); T6.5a/b |
| R2 S7 `/compact` | D25: required. P0 protocol check T0.12 (A31–A33); T1.13; 01 F14 |
| R2 S8 stack trim | 01 F13; T6.7 (optional, user-approved) |
| R2 S9 cold catalog | 02 worker prewarm; bridge 2 s timeout + last-known list |
| R2 S10 dates | 01 F5 dated tags; Q7 |
| R2 S11 agent sends echoed as user | 02 `turn_author` name; A21; 01 F7 (limitation if unmarked) |
| R2 U1–U6 | D26; D21; D19; D28; D25; D22 |
| R3 M1 private repo | D29; 04 release step 4; T0.11; P0 gate |
| R3 M2 release/update/rollback | 04 release (`@^0`, `bb plugin update`), rollback (roll forward, disable, `VACUUM INTO`); A26 |
| R3 M3 e2e hits live | 02 `hermesRoot` (required, no fallback); 03 §5, §6 step 7; F12 |
| R3 M4 drift venue | D20; 02 drift check; 03 §9 |
| R3 M5 `bb_tools` pinning | 04 release step 5 (`--ref`, `--no-enable`); `schema_version`; A29 |
| R3 M6 plugin test venue | 03 §7–8 (own venv, stubs) |
| R3 S1 observability | `diagnostics` RPC (02, T0.8/T0.9); run at every gate (03) |
| R3 S2 interrupted import | 02 flow 3 (delete hidden thread, re-queue); 03 §1 |
| R3 S3 migrations | 02 mapping db; 03 §1; 04 rollout `VACUUM INTO` |
| R3 S4 work breakdown | 04 (one seam per task, T1.0/T2.0, critical path, serial gates) |
| R3 S5 loose fake | 03 §5 (strict, vendored contract) |
| R3 S6 count check | `e2e/eligibility` from shared constants (03 §1, 01 F5) |
| R3 S7 bb upgrades | 04 bb upgrade runbook; F12 versions in health |
| R3 S8 rollout vs gates | 04 phases (live install in P0); 03 P0 gate |
| R3 S9 recipe gaps | 03 §6 steps 2 and 5 |
| R3 S10 cleanup order | 04 data cleanup; T6.4 after T6.3; 01 F13 |
| R3 S11 approvals list | README approvals list |
| R3 S12 user docs | T6.6 (`guide.md`, `operations.md` appended per phase, `PLUGIN_OVERVIEW.md`) |
| R3 S13 A9 check | 03 dogfood P2 (Wi-Fi off on $HERMES_HOST) |
| R3 Q1, Q2 | D29; D20 |

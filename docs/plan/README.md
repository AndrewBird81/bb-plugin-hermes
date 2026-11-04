# bb-plugin-hermes — implementation plan

Status: revised 2026-11-04 after reviews R1–R4 (`docs/plan/reviews/`). Integrates:
- S7 (`docs/spikes/S7-bb-profile-entry-sync.md`, cited `S7 §n`);
- H2 (`docs/research/11-hermes-profiles-tools.md`, cited `r11 §n`).

Supersedes `docs/design/00-architecture-draft.md`. `ASSUMED` items have verify steps (04 §Assumptions). Citations: research files are `rNN §n`, plan files `01`–`05`, spikes `S…`.

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
- Service tiers; cron and one-shot import by default; re-importing ACP sessions; Hermes on a machine that isn't a bb host (moving Hermes = changing the D30 setting).

## Decisions log

D1–D15 and D22–D29 are user decisions (00 v2, BRIEF, user batches 1–2). D16–D21 and D30–D33 are parent triage, presented to the user with the plan. All dated 2026-11-04.

| # | Decision | Source |
|---|---|---|
| D1 | Local: bridge (one process per hosted thread) and host worker on the Hermes host ($HERMES_HOST), via `~/.hermes/gateway.sock` + `hermes-gateway-v1`. No transport config change, credential or port | 00, S0-S4 §S0 |
| D2 | Every Hermes session is a real bb thread: Hermes icon, pin/archive/rename, no machine or harness picker, hidden from bb's picker, interoperates with `bb thread tell/spawn/…` | 00 |
| D3 | Profile chip in every composer and in New Hermes chat; models follow the profile; a profile change in a started chat hands off with context | 00 |
| D4 | Optional project ($HERMES_HOST only); imports with a matching cwd land in it | 00 |
| D5 | One pinned thread per bot (Hermes, Alex, David, Neo) bound to its `Bot Chat`; hide `todoist` | 00, r04 §3 |
| D6 | Import interactive and Discord sessions, last 30 days; subagents nested; one-shot and cron off | 00 |
| D7 | Outside activity mirrored live with progress, unread and notifications; outside user messages are the user's bubble with a source tag | 00 |
| D8 | bb replies post to Discord; `bb_tools` echoes "$OWNER_NAME (via bb): …" first | 00 |
| D9 | Two-way pin, archive, rename, read | 00 |
| D10 | bb tools: native Hermes plugin tools wrapping the `bb` CLI (spawn, tell, list, read, wait), per profile, in every session | 00, r10 |
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
| D21 | No keep-awake change: it was already on (verified 2026-11-04, `bb keep-awake status` → enabled, all hosts). Offline UX covers real outages only | R2 U2 |
| D22 | Hermes icon on rows: a row-metadata badge (Hermes SVG + profile name). The user turns the metadata option on once; if the spike fails, rows have no glyph | user, was Q10 |
| D23 | Discord rollover: the reply stays in bb and Hermes with "Not posted to Discord: this conversation rolled over". No rerouting | user, was Q3 |
| D24 | bb tools: spawn and tell need a Hermes approval in Discord-origin sessions; elsewhere no prompt; cron always off; args allowlist; self-tell refused | user, was Q5 |
| D25 | Before ACP retires: reasoning, Hermes slash commands and fork are required; service tier is not | user, was Q6 |
| D26 | Notifications: no push for outside turns the user started (CLI, Desktop, Conduit, Discord). Unread still set. Push for approvals, clarify and turns the user didn't start (subagents, Conduit Pulse) | user, was Q12 |
| D27 | Stop during a mirrored outside turn interrupts that Hermes turn, fenced by its admission/generation | user, was Q11 |
| D28 | Work boundary: a $WORK_HOST target (spawn's `project`; the target thread's project for tell/read/wait; `list` filtered) is allowed only when the turn's author is `bb:…` or Conduit (Desktop too if A5 can't separate them) **and** the session isn't Discord-origin. Else `tool_error`. $WORK_HOST = the project's environment host. Personal projects: normal rules | user, was Q13; R4 M1 |
| D29 | Repo access: `gh auth setup-git` on the bb server (reuses its gh login); P0 `git ls-remote https://github.com/AndrewBird81/bb-plugin-hermes` as the bb server's user | user, was Q14 |
| D30 | Required server settings "Hermes host" (a bb host) and "Hermes root". Unset → unconfigured, no Hermes I/O. Logic never names $HERMES_HOST | parent, R4 |
| D31 | Bot pin: setup pushes `pinned:true` to the Bot Chat and sets `synced.pinned=true`, then normal sync. Fallback: bb-only pin, user told | parent, R4 S2 |
| D32 | Deny-list adds `a2a` and `tool`; `api_server` imports as `[API]`. Verified 2026-11-04: 0 non-empty sessions of all three in 30 days | parent, R4 S9 |
| D33 | "User-started" (D26): the user's own Discord id, bb, CLI, TUI, Desktop, Conduit. Other Discord users and `a2a` push; unknown author: no push. Imports take Hermes' pinned/archived state | parent, R4 |

Plan-level choices (reversible):
- **Reads and writes:** reads come from a read-only store reader, writes and live events from canonical. `session.resume` adopts legacy rows and carries no `message_uid` (R1 M2, M7).
- **Mirror path:** one path for hosted and idle threads, a tagged `threads.send` per outside turn. No bridge-opened turns.
- **Single writers:** the server is the only writer of bb → Hermes state; the worker is the only writer of `bindings.json`.
- **Lazy sessions:** a Hermes session is created on the first visible message (r09 M6).
- **Chips:** profile and model are picked in bb's own composer chips; the profile chip always lists every profile (S7 §1a). The model list is per thread (`models.scope:"workspace"`); no profile-namespaced ids.
- **Navigation:** `useBbNavigate` first; `threads.open` moves every client, so it is a fallback (S7 finding 3).
- **Bots:** pinned; no "Bots" section (S7 §4). Settings ship with the phase that reads them.

Possible gold-plating (scheduled late, droppable): "Older Hermes chats" (P6); webui retirement (P6, optional). Subagent nesting and the Discord echo are user decisions: dropping either needs user OK (R4 S6).

Approvals needed at execution time:
- `gh auth setup-git` on the bb server, reusing its gh login (D29).
- `hermes plugins install` + `enable bb_tools` into 4 live profile homes, and the new `<hermesRoot>/bb_tools/` files. D1's "no config change" covers the transport only.
- Any Hermes toolset or platform config change (e.g. `tools disable bb --platform cron`). Under D24 the `bb` toolset stays live on Discord, guarded by approval.
- A live gateway restart in P1 dogfood (drops every live Hermes session, Discord and Conduit included).
- The first live import; the first live two-way state sync; any live Discord test.
- Deleting ACP probe sessions (after a backup); disabling `acp-hermes-agent`; webui retirement.
- Pushes, tags and live installs.
- Each approval is logged in `docs/operations.md` §Approvals (date, item, answer); gated tasks check it first.

## Glossary

| Term | Meaning |
|---|---|
| server part / host worker / bridge | Plugin code in the bb server / a long-lived $HERMES_HOST worker holding one Hermes connection / one $HERMES_HOST process per hosted thread |
| hosted | A thread with a live bridge process; released after 30 min idle |
| canonical | `hermes-gateway-v1` on `/api/ws` (r08 §1) |
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
| Q8 | Uncommitted hermes-host bb adapter (r04 §5) | The T0.1 lead asks the user before anything touches hermes-host. Recommended: commit it, then delete it at P6 | Delete now |
| Q9 | Project chats share one model list per folder (S7 finding 1) | Accept; unoffered model → profile default + warning | Worktree per chat (Hermes then works in a worktree) |

## Review resolution

| Finding | Fixed in, or why not |
|---|---|
| R1 M1, M2 wakes and row ids | 02 `turns` (keyed by `message_uid`; `INSERT OR IGNORE` then send), flow 4; A8; 03 §1 |
| R1 M3 id before spawn | 02 identity rules (binding after spawn; `pluginMetadata.hermes.origin`); 03 §1 |
| R1 M4, M6 fencing, merged sends | 02 protocol mapping, input parsing; A25; 01 F8; 03 bridge tests |
| R1 M5 mirror never closes | 02 flow 4.3 (three modes, poll, 10 min `partial`); T2.0 Conduit fixture |
| R1 M7 legacy adoption | D16; 02 placement and store rules, flow 3; A23; `importPreview` legacy count |
| R1 M8 handoff context | 02 flow 7.4 + bridge state. From the store, not `session.export`, so a legacy source is never adopted |
| R1 M9 "has messages" | 02 flow 7 (binding state); `init` refused unless `pending:` |
| R1 M10 bb tools security | D18, D24, D28; 02 flow 15. Not applied: limiting all spawn/tell to bb turns (conflicts with D10); `tell` limited to descendants (conflicts with D2) |
| R1 S1–S4 mirror details | 02 event filter (session-scoped prompts), flow 4.1–4.3 (`events.since`, `persisted_turn` match, skip `replaying`) |
| R1 S5, S13 bots | 01 F4; 02 flows 8–10 |
| R1 S6–S8, S15 protocol | 02 mapping params, `end_reason:null` (A24), `worker_boot_id`, no `running` |
| R1 S9–S12 | A4, A19, A20; 01 F2 (`~` cwd); 02 files (atomic, 0700/0600); flow 15 `parentNotifications:"off"` |
| R1 S14 outbox | 02: dropped; reconnect diff; `synced.title_bb/title_hermes` |
| R1 questions | D24, D27, D16 |
| R2 M1 reasoning | D17, D25; 01 F2/F3; 02 `initialize`; T1.5b |
| R2 M2 attachments | 02 mapping; T1.12; T1.0 fixture; 01 F2, F6 |
| R2 M3 allow-list | 02 invariants (deny-list); D32; 01 F5, F12; `e2e/eligibility` |
| R2 M4 icon | D22; 01 F1; T1.4 (A28) |
| R2 S1, S2 type-first, titles | 01 F1/F2, F5; 02 invariants, flow 8; A27 |
| R2 S3–S5 | D26, D33; D28; D21; 02 flows 4, 14; A9; 01 F1, F6, F10 |
| R2 S6–S11 | 01 F5 (backfill, older chats, dated tags), F13 (webui), F14 (`/compact`), F7; 02 prewarm, `turn_author`; T6.5, T6.7; A21 |
| R2 U1–U6 | D26, D21, D19, D28, D25, D22 |
| R3 M1, M2 release | D29; 04 release (`@^0`, update), rollback (roll forward, disable, `VACUUM INTO`); T0.11; A26 |
| R3 M3 e2e hits live | D30 settings (no fallback); 03 §5, §6 step 7 |
| R3 M4, M5, M6 | D20, 02 drift check; 04 release step 5 (`--ref`, `--no-enable`), `schema_version`, A29; 03 §7–8 venv |
| R3 S1–S3 | `diagnostics` (02, T0.8/T0.9, every gate); 02 flow 3 redo; migrations (02, 03 §1, `VACUUM INTO`) |
| R3 S4–S6 | 04 work breakdown; 03 §5 strict fake; `e2e/eligibility` |
| R3 S7–S13 | 04 bb upgrade runbook, P0 live install, cleanup order, T6.6 docs; 03 §6 recipe, Wi-Fi-off dogfood; README approvals |
| R3 Q1, Q2 | D29; D20 |
| R4 M1 work boundary | D28 rewritten (turn author + not Discord-origin; every tool); 01 F11 AC; 02 flow 15, security; 03 §8; A35 |
| R4 M2 `bb_tools` path | 02 files and drift paths under `<hermesRoot>`; 03 §5, §9 |
| R4 M3 store reader | 02 store rules: (a) mismatch policy, (b) scaffolding excluded, (c) author join + `persisted_turn` dedupe (A37), (d) A36 first in T0.4, (e) function hashes; 03 §1, §9 |
| R4 M4 `thread/resume` | 02 mapping: identity only; lazy `session.resume`; invariants |
| R4 Hermes host (decisions check) | D30; 02 placement; 01 F1/F2/F12; no $HERMES_HOST in logic |
| R4 S1 `/retry` | 02 `turns.reply_uids`, `mirror{rest:true}`; 01 F6; 03 §1, T2.0 fixture |
| R4 S2 bot pin | D31; 02 flow 9 (pin; bot archive exemption); T3.1 verify; 03 P3 gate |
| R4 S3 approvals | README approvals list (toolset/platform changes, first two-way sync); D21 reworded (not a change) |
| R4 S4 echo after rollover | 02 flow 6 + `messaging_bound`; 01 F7; 03 §8 |
| R4 S5 "always" answer | D24 via per-call `rule_key` (02 flow 15; 01 F11; 03 §8) |
| R4 S6 droppable features | Removed from gold-plating; T2.7 unlabelled |
| R4 S7 wake atomicity | 02 `turns` rules, flow 4.2, flow 13 boot recovery; 03 §1 |
| R4 S8 delete frees handle | A38 (T2.9); 02 flow 3 |
| R4 S9 import scope | D32; 01 F5; 02 invariants |
| R4 S10 citations | Research refs prefixed `rNN` in all plan files |
| R4 S11 minor | README status line; 05 order; A21 → T1.1; cron platform note (02 flow 15, 04 release) |
| R4 ambiguities | SQLite binding: A36. Hermes host: D30. Q8: T0.1 lead. Schema mismatch: 02 store rules. Bot pin: D31. Import state and user-started: D33, A39. Approvals log: `docs/operations.md` §Approvals (README, 04 Rollout). D16–D21: labelled parent triage |

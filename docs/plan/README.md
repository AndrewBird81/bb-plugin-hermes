# bb-plugin-hermes — implementation plan

Status: revised 2026-11-04 after reviews R1–R6 (`docs/plan/reviews/`), user batches 1–4 and parent batch 5a.

**Superseded in part.** User decisions D42–D46 (the answers to Q18–Q21, and a scope reset) are not yet applied to this README's other sections or to `01`–`05`. Read `scope-reset.md` first: the proposed lean v1 is awaiting the user's OK (Q22–Q25).

Integrates:
- S7 (`docs/spikes/S7-bb-profile-entry-sync.md`, cited `S7 §n`);
- H2 (`docs/research/11-hermes-profiles-tools.md`, cited `r11 §n`).

Supersedes `docs/design/00-architecture-draft.md`. `ASSUMED` items have verify steps (04 §Assumptions). Citations: research files are `rNN §n`, plan files `01`–`05`, spikes `S…`.

## Goal

Make Hermes Agent a first-class citizen in bb: every Hermes session is a real bb thread, with profiles, bots, live mirroring, and bb state pushed to Hermes.

- **Success metric** (D34): bb-started Hermes messages per week (`diagnostics`), against the ACP baseline of ~10 a week (19 visible in 14 days, R5). Target: at or above the baseline for the 3 weeks after P1, with ACP unused and upkeep within budget.
- **Go/no-go after P1** (D34): the user decides on P2 onward from that data. Kill criteria: 05.

## Scope

In:
- New Hermes chats from bb: profile, optional project, model, reasoning, attachments, approvals, clarify, Stop and steer; Hermes slash commands and fork (D25).
- Import of recent Hermes sessions (deny-list); live mirror of outside activity. Discord read-only, with Continue in bb (D39).
- Bot threads: one pinned bb Hermes chat per profile (Hermes, Alex, David, Neo; D35).
- Pin, archive and rename pushed bb → Hermes (D38).
- Settings v1; ACP retirement.
- Standalone, outside the plugin: Neo's bb skills for default, alex and david (D37, TS.1).

Out:
- Hermes config changes for the transport; network credentials; new ports; the dashboard.
- Remote transports A/E (S0-S4 fallbacks); editor-MCP tools (lose `clarify`, S0-S4 §T3).
- A Hermes plugin; enforced bb access rules (D37); replies into Discord (D39); Hermes → bb state and read sync (D38).
- Bot Chat sharing with Conduit and Desktop (D35); sensitive tool results in bb (D36); service tiers; cron and one-shot import by default; re-importing ACP sessions; Hermes on a machine that isn't a bb host (moving Hermes = changing the D30 setting).

## Decisions log

D1–D15, D22–D29, D34–D39 and D42–D46 are user decisions (00 v2, BRIEF, user batches 1–4, Q18–Q21 and the scope reset). D16–D21, D30–D33 and D40–D41 are parent triage, presented to the user with the plan. The R5 changes to D16, D26 and D33, and the R6 changes to D20, D26, D28, D33 and D36 (batch 5a), were shown to the user as "taking unless you object". All dated 2026-11-04.

| # | Decision | Source |
|---|---|---|
| D1 | Local: bridge (one process per hosted thread) and host worker on the Hermes host ($HERMES_HOST), via `~/.hermes/gateway.sock` + `hermes-gateway-v1`. No transport config change, credential or port | 00, S0-S4 §S0 |
| D2 | Every Hermes session is a real bb thread: Hermes icon, pin/archive/rename, no machine or harness picker, hidden from bb's picker, interoperates with `bb thread tell/spawn/…` | 00 |
| D3 | Profile chip in every composer and in New Hermes chat; models follow the profile; a profile change in a started chat hands off with context | 00 |
| D4 | Optional project (on the Hermes host, D30; $HERMES_HOST today); imports with a matching cwd land in it | 00 |
| D5 | One pinned thread per bot (Hermes, Alex, David, Neo); hide `todoist`. The Bot Chat binding is superseded by D35 | 00, r04 §3 |
| D6 | Import interactive and Discord sessions, last 30 days; subagents nested; one-shot and cron off | 00 |
| D7 | Outside activity mirrored live with progress, unread and notifications; outside user messages are the user's bubble with a source tag | 00 |
| D8 | Superseded by D39 (was: bb replies post to Discord, with an echo) | 00 |
| D9 | Superseded by D38 (was: two-way pin, archive, rename, read) | 00 |
| D10 | Superseded by D37 (was: native bb tools in a Hermes plugin) | 00, r10 |
| D11 | Approvals and `clarify` become bb interactions. Never auto-approve | 00 |
| D12 | Retire `acp-hermes-agent` at parity; its 18 threads stay viewable, read-only; never re-import their sessions | 00 |
| D13 | Settings v1: health; default and hidden profiles; import sources (Discord included, toggleable) and window; hidden models; default notification level | 00 |
| D14 | Delegated execution: one writer per seam in its own jj workspace; a gate per phase; Claude-family subagents in the background | BRIEF |
| D15 | Tagged outside messages may land in bb prompt history. bb refuses sends that start with a source tag (↑-recall resends) | S7 §8; R5 |
| D16 | Pre-migration sessions render read-only from Hermes history; Hermes adopts one (`session.resume`) only on the first bb send. No Hermes mutations for a legacy binding until then (they claim it, A23). Conduit's live legacy rows: pending Q20 | R1 M7; R5 C5; R6 C5 |
| D17 | Reasoning effort ships in P1 (bb always draws the control). One permission mode, `auto`, is declared and tested in T1.2 (A2) | R2 M1; R5 |
| D18 | Superseded by D37 (`bb_tools` rules) | R1 M10 |
| D19 | P1 gate: start a Hermes chat and chat with a bot from bb on the phone | R2 U3 |
| D20 | No human step: the worker runs the drift check on each Hermes version or instance change and `contract:check --incoming` (fetch, check `origin/main`) daily; from P2 the semantic canary on each version change, or health shows "canary due" if it can't drive isolated Hermes. Daily: the `audit` RPC | R3 Q2, M4; R5 C2; R6 |
| D21 | No keep-awake change: it was already on (verified 2026-11-04, `bb keep-awake status` → enabled, all hosts). Offline UX covers real outages only | R2 U2 |
| D22 | Hermes icon on rows: a row-metadata badge (Hermes SVG + profile name). The user turns the metadata option on once; if the spike fails, rows have no glyph | user, was Q10 |
| D23 | Superseded by D39 (Discord rollover notice) | user, was Q3 |
| D24 | Superseded by D37 (approvals for bb tools in Discord sessions) | user, was Q5 |
| D25 | Before ACP retires: reasoning, Hermes slash commands and fork are required; service tier is not. Slash and fork gate P3, not the P1 exit | user, was Q6; R5 |
| D26 | Outside turns the user started (CLI, Desktop/Conduit, Discord) and hidden-prompt turns (user row hidden, e.g. Pulse) are marked read automatically: no dot, no push. Turns the user didn't start (subagents) keep the dot and push. Approvals and clarify always push. Hermes records no reads (`last_read_at` unset on 0 of 455 sessions) | user, was Q12; parent, R5 C7, R6 C6 |
| D27 | Stop during a mirrored outside turn interrupts that Hermes turn, fenced by its admission/generation | user, was Q11 |
| D28 | Work/personal rule, guidance text in the bb skills, not enforced (D37): a thread is work when it runs on $WORK_HOST ("$WORK_HOST is always work", `~/.agents/reference/model-routing.md`). The 4 projects on both hosts (nix-config, src, bb-plugin-code-review-workspace, bb-plugin-conductor) are personal. Hermes chats can't be in work projects, which have no $HERMES_HOST checkout | user, was Q13; parent, R6 |
| D29 | Repo access: `gh auth setup-git` on the bb server (reuses its gh login); P0 `git ls-remote https://github.com/AndrewBird81/bb-plugin-hermes` as the bb server's user. R5's alternative (public code in the `bb-plugins` monorepo, docs private) not taken | user, was Q14 |
| D30 | Required server settings "Hermes host" (a bb host) and "Hermes root". Unset → unconfigured, no Hermes I/O. Logic never names $HERMES_HOST | parent, R4 |
| D31 | Removed by D35 | parent, R4 S2 |
| D32 | Deny-list adds `a2a` and `tool`; `api_server` imports as `[API]`. Verified 2026-11-04: 0 non-empty sessions of all three in 30 days | parent, R4 S9 |
| D33 | "User-started" (D26): the user's own Discord id, bb, CLI, TUI, Desktop/Conduit. Decided by source: Desktop and Conduit admissions carry no author (R5). Other Discord users and `a2a` push; unknown author: no push. Imports take Hermes' archived state, never its pin (R6 C6) | parent, R4; R5; R6 |
| D34 | Scope: the full plan, with a go/no-go checkpoint after P1. The user decides on P2 onward from P1 usage and upkeep data (success metric above; kill criteria in 05) | user, R5 question 1 |
| D35 | Bots: each bot (Hermes, Alex, David, Neo) is its own pinned bb Hermes chat, a bb-created session in that profile, not bound to the profile's Bot Chat. Supersedes D5's Bot Chat part, Q2 and D31. Built in P1; P3 (bots) removed (user: no objection) | user, R5 question 5 |
| D36 | Privacy: sensitive tool results render in bb by tool name only ("used conduit_location") in every Hermes thread, bb-started chats included. Prefix rule: `conduit_*` and `mcp__Home_Assistant__*` (R6 C7). The full result stays in Hermes; the model's reply can still mention the data. The rule lives in code, with a `provides_tools` test | user, R5 C7; parent, R6 C7 |
| D37 | Hermes uses bb through skills plus the `bb` CLI, as Neo does today. Neo's `bb-start`, `bb-inquire`, `bb-reply`, `bb-review` and `dev-setup` go to default, alex and david (TS.1). Hermes' smart approvals apply; no Hermes plugin. Threads Hermes starts don't nest under its chat (accepted). R6 C2: smart approvals flag no `bb` command; guard pending Q19 | user, was Q15 |
| D38 | State is one-way, bb → Hermes, for pin, archive and rename. Hermes-side changes never come back; imports read them once. Read state isn't synced | user, was Q16 |
| D39 | No replies from bb into Discord. Discord sessions mirror live, read-only; "Continue in bb" hands off to a new bb chat with the conversation | user, was Q17 |
| D40 | Read path (R6 C3, C4): no Hermes history reader before the go/no-go; the P1 handoff block comes from bb's own timeline. In P2, T2.0b spikes Hermes' REST projection (Desktop's `native-http` path) first, with TS `node:sqlite` as fallback; the venv-Python reader is dropped (webui's Python 3.11). Golden files and audit anchors come from Hermes' projection | parent, R6 |
| D41 | Deny-list fails closed: every deny label checks `source` and `created_source`; more than 5 new automatic imports a day → pause import, health red | parent, R6 |
| D42 | Full mirroring: every session of an enabled bot started outside bb, Conduit included, appears as a bb thread automatically and keeps updating. No "Continue in bb" needed, no P2-lite | user, was Q18 |
| D43 | One switch per bot in plugin settings. On = the bot is available to chat in bb **and** has full access to operate bb, through a plugin-installed bb skill (S8 §Secondary). Restrictions come later. Not Neo-only, not all bots. Design only: no live change approved. Supersedes D37 and TS.1 | user, was Q19 |
| D44 | One shared conversation: each enabled bot keeps one pinned bb thread, and it is that profile's single Bot Chat, mirrored both ways. Replies from bb or Conduit stay in that conversation, and so do Conduit's other mirrored chats. No fork, split, copy or read-only view, and no takeover that stops Conduit. Minimum coordination per S8. Supersedes D35's bb-only session | user, was Q20 + clarification |
| D45 | hermes-webui is left alone and is out of scope: no retirement in this work (drops T3.7) | user, was Q21 |
| D46 | Scope reset: v1 is the basics for a general Hermes user installing a public bb plugin. Deferred: the user's work/home split, edge-case permissions, path restrictions and elaborate multi-client policy. D42–D44 stay. Proposed v1 and backlog: `scope-reset.md` (awaiting OK) | user |

Plan-level choices (reversible):
- **Reads and writes:** reads come from Hermes history (P2 on; REST projection first, D40), writes and live events from canonical. `session.resume` adopts legacy rows and carries no `message_uid` (R1 M2, M7).
- **Mirror path:** one path for hosted and idle threads, a tagged `threads.send` per outside turn. No bridge-opened turns.
- **Single writer:** the server is the only writer of bb → Hermes state.
- **Lazy sessions:** a Hermes session is created on the first visible message (r09 M6).
- **Chips:** profile and model are picked in bb's own composer chips; the profile chip always lists every profile (S7 §1a). The model list is per thread (`models.scope:"workspace"`); no profile-namespaced ids.
- **Navigation:** `useBbNavigate` first; `threads.open` moves every client, so it is a fallback (S7 finding 3).
- **Bots:** pinned; no "Bots" section (S7 §4); built in P1.
- **Titles:** type-first chats use bb's own title generator; empty chats take the first message; bb titles push one-way (D38).
- **Continue in bb** reuses the verified chip handoff (S7 §1d): a read-only Discord thread's chip shows "Discord · read-only", and a profile pick hands off (A41).
- **No history polling:** a turn with no canonical events (a legacy writer) renders what is persisted and closes `partial`; later rows arrive by re-list.
- Settings ship with the phase that reads them.

Possible gold-plating (scheduled late, droppable): "Older Hermes chats" (P3); webui retirement (P3, optional; timing pending Q21). Subagent nesting is a user decision: dropping it needs user OK (R4 S6).

Approvals needed at execution time:
- `gh auth setup-git` on the bb server, reusing its gh login (D29).
- TS.1, a live Hermes change in default, alex and david: symlinks to Neo's 5 bb skills; `BB_SERVER_URL` in `.env` and `terminal.env_passthrough`; the work-rule guidance in Neo's `dev-setup` (shared). D1's "no config change" covers the transport only.
- A live gateway restart in P1 dogfood (drops every live Hermes session, Discord and Conduit included).
- The first live import; the first live state push to Hermes.
- The worker's unattended Hermes-side actions: the daily `git fetch` in `<hermesRoot>/hermes-agent` (remote refs only) and, from P2, isolated-Hermes canary runs (they share `mlx_main`).
- Deleting ACP probe sessions (after a backup); disabling `acp-hermes-agent`; webui retirement.
- Pushes, tags and live installs.
- The go/no-go after P1 (D34).
- Each approval is logged in `docs/operations.md` §Approvals (date, item, answer); gated tasks check it first. Upkeep goes to §Upkeep: the user's own attention hours apart from agent runs (kill criteria).

## Glossary

| Term | Meaning |
|---|---|
| server part / host worker / bridge | Plugin code in the bb server / a long-lived $HERMES_HOST worker holding one Hermes connection / one $HERMES_HOST process per hosted thread |
| hosted | A thread with a live bridge process; released after 30 min idle |
| canonical | `hermes-gateway-v1` on `/api/ws` (r08 §1) |
| read-only thread | A Discord-bound thread: mirrored, but bb never sends into it (D39) |
| history reader | P2 read-only access to Hermes session history: Hermes' REST projection (`native-http` ticket) first, TS `node:sqlite` on `state.db` as fallback (T2.0b picks) |
| audit / canary | Daily check of Hermes anchors vs bb turns per binding / scripted isolated-Hermes run on each version change, diffing our reader against Hermes' REST projection |
| hidden-prompt turn | A turn whose user row Hermes hides (`display_kind` set), e.g. Conduit's Pulse; muted and auto-read (D26) |
| profile home | Hermes `profile_id` (home path) |
| lineage root | Hermes logical id (`chat_id` owner), stable across compaction. **Tip** = current physical id |
| anchor | `message_uid` of a turn's user message (or first assistant message); the mirror dedupe key |
| legacy session | A pre-migration row (not gateway-owned) that a `session.resume` would adopt |
| binding | Mapping-db row: bb thread ↔ (profile home, lineage root) |
| marker | Agent-only `<hermes-bb>{…}</hermes-bb>` input; never rendered |
| replay / mirror turn | A bb turn rendering past history / an outside turn; never calls `prompt.submit` |
| wake | A server `threads.send(queue-if-active)` that starts a mirror turn |
| outside activity | Turns not started from bb: CLI, TUI, Desktop, Conduit, Discord, subagents |
| Bot Chat | A profile's hidden canonical session titled `Bot Chat`; never imported (D35) |
| tombstone | A row that blocks a session from import |

## Files

| File | Content |
|---|---|
| `01-product.md` | Behaviour by flow (F1–F15), with acceptance criteria |
| `02-architecture.md` | Components, mapping db, contracts, protocol mapping, 13 flows, invariants, security |
| `03-testing.md` | Test layers, strict fake, fixtures, e2e recipe, drift check, dogfood, gates |
| `04-delivery.md` | Layout, phases, 62 tasks, assumptions, release, rollout, rollback, cleanup |
| `05-risks.md` | Risk register; kill criteria; exit cost |
| `scope-reset.md` | D46: proposed lean v1, the Later backlog, S8's shared-conversation rules, open questions Q22–Q25, and what the rewrite changes |

## Plan defaults (reversible)

Q3, Q5, Q6 and Q10–Q17 became decisions (D22–D29, D37–D39); Q2 is superseded by D35. The defaults below were not asked as questions. They were shown to the user on 2026-11-04 ("taking unless you object"), with no objection, and the reviews found them consistent with intent (R2 "checked and fine").

| # | Question | Default (applied) | Alternatives |
|---|---|---|---|
| Q1 | Delete policy | No cross-delete. bb delete → tombstone; a session deleted in Hermes → the bb thread stays, sends fail "Deleted in Hermes" | Mirror deletes |
| Q4 | One thread per Discord conversation across resets? | No: per session | Merge by route |
| Q7 | Imported items show import time | Accept; dated tags `[CLI · Oct 12]`; oldest-first import | — |
| Q8 | Uncommitted hermes-host bb adapter (r04 §5) | The T0.1 lead asks the user before anything touches hermes-host. Recommended: commit it, then delete it at P3 | Delete now |
| Q9 | Project chats share one model list per folder (S7 finding 1) | Accept; unoffered model → profile default + warning | Worktree per chat (Hermes then works in a worktree) |

## User decisions Q18–Q21 (answered: D42–D45)

Answered 2026-11-04; the answers are not yet applied (see Status). The table records what was asked. Open questions are now Q22–Q25 in `scope-reset.md`.

| # | Question | Applied now | R6 recommends |
|---|---|---|---|
| Q18 | Go/no-go metric and P2 shape (R6 C1) | bb-started Hermes messages ≥ ~10/week; then full P2 (D34) | bb's share of the user's typed Hermes messages (≥ 80% in weeks 2–3, dogfood excluded); P2-lite (rail list + Continue in bb, ~4 tasks) unless typed outside messages stay over ~5/week |
| Q19 | TS.1 and its guard (R6 C2) | TS.1 to default, alex and david, guidance only (D37) | Neo only until a guard exists; or `approvals.deny` globs; or a ~20-line `pre_tool_call` approval hook |
| Q20 | Conduit legacy chats: read-only vs adoption (R6 C5) | Adopt on first bb send (D16) | Read-only with Continue in bb, like Discord; drops adoption, A23 and the legacy push skip |
| Q21 | Retire hermes-webui now (R6) | Optional, P3 (T3.7) | Now, after finding what polls `/api/session/status` |

## Review resolution

| Finding | Fixed in, or why not |
|---|---|
| R1 M1, M2 wakes and row ids | 02 `turns` (keyed by `message_uid`; `INSERT OR IGNORE` then send), flow 4; A8; 03 §1 |
| R1 M3, M8, M9 identity, handoff | 02 identity rules; flow 6 (context from the bb timeline, R6 C4; binding state decides); `init` refused unless `pending:` |
| R1 M4, M6 fencing, merged sends | 02 protocol mapping, input parsing; A25; 01 F8; 03 bridge tests |
| R1 M5 mirror never closes | 02 flow 4.3 (no-events mode closes `partial`; rest by re-list) |
| R1 M7 legacy adoption | D16; 02 placement and history rules, flow 3; A23; `importPreview` legacy count |
| R1 M10, S11, S12 bb tools | Moot: no `bb_tools` (D37). Accepted risk 05 R20 |
| R1 S1–S4, S6–S10, S14, S15 | 02 event filter, flow 4, mapping params, `end_reason:null` (A24), `worker_boot_id`, no outbox (push on reconnect), no `running`; A4, A19, A20; 01 F2 |
| R1 S5, S13 bots | Superseded by D35 |
| R1 questions | D37 (bb tools), D27 (Stop), D16 (pre-migration) |
| R2 M1–M4 | D17, D25 (reasoning); 02 mapping, T1.12 (attachments); deny-list, D32; D22, T1.4 (icon) |
| R2 S1–S10, U1–U6 | 01 F1/F2/F5/F6/F10/F13/F14; 02 flows 4, 7, 12; D19, D21, D25, D26, D33, D37; A9, A27 |
| R2 S11 agent sends echoed | Moot: no echo (D39) |
| R3 M1–M4 | D29, D30, D20; 04 release (`@^0`, update), rollback; 03 §5–§8 |
| R3 M5, M6 | Moot: no Hermes plugin (D37) |
| R3 S1–S13, Q1–Q2 | `diagnostics`; flow 3 redo; migrations; 04 work breakdown, runbook, cleanup, T3.6; 03 §5–§9; README approvals |
| R4 M1 work boundary | D28 → guidance only (D37); accepted risk 05 R20 |
| R4 M2 `bb_tools` path | Moot (D37). Drift paths stay under `<hermesRoot>` |
| R4 M3, M4 | 02 history rules (mismatch policy, TS-fallback row rules, author, binding, hashes); `thread/resume` records identity only |
| R4 Hermes host | D30; no $HERMES_HOST in logic |
| R4 S1, S7–S11 | `reply_uids` + `mirror{rest}`; wake atomicity; A38; D32; `rNN` citations; minor fixes |
| R4 S2, S4, S5 | Moot: D35 (no Bot Chat pin), D39 (no echo), D37 (no tool approvals) |
| R4 S3, S6, ambiguities | Approvals list; gold-plating list; A36, D30, D33, A39, `docs/operations.md` §Approvals |
| R5 C1 scope | D34: full plan, go/no-go after P1. Success metric (README Goal); kill criteria and exit cost (05) |
| R5 C2 drift | D20: `contract:check --incoming`, semantic canary (T2.0a), daily `audit` (T2.11); upkeep budget; R27, R28 |
| R5 C3 bb tools boundary | D37: skills + CLI, guidance only (R5 question 2 option "advisory", question 3 option "skills"); accepted risk 05 R20 |
| R5 C4 alternatives | Python reader dropped (R6 C3: wrong interpreter); REST projection first in T2.0b (A36). `bindings.json` gone with D37. Keep D1 and the mirror. Upstream PRs: optional, never depended on |
| R5 C5 hidden writes | D16 extended (no mutations for legacy bindings; A23); D31 removed by D35 |
| R5 C6 test realism | 03 §5 (recorded snapshots; legacy `methods` validated), soak gates, smart-escalated command in P1 dogfood |
| R5 C7 privacy, reads, metric | D36 (every thread); D26 (auto-read); D38 (no read sync); success metric |
| R5 questions 2–5 | 2–3 → D37; 4 → D38 (sync) and D39 (Discord); 5 → D35 |
| R5 decision challenges | Adopted: D7/D15 dispatch hook (T2.10), D8 → D39, D9 → D38, D10/D18/D24 → D37, D17 `auto`, D25 P3 gate, D26, D31, D33. Not adopted: D3 lock/handoff later, D6 defer nesting (D34 keeps scope). Kept: D27, D29, D30, Q-defaults |
| R5 assumptions | A31 rewritten (legacy `commands.catalog`/`slash.exec`); A34, A36, A8 verified; A5 verified no; A23 extended; A35 dropped (D37) |
| R6 C1 go/no-go metric | Pending Q18 |
| R6 C2 D37 guard | Pending Q19. Applied now: R20 and D37 state that smart approvals flag no `bb` command; TS.1 work-rule wording (D28) |
| R6 C3 read path | D40: REST projection first in T2.0b; venv-Python reader dropped; golden files and audit from Hermes' projection; REST key check or schema + table checks (02, 03 §8) |
| R6 C4 no reader before go/no-go | D40: P1 handoff from the bb timeline (02 flow 6); T0.4 and T0.13 → T2.0b and T2.0a; P0 keeps the contract check |
| R6 C5 Conduit legacy stream | Pending Q20 (D16 notes it) |
| R6 C6 Pulse | D26, D33: hidden-prompt turns muted and auto-read; imports never copy the pin |
| R6 C7 privacy list | D36: prefixes `conduit_*`, `mcp__Home_Assistant__*`; `provides_tools` check (test and drift); A40 resolved |
| R6 decisions table | D34, D37, D16 → Q18–Q20; D36, D26/D33, D20 applied; webui → Q21. D38 "move F9 to P3": not taken, D38 is a batch-4 user decision |
| R6 assumptions | Approval timeout 60 s (F8); author: Discord admissions use `native_text_v1` (A4); `schema_version` + per-profile tables (02); voice goes to OpenAI (F2); bot title on `session.create` (F4, flow 8); ACP baseline → Q18 |
| R6 missed | D41 deny-list both columns + circuit breaker (R32); upkeep counts the user's hours (05); update size (R28); golden files: one human check against Desktop (03 §4); webui → Q21; ACP disable at the go/no-go: not taken (no ruling), stays P3 |


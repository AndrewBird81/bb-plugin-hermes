# bb-plugin-hermes — implementation plan

Status: draft for vetting, 2026-11-04. Supersedes `docs/design/00-architecture-draft.md`. Integrates S7 (`docs/spikes/S7-bb-profile-entry-sync.md`, cited `S7 §n`) and H2 (`docs/research/11-hermes-profiles-tools.md`, cited `11 §n`). Nothing is pending. `ASSUMED` items each have a verify step in a phase (04 §Assumptions).

## Goal

Make Hermes Agent a first-class citizen in bb: every Hermes session is a real bb thread, with profiles, bots, live mirroring and two-way sync.

## Scope

In:
- New Hermes chats from bb (profile, optional project, model), with approvals, clarify, interrupt and steer.
- Import of recent interactive and Discord sessions; live mirror of outside activity.
- Bot threads (Hermes, Alex, David, Neo) bound to each profile's `Bot Chat`.
- Discord replies from bb, with echo.
- Two-way pin, archive, rename and read.
- A small Hermes plugin: bb tools (wrapping the `bb` CLI) and the Discord echo hook.
- Settings v1; retirement of `acp-hermes-agent`.

Out:
- Any Hermes config change, network credential or new port; the dashboard (`:9119`/`:8448`).
- Remote transports A/E (documented in S0-S4 as fallbacks).
- Editor-MCP tools (`source:"acp"`): rejected, loses `clarify` (S0-S4 §T3).
- Fork, reasoning-level and service-tier pickers; cron and one-shot import by default; re-importing ACP sessions.
- Hermes off $HERMES_HOST (that machine would become a bb machine).

## Decisions log

All user-confirmed. Source: `00-architecture-draft.md` v2 and `BRIEF.md`, both 2026-11-04.

| # | Decision | Date | Source |
|---|---|---|---|
| D1 | Local architecture: bridge (one process per hosted thread) and host worker on $HERMES_HOST; `~/.hermes/gateway.sock` + `hermes-gateway-v1`. No Hermes config change, credential or port. | 2026-11-04 | 00, S0-S4 §S0 |
| D2 | Every Hermes session is a real bb thread: Hermes icon, pin/archive/rename, no machine or harness picker, hidden from bb's standard picker, works with `bb thread tell/spawn/…`. | 2026-11-04 | 00, BRIEF |
| D3 | Profile chip in every Hermes composer and in New Hermes chat; model list follows the profile; a profile change in a chat with messages hands off to a new chat carrying context. | 2026-11-04 | 00 |
| D4 | Optional project per chat ($HERMES_HOST projects only); imported sessions whose cwd matches a project land there. | 2026-11-04 | 00 |
| D5 | Bots Hermes, Alex, David, Neo: one pinned thread each, bound to the profile's `Bot Chat`; hide `todoist`. | 2026-11-04 | 00, 04 §3 |
| D6 | Import non-empty CLI, TUI, Desktop, Conduit and Discord sessions, last 30 days; subagents nested; one-shots and cron off (toggles). | 2026-11-04 | 00 |
| D7 | Outside activity mirrored live (progress, unread, notifications); outside user messages are the user's bubble with a source tag `[Discord] …`. | 2026-11-04 | 00 |
| D8 | Discord: bb replies post to Discord; the Hermes plugin echoes "$OWNER_NAME (via bb): …" first. | 2026-11-04 | 00, 08 §4 |
| D9 | Two-way sync of pin, archive, rename, read. | 2026-11-04 | 00 |
| D10 | bb tools for Hermes: native tools in a Hermes plugin wrapping the `bb` CLI (spawn, tell, list, read, wait), enabled per profile. | 2026-11-04 | 00, 10 |
| D11 | Hermes approvals and `clarify` become bb interactions. Never auto-approve. | 2026-11-04 | 00, S0-S4 §S4c |
| D12 | Retire `acp-hermes-agent` at parity; its 18 threads stay viewable, read-only; never re-import their sessions. | 2026-11-04 | 00, 09 M6 |
| D13 | Settings v1: connection health; default and hidden profiles; import sources and window; hidden models per profile; default notification level for outside activity. | 2026-11-04 | 00 |
| D14 | Execution by delegated agents: one writer per seam in its own jj workspace; a verification gate per phase; Claude-family subagents in the background. | 2026-11-04 | BRIEF |
| D15 | Tagged outside messages may land in bb prompt history. | 2026-11-04 | user via parent, S7 §8 |

Plan-level choices (not user decisions; reversible):
- Bridge-opened turns (S1-S3 §S2b) are not used: the tagged user bubble (D7) needs a server `threads.send`, so hosted and idle threads share one mirror path.
- The server part is the only writer of bb → Hermes state; the bridge answers `thread/archive` and `thread/name/set` without calling Hermes.
- Hermes sessions for bb chats are created lazily on the first visible message, so an abandoned chat leaves no empty session (09 M6).
- Settings ship with the phase that reads them, not all in the last phase (04).
- "New Hermes chat" opens an empty chat; profile and model are picked in bb's own composer chips (S7 §2). The chip always lists every profile, because a pick is the switch (S7 §1a).
- Model list per thread: `models.scope:"workspace"` plus a bridge-published catalog. No profile-namespaced model ids (S7 §1b–c).
- Navigation from our UI (`useBbNavigate`); server `threads.open` moves every client, phones included, so it is a fallback only (S7 finding 3).
- Bots are pinned; no "Bots" section, because pinned threads always show under "Pinned" (S7 §4).
- Host worker kept alive by a 60 s `ensureWatch`; `experimental_retainWorker()` is untested (S7 §6).

Gold-plating noticed in the decisions (kept, but scheduled so they can be dropped):
- Subagent sub-threads (D6): only 1 subagent session exists (04 §6), and this is the costliest import piece. Last task of P2, droppable.
- Discord echo (D8): feasible via public `pre_llm_call` + `ctx.post_message`, but recognising a bb turn needs one private contextvar (11 §4). Droppable if it proves brittle.

Approvals needed at execution time (not plan questions):
- `plugins.enabled += bb_tools` in default, alex, david and neo: a Hermes config change (11 §5). D1's "no config change" covers the transport only; D8 and D10 need this.
- The first live import run (after `importPreview` counts).
- Any live Discord test (throwaway thread or test bot).
- Deleting the 137 empty ACP probe sessions and the spike leftover.
- Disabling `acp-hermes-agent`; pushes, tags and live installs.

## Glossary

| Term | Meaning |
|---|---|
| server part | Plugin code in the bb server ($BB_SERVER_HOST): mapping db, sync, settings, RPC. |
| host worker | Plugin `bb.host` worker on $HERMES_HOST: one long-lived Hermes connection for listing, reading and mutating. |
| bridge | Provider bridge process on $HERMES_HOST, one per hosted bb thread (S1-S3 fact 2). |
| hosted | A bb thread with a live bridge process; released after 30 min idle (07 §3). |
| canonical | The Hermes gateway protocol `hermes-gateway-v1` on `/api/ws` (08 §1). |
| profile home | Hermes `profile_id`, the profile's home path (`~/.hermes`, `~/.hermes/profiles/<name>`). |
| lineage root | Hermes logical id (`chat_id` owner), stable across compaction (11 §3). **Tip** = current physical session id. |
| binding | Mapping-db row: bb thread ↔ (profile home, lineage root). |
| marker | Agent-only JSON input `<hermes-bb>{…}</hermes-bb>`; never rendered (07 §2). |
| replay turn | bb turn that renders past Hermes history; never calls Hermes `prompt.submit`. |
| mirror turn | bb turn that renders an outside Hermes turn. |
| wake | Server `threads.send(queue-if-active)` that starts a mirror turn (S1-S3 §S2a). |
| outside activity | Hermes turns not started by bb: CLI, TUI, Desktop, Conduit, Discord, subagents. |
| source tag | Prefix on an outside user line, e.g. `[Discord] `. |
| Bot Chat | A profile's hidden canonical session titled `Bot Chat` (04 §3). |
| handoff | A profile change that opens a new chat carrying the old chat's context. |
| tombstone | Mapping-db row that blocks a session from ever being imported. |

## Files

| File | Content |
|---|---|
| `01-product.md` | User-facing behaviour by flow, with acceptance criteria |
| `02-architecture.md` | Components, mapping db, contracts, protocol mapping, sequence flows, invariants, security |
| `03-testing.md` | Test layers, fake Hermes, e2e recipe, drift check, dogfood checklist, phase gates |
| `04-delivery.md` | Repo layout, phases, work breakdown, dev loop, release, rollout, rollback, cleanup |
| `05-risks.md` | Risk register |

## Open questions for the user

Recommended answer first. Q2, Q3 and Q10 are conflicts between decisions and verified evidence.

| # | Question | Recommended answer |
|---|---|---|
| Q1 | Delete policy (01 F9)? | No cross-delete. bb delete removes the thread, keeps the Hermes session and tombstones it. Hermes delete archives the bb thread, labels it "Deleted in Hermes" and refuses sends. |
| Q2 | Bot threads vs two-way rename/archive (D9)? Bot Mode finds the Bot Chat by its exact, unique title `Bot Chat` (04 §3), so a synced rename would break Bot Mode, Conduit and Desktop. | Exempt bot threads from rename and archive sync. Pin and read still sync. |
| Q3 | A bb reply in a Discord session after its daily 04:00 / 24 h reset (04 §2) runs detached and reaches only viewers, not Discord (08 §4). D8 can't hold there. | The reply stays in bb/Hermes, with a notice "Not posted to Discord: this conversation rolled over". No rerouting. |
| Q4 | One bb thread per Discord conversation across resets? | No. One thread per Hermes session (lineage). Low volume: ~8 Discord sessions per 30 days (04 §6). |
| Q5 | Should bb tools ask for approval in Discord-origin sessions (any allowed Discord user could drive bb)? | Yes for `bb_thread_spawn` and `bb_thread_tell` in Discord-origin sessions; never for list/read/wait. |
| Q6 | ACP parity scope: ACP has fork, reasoning levels, service tiers and Hermes slash commands (01 §6); v1 has none. | Not needed for retirement. Reasoning is the cheapest to add later (`model.options` capabilities, 11 §1). |
| Q7 | Imported threads show the import time, and sidebar order is import order (S1-S3 §S1b). Accept? | Accept; import oldest first so the newest lands on top. |
| Q8 | The uncommitted hermes-host bb-adapter work (`bin/hermes-bb-acp`, `config/bb-models.json`; 04 §5)? | Commit it in hermes-host now; delete it at ACP retirement (P6). |
| Q9 | Project chats share one model list per project folder (S7 finding 1). With Hermes chats on two profiles in one project, the picker can show the other profile's models until the next turn. | Accept, with the mitigation: the bridge maps an unoffered model to the profile default and says so. Alternative: a git-worktree environment per chat (own list), but then Hermes works in a worktree, not the project folder (S7 §5). |
| Q10 | D2 asks for a Hermes icon, but hidden providers get no sidebar glyph, and per-thread icons don't exist (S7 §4). Showing the glyph (health `ready`) also puts Hermes in bb's New Thread picker. | Keep Hermes hidden; no row glyph. Hermes shows via the rail icon, the Profile chip and titles. |

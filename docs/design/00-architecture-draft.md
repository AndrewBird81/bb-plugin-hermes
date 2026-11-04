# bb-plugin-hermes — architecture draft (v2, 2026-11-04)

Status: planning. Evidence: `docs/research/01..11`, `docs/spikes/`. The full plan will live in `docs/plan/` and supersede this file.

## Decisions (user)

- **Architecture: Local.**
  - The harness (one bridge process per hosted thread) and the sync watcher run on $HERMES_HOST under bb's host daemon.
  - They reach the gateway through `~/.hermes/gateway.sock`: host-scoped ticket, then `/api/ws` (`hermes-gateway-v1`). Evidence: `docs/spikes/S0-S4-hermes.md`.
  - No Hermes config change, restart, network credential or new tailnet port. The dashboard stays, for Conduit only.
  - If Hermes ever moves, that machine becomes a bb machine. Remote (E) stays documented in S0-S4 as the fallback.
- **Profile picker in the Hermes harness:**
  - A Profile chip in every Hermes chat's composer, next to the model picker, plus one in "New Hermes chat".
  - The model list follows the profile.
  - Mid-chat switching behavior is pending (the user is being asked).
- **Bots:**
  - Hermes Bot Mode bots: Hermes, Alex, David, Neo.
  - One pinned bb thread each, bound to that profile's canonical `Bot Chat`, which Conduit and Desktop also use.
  - The stale `todoist` profile is hidden.
- **Import:** non-empty interactive chats (CLI, TUI, Desktop, Conduit) and Discord conversations, first import covering the last 30 days.
  - Subagents are nested in their parent thread.
  - One-shots are off (settings toggle).
  - Cron runs are off.
- **External activity:** mirrored live into the bb thread, with progress, unread and normal notifications.
- **Discord replies:** same conversation.
  - A reply from bb is delivered to Discord (08 §4). The user's own text is not echoed; whether to fix that is pending.
- **State sync:** two-way for pin, archive, rename and read.
- **ACP harness:**
  - Retire `acp-hermes-agent` once at parity. Its 18 threads stay viewable and become read-only.
  - Never re-import their sessions.
- **bb tools for Hermes:** native tools in a small Hermes plugin that wrap the `bb` CLI: spawn, tell, list, read, wait.
  - They work in every session of each enabled profile.
  - The editor-MCP route is dropped: it loses `clarify`, and it only covers sessions bb creates (S0-S4 T3).
- **Spikes:** may touch live bb and Hermes. A live gateway restart is OK at any time.

## Fixed by evidence

- **bb provider bridge** (01, 07, S1-S3):
  - Runs in the host daemon, **one process per hosted thread**. `bb plugin reload` does not update running bridge processes.
  - Hidden from the standard picker by `experimental_visibility: "installed"` plus health `not_installed`. Plugin-spawned threads keep their follow-ups and the model picker.
  - Import: replay each past turn as a real turn (visible user text plus an agent-only replay marker). Announce `thread/identity` only after the first turn ends.
  - Wake: send an agent-only marker with `queue-if-active`. A bridge-opened turn works on an already-hosted thread.
  - User input during a mirror turn arrives as `turn/steer`; map it to `prompt.submit` (queue).
  - Renames reach the bridge only while the thread is hosted, prefixed `"[bb] "`. The server syncs renames.
  - bb accepts a duplicate session binding and fails later, so dedupe in the mapping db before spawning.
  - `markRead` and `threadNotifications.set` work; host concurrency limit on $HERMES_HOST is 18.
- **Hermes canonical `hermes-gateway-v1`** (08, S0-S4 cheat-sheet):
  - Pass tickets as the subprotocol.
  - `prompt.submit` always queues.
  - `session.mutate` handles rename, archive, sidebar and delete; delete needs `expected_generation`.
  - Fences: `stale_generation`, `revision_conflict`.
  - Replay with `session.events.since`, deduped by `(replay_epoch, seq)`.
  - `sessions.changed` is a bare "re-list" signal.
- bb-created session ids are deterministic from `request_id = "bb:<threadId>"`. This is the dedupe tag for the feed.
- **Never** call `connect_gateway()` without an endpoint. Never auto-approve anything.
- **Dedupe rules** (09 M6):
  - Never import empty sessions.
  - Recognise bb-created sessions by their deterministic id.
  - Skip sessions linked to existing ACP threads.
  - Key on the profile's database location.
  - Take lineage from the compression chain.

## Components

- **bb server part:** sync service, mapping db, bots, settings, "New Hermes chat" UI with profile picker.
- **Host worker on $HERMES_HOST:** watches Hermes (`sessions.changed`, listing) and signals the server. The channel is being verified in S7.
- **Bridge on $HERMES_HOST (per thread):** canonical client; turns → `prompt.submit`; events → deltas; approvals and clarify → bb interactions; import and mirror turns.
- **`hermes-plugin/`** (Python, small):
  - native bb tools wrapping the `bb` CLI;
  - a Discord echo hook, if approved.

## Spikes

- Done:
  - S1-S3 bb mechanics (`docs/spikes/S1-S3-bb-mechanics.md`);
  - S0/S4 Hermes client and transports (`docs/spikes/S0-S4-hermes.md`).
- Running:
  - S7, bb side: profile and model picker, chat entry points, project-bound chats, the sync channel, redeploy.
  - H2, Hermes side: per-profile models, bot metadata, Bot Chat rotation, Discord echo, bb-tools plugin, cwd, handoff.

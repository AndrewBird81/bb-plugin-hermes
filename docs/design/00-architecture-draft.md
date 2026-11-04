# bb-plugin-hermes — architecture draft (v1, 2026-11-04)

Status: feasibility. Evidence: `docs/research/01..10`. Review: `09`. Decisions below are the user's answers from 2026-11-04.

## Decisions (user)

- **Bots:**
  - Hermes Bot Mode bots (Hermes, Alex, David, Neo).
  - One pinned bb thread each, bound to that profile's canonical `Bot Chat`, shared with Conduit and Desktop.
  - The stale `todoist` profile is hidden.
- **Import:** non-empty interactive chats (CLI, TUI, Desktop, Conduit) and Discord conversations, first import covering the last 30 days.
  - Subagents render nested: a live delegation item in the parent, openable as a bb sub-thread.
  - One-shots are off (settings toggle).
  - Cron is off.
- **External activity:** mirrored live into the bb thread, with progress, unread and normal notifications.
- **Discord replies:** same conversation. A viewer reply is delivered to Discord (08 §4); the user's own text is not echoed, which needs a UX decision. Verify with the user against a throwaway Discord thread.
- **State sync:** two-way for pin, archive, rename and read.
- **ACP harness:** retire `acp-hermes-agent` once at parity. Keep its 18 threads; never re-import their sessions.
- **bb tools:** full bridging (10).
  - (a) The `bb` CLI, thread identity and bb skills, available to Hermes in every bound session.
  - (b) bb's injected tools via an editor MCP overlay served by the bridge. This works only for sessions bb creates, which need `source=acp` (to verify).
  - Python plugin tools are needed only if imported sessions (Bot Chats, Discord, Conduit) must also get injected tools. That is still the user's call.
- **Spikes:** live bb and Hermes allowed. A live gateway restart is OK at any time.

## Fixed by evidence

- **bb provider bridge** (01, 07):
  - Runs in a host daemon.
  - Hide it from the standard picker with `experimental_visibility: "installed"` plus health `not_installed`. Plugin-spawned threads still work.
  - Binding and wake both use an `agent-only` input: invisible in the timeline, prompt history and search, but delivered to the bridge in `turn/start`.
  - The bridge can open turns only on threads it currently hosts. Hosting happens only through a turn.
  - Idle release default is 30 min, and is skipped while a `backgroundTask` item is open.
  - Per-thread notification level is set via the push-notifications RPC `threadNotifications.set`; `markRead` exists.
  - Host concurrency limits: $HERMES_HOST 18, $BB_SERVER_HOST 4.
- **Rendering risk:** `input.provider` user lines render as "BB · System Message" cards. S1 compares that with replaying history as real turns (visible user text plus an agent-only replay marker).
- **Hermes canonical `hermes-gateway-v1`** (08 §1): see the cheat-sheet there. Points that matter:
  - `prompt.submit` always queues; steer and interrupt are separate calls.
  - The socket must `session.resume` or `session.create` before it can submit.
  - `session.mutate{rename|archive|sidebar}` for state sync.
  - A host-scoped ticket lets one socket address every profile.
  - Events carry `seq`/`replay_epoch`; `session.events.since` handles gap replay.
- **Never** call `connect_gateway()` without an endpoint (it can start a gateway). Discovery only, via the `owner_forward` pattern.
- **Plugin WebSockets in the dashboard bypass auth middleware:** every socket must call `_ws_auth_ok` and fail closed. bb gets a ticket from `POST /api/auth/ws-ticket` (Bearer), then `?ticket=`.
- **Bot Chats:** all 5 are gateway-adopted. Conduit writes through the legacy dashboard `/api/ws`, so bb sees Conduit's turns as transcript updates rather than live streams.
- **Dedupe rules** (09 M6):
  - Never import empty sessions.
  - Never re-import sessions bb created (tag them at `session.create`, and import only after the bridge has announced its identity).
  - Skip `created_source=acp` sessions linked to existing ACP threads.
  - Key on the profile's database location, never on `profile_name`.
  - Lineage comes from Hermes' compression chain, never from `parent_session_id`.

## Open: transport (S0 decides, user answer pending)

| Option | Path | For | Against |
|---|---|---|---|
| E | Gateway webapp listener (fixed port) serves the dashboard app with session authority; bridge anywhere | No relay; our plugin runs in-process with Hermes tools (easy tool bridging); one process could serve Conduit too (trims the stack) | One gateway restart; webapp sign-in issues its own tokens (static bearer refused, 08 §2); new tailnet port |
| A | Standalone dashboard plus our relay plugin (`owner_forward`) | No restart; hot-mount | Relay code on private APIs; shares Conduit's event loop; tool calls need an IPC hop to the gateway; plugin updates restart the dashboard |
| B | Bridge on $HERMES_HOST, direct to `gateway.sock` | Simplest; no token on the network | Tied to Hermes being on a bb machine; ignores the dashboard |

The bridge code is identical across all three; only the connector differs (S0).

## Components

- `server.ts` (bb server):
  - sync service (feed or polling → threads; dedupe; two-way state)
  - mapping db (`profile-home`, `lineage-root` → threadId, cursor)
  - bots
  - settings
  - our new-chat UI (`homepageSection`/`navPanel`) with the profile picker
- `host.ts` provider bridge:
  - canonical client
  - turn/start → `prompt.submit`
  - events → deltas
  - approvals and clarify → interactions
  - import and mirror turns
  - tool bridging
- `hermes-plugin/bb_bridge` (Python, as small as possible):
  - bb tool registration and callback
  - change feed if needed
  - relay only for option A

## Spikes (bb sub-threads)

- **S-bb** (`docs/spikes/brief-bb-mechanics.md`): S1 import, S2 mirror, S3 UX, all against an isolated local bb and a fake Hermes.
- **S-hermes** (`docs/spikes/brief-hermes-client.md`): TypeScript canonical client plus S4 against live Hermes, and S0 transports. Option E is tested on an isolated Hermes home, so the live gateway is never restarted.
- **Later:** S5 resilience, S6 tool bridging, integration.

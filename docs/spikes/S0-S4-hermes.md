# S0–S4 (+T1, T3): Hermes canonical client and transports

Run 2026-11-04 against live Hermes `c314285f07` (authority epoch 30) and an isolated copy. Client: `src/hermes/` (TypeScript, no bb deps, Node ≥ 22 global `WebSocket`). **V** = observed live, **C** = code read only.

## Summary

- The TS client works end to end on all three transports, unchanged; only the connector differs (34 lines).
- **Recommendation: B** if the bridge runs on $HERMES_HOST. **E** if it must run off-host or needs in-process Python tools. **A** last.
- Material protocol corrections to 08 (see cheat-sheet). The two that bite:
  - Pass tickets as the `hermes-gateway-ticket.<t>` subprotocol, never `?ticket=`.
  - `session.mutate delete` needs `expected_generation`.
- bb-created sessions can be tagged for free: their session id is deterministic from `request_id`.
- T1: editor MCP over canonical `session.create{source:"acp"}` works, and the timeout is not 30 s.
- T3: `source:"acp"` **removes the `clarify` tool**. This breaks 10's "map Hermes clarify to a bb question" plan for bb-created sessions.
- Budget: 8 live prompts plus 1 on the isolated instance. No restart, no Discord. Live config was restored byte-identical.

## Experiments

### S4a: local connector (VERIFIED)
- Steps:
  1. `identify` on `~/.hermes/gateway.sock` → `api_origin http://127.0.0.1:58355`, `served_profiles[{home, profile_id}]` ×5.
  2. `session-ticket{scope:"host"}`.
  3. Dial `/api/ws`.
  4. `runtime.describe` + `profiles.list`.
- Timings: discover + mint 4 ms; open → `gateway.ready` 15 ms; describe 3 ms.
- `profiles.list`: each profile's `canonical_session` is its Bot Chat (`title:"Bot Chat"`, e.g. alex `$HERMES_SESSION_20`).
- One host-scoped socket answers `profile:"alex"` / `"neo"`.
- Gotchas:
  - `session.list{title:"Bot Chat"}` reports `running:true` while idle. That field means "mounted in the authority", not "executing".
  - `control.ts` doesn't implement the `gateway.sock.path` pointer fallback (C, `gateway_runtime_discovery.py:143-171`). Add it before shipping.

### S4b: create + submit + stream (VERIFIED)
- `session.create{profile:"default", source:"cli", model:"mlx_main", provider:"mlx-main", title, request_id}`.
  - Stored as `source=local, created_source=cli, user_id=uid:501`.
- **Tag for dedupe:** the session id is `local-` + sha256(json([profile_id, "uid:<uid>", request_id])) (C `hermes_state_keys.py:71`; V: matched).
  - bb can use `request_id = "bb:<threadId>"` and recognise its own rows in the feed without a lookup. Retries are idempotent.
  - No free-form tag field exists. Other options: `source:"tool"` (hidden from human pickers, C) or a title.
- Admission answer: `{status:"queued", execution_generation:null}` in 3 ms.
  - Event order: `session.info` → `message.start{}` → `agent.step` → `thinking.delta` → `message.delta` → `session.usage` → `session.info` → `message.complete{text, status:"complete", outcome:"completed", persisted_turn}`.
  - First delta 4.5 s (cold oMLX); later turns ~0.6 s.
- Fixture: `fixtures/s4b-create-submit-stream.json`.

### S4c: approval and clarify (VERIFIED)
- **Edit approval, live** (smart mode, ACP session; T1 run): `approval.request{kind:"approval", choices:["once","deny"], edit:{tool_name, path, new_text…}, timeout_s:60}`.
  - `approval.respond once` → `resolved` → `approval.settled`.
  - A second respond → `already_resolved`.
- **Command approval, isolated E** (`approvals.mode: manual`): `rm -rf` gave `choices:["once","deny","session","always"], timeout_s:300, description:"delete in root path"`.
- **Clarify, live:** `clarify.request{question, choices, multi_select:false, timeout_s:600}` → `clarify.respond{answer:"blue"}` → `clarify.settled`. The model's reply used the answer.
- **Incident:** the E prompt's trailing period became a literal `.` argument (`rm -rf <target> .`, cwd `/private/tmp/bb-spike`), and my script auto-approved it.
  - `rm` refused `.`; only the target dir was removed (V: listing intact).
  - Lessons: the bridge must never auto-approve, and test prompts should quote commands.

### S4d: steer and interrupt (VERIFIED)
- `execution_generation` arrives on events (`message.start` onward), not in the admission answer.
- `session.steer` while running → `{status:"queued"}`.
- `session.steer` while idle → error `stale_generation`, not `rejected`.
- `session.interrupt` with gen−1 → `stale_generation`.
- `session.interrupt` with the current gen → handle `execution_state:"running"`, then `message.complete{status:"interrupted", outcome:"cancelled"}` 271 ms later.
- Interrupt again after settling → no error, `execution_state:"idle"` (idempotent).
- Unknown: what happens to a steer queued before an interrupt (it did not appear in the reply).

### S4e: drop mid-turn, reconnect, replay (VERIFIED)
- Run 1: the turn ended during a 3 s gap. `session.events.since` replayed 10 events including `message.complete`; 0 duplicates.
- Run 2: dropped at seq 82 with the turn still running.
  1. New ticket and socket.
  2. `events.since(82)` returned 83–89.
  3. `session.resume{omit_messages}` (snapshot `last_sequence 90`).
  4. Live frames resumed from 90 up to 162.
- Result: 0 duplicates, 0 seq gaps, streamed text == `message.complete` text (5,488 chars). Reattach took 119 ms.
- Dedupe rule holds: drop if `replay_epoch == cursor.epoch && seq <= cursor.last`.
- `events.since` arms the owner's replay cursor (C `session_controls.py:739-751`). The following `resume` re-sends nothing already replayed, but pushes frames past the cursor *ahead of* its answer. The client must therefore dedupe before the resume answer lands; `HermesClient.reattach` does.

### S4f: viewers and `sessions.changed` (VERIFIED)
- On one host socket, two viewer resumes (`omit_messages`):
  - a real Desktop chat (`$HERMES_SESSION_38`, `info.source:"gui"`);
  - alex's Bot Chat (`profile:"alex"`).
  - Both detached afterwards. No prompts were sent.
- `sessions.changed` reached the viewer socket when **another socket** renamed or pinned a spike session.
  - Empty payload, no `session_id`/`seq`, coalesced.
  - Source (C): a host-wide DB-signature watcher over every served profile, checked every 0.5 s with a 2 s floor (`tui_gateway/change_watcher.py:381,395`).
  - So it also fires for Discord, cron and Conduit writes (C/I, not observed).
- Feed design: on `sessions.changed`, re-list. There is no per-session delta.

### S4g: mutate + REST read-back (VERIFIED)
- `session.mutate rename{title}` → revision 6. `sidebar{pinned:true, unread:true}` → revision 7.
- Results echo the fields plus `execution_generation`.
- Stale `expected_revision` → `revision_conflict` with fresh `{revision, execution_generation}` in `data` (retry without a re-read).
- REST detail: `pinned:1`, `last_read_at:0`. REST list: `pinned:true`, `unread:true`.
- **`delete` needs `expected_generation`**; without it the refusal is a bare `invalid_params`.

### T1: editor MCP over canonical (VERIFIED)
- `session.create{source:"acp", editor:{mcp_servers:[{type:"http", name:"bb", url:<loopback>, headers:[{name:"Authorization", value:"Bearer …"}]}]}}` was accepted from a plain canonical client.
- Discovery:
  - Hermes' MCP client (`protocolVersion 2025-11-25`, Streamable HTTP, JSON responses OK) ran `initialize` + `tools/list` eagerly at create.
  - It re-listed at turn admission.
  - It sent the Authorization header every time.
- Tools appear as `mcp__editor_bb_aff02c40__echo` (toolset `mcp-editor_bb_aff02c40`). They are not in the create snapshot's `info.tools`.
- Round trip: `echo` → `echo: hi`. Calls carry `_meta.progressToken`.
- **Timeout:** a 40 s `sleep` call returned normally, so the effective timeout is not 30 s.
  - C: `_resolve_tool_timeout` ignores the `tool_timeout` key the editor config sets, so the effective value is 300 s.
  - Not measured to the limit.
- Fixture: `fixtures/t1-s4c-acp-editor-mcp-approval.json`.

### T3: what `source:"acp"` changes (VERIFIED unless marked)
- **Toolsets:** `hermes-acp`. Versus `cli` it drops **`clarify`**, `cronjob`, `computer_use`, `image_gen` and `tts` (C `toolsets.py:188-192`).
  - **No `clarify` means no native question path** for bb-created ACP sessions. 10's plan to map Hermes clarify to a bb user question needs a non-acp session, or bb's own `AskUserQuestion` over editor MCP (whose waits hit the ~300 s ceiling).
- **Edit policy:** forced `ask`. Every `write_file`/patch asks `once|deny` with a 60 s timeout.
  - C: relax per session with `session.mutate edit_policy{policy:"workspace_session"|"session"}` (needs `expected_generation`; not run).
- **Lifecycle:** stored `source=local, created_source=acp`. Ended `acp_disconnect` the moment the last viewer left.
  - Correction to 10 ("never end"): under the gateway, the owner ends it. The next prompt reopens it (C).
- **Visibility:** dashboard REST lists it normally (title, `created_source:acp`). Conduit/Desktop not checked.
- **Dedupe:** `created_source=acp` collides with 09-M6's "skip ACP twins" rule. Key on the deterministic id instead.

## S0: transports

| | B: local `gateway.sock` | E: gateway Webapp listener | A: dashboard relay plugin |
|---|---|---|---|
| Result | VERIFIED live | VERIFIED isolated (`/private/tmp`, :9141, gated) | VERIFIED live, tailnet `:8448` |
| Connect | discover + mint 3.6 ms; open → ready 15.6 ms | native sign-in 27 ms (once); ws-ticket 5 ms; open → ready 3 ms | ws-ticket 4 ms; open → ready 26 ms |
| RPC RTT (median) | 1.7 ms | 0.6 ms (loopback) | 3 ms ($HERMES_HOST → own tailnet name) |
| One turn | ack 3 ms | ack 7 ms; 15 s with approval | ack 7 ms; first delta 632 ms |
| Reconnect + reattach | 91 ms | 90 ms | 145 ms |
| Bridge code | client 274 + control 96 + dial 10 | client + `ticketDial` + `webapp-auth.ts` 44 | client + `ticketDial` + **Python relay 93** |
| Private Hermes symbols | none (wire protocols only) | none for transport | `_ws_auth_ok`, `_ws_request_is_allowed`, `gateway_client._session_ticket`, `gateway_ws_target`, `owner_forward.discover_owner` |
| Credential | same-UID unix peer; no network secret | basic-auth password once, then 12 h access + 30 d refresh token; static token **refused** | static dashboard token (root-equivalent) |
| Live cost | none | `webapp:` config block + **gateway restart** (fixed port, new tailnet port) | `plugins.enabled` + hot-mount; plugin code change = **dashboard restart** (drops Conduit legacy chats) |
| Breaks on `hermes update` if… | control verbs/fields (`identify`, `session-ticket`, protocol 1) or `hermes-gateway-v1` change; port changes every restart (rediscover per connect, cheap) | `/auth/native/*`, `/api/auth/ws-ticket` or the webapp gate changes; plugins re-imported only at gateway start | any of the 5 private symbols, plugin mount/consent rules, `websockets` API; shares Conduit's dashboard event loop |
| Off-host bridge | no | yes | yes |

**Ranked:**
1. **B**: bridge on $HERMES_HOST (09 M3). Zero Python, no network credential, fastest, smallest surface.
2. **E**: needed for a bridge on $BB_SERVER_HOST, or for tool-bridging B2, because plugin routes run **in the gateway process** next to the authority (V: same pid, `session_authority` and `_ACTIVE_RUNNER` set). Costs one gateway restart plus a sign-in credential.
3. **A**: works today without a restart, but is private-API Python on Conduit's loop, and its plugin updates restart the dashboard. Keep only as a fallback.

### A details (VERIFIED)
- Hot-mount on the first HTTP GET, no restart. `/health` returns 401 without auth and 200 with Bearer, on loopback and `:8448`.
- Upgrade matrix on `/api/plugins/bb_bridge/ws`:
  - Rejected with HTTP 403: no credential, bogus ticket, replayed ticket, Bearer header only, `Origin: evil`.
  - Accepted: a fresh ticket, and **`?token=<static token>`**. `_ws_auth_ok` accepts it, so a URL holding the root token opens the relay. Clients must use tickets.
- Gotcha: closing before `accept()` surfaces as HTTP 403, not 4401.
- The A turn ran with `?ticket=`; the relay accepts with the subprotocol explicitly. The subprotocol-ticket form that `ticketDial` now uses was verified on E only; on A it is C (`_ws_auth_ok` reads it first).

### E details (VERIFIED on the isolated instance)
- Static `HERMES_DASHBOARD_SESSION_TOKEN` is refused:
  - 401 on REST, `/api/auth/ws-ticket` and plugin routes;
  - 403 on `/api/ws`.
- Headless RFC 8252 flow with the `basic` provider (`webapp-auth.ts`):
  1. `GET /auth/native/authorize` (PKCE, loopback `redirect_uri` that is never dialed);
  2. `POST /auth/password-login` with the PKCE cookie → `next` carries `code`;
  3. `POST /auth/native/token`.
- Tokens: the access token lasts 12 h. `/auth/native/refresh` issues a new refresh token, but **the old one still works** (the basic provider's tokens are stateless HMAC).
- Tickets for `/api/ws`: `/api/auth/ws-ticket` (Bearer access token) and `/api/webapp/socket-ticket?socket=gateway` both work. `gateway.ready.session_authority:true` confirms canonical.
- The relay plugin on the Webapp also works. Its `plugin_api.py` is imported at **gateway start**: a code change needed an isolated gateway restart to take effect.
- A fresh `HERMES_HOME` bootstraps its own Python runtime under the home: ~20 s, 1.1 GB. The shared venv was untouched (V).

## Protocol cheat-sheet as observed (corrections and additions to 08)

1. **Tickets on `/api/ws` and plugin sockets:** offer `["hermes-gateway-v1", "hermes-gateway-ticket.<t>"]`.
   - With `?ticket=` the server accepts but selects **no** subprotocol, so any client that offered one fails the handshake.
   - Dashboard tickets work in the subprotocol slot too (C `web_server_chat.py:385-418`).
2. `gateway.ready` payload: `{skin, change_events:true, heartbeat:true, replay_epoch, session_authority}`.
3. `prompt.submit` → `AdmissionStatus{status:"queued", execution_generation:null}`. The generation first appears on `message.start`.
4. `session.mutate` and `clarify.respond` accept `profile` on a host socket. It is stripped (`_PROFILE_IMPLICIT`), even though their contracts omit it.
5. `session.mutate delete` requires `expected_generation`.
6. Fences:
   - `steer`/`interrupt`/`approval.respond` with a stale gen → `stale_generation`;
   - `steer` while idle → `stale_generation`;
   - `interrupt` after settle → idle handle (no error);
   - a duplicate `approval.respond` → `already_resolved`.
7. Event types 08 lacks:
   - `agent.step{iteration}`;
   - `platforms.changed` (signal, no seq);
   - `thinking.delta`, which carries spinner text (`(⌐■_■) contemplating...`), not reasoning (that is `reasoning.delta`);
   - a `tool_call` meta-tool that batches calls;
   - `tool.start`/`tool.complete`, which also carry `tool_call_id` and `tool_name`.
8. `message.complete.payload`: `{text, content, admission_id, outcome:"completed"|"cancelled", status:"complete"|"interrupted", reasoning, usage, persisted_turn}`. `message.start.payload` is `{}`.
9. `sessions.changed` / `platforms.changed`:
   - no `session_id`, no `seq`;
   - broadcast to every socket;
   - never deduped or replayed.
10. Prompt timeouts:
    - edit approval: 60 s, `once|deny`;
    - command approval (manual): 300 s, `once|deny|session|always`;
    - clarify: 600 s.
11. `session.resume` of a Desktop row reports `info.source:"gui"`. REST says `source:"desktop"`.
12. Session ids are deterministic per `(profile_id, subject, request_id)` (S4b).

## Gotchas for the bridge

- Node's global WebSocket sends no `Origin`, so it passes the gateway's 4403 check. The `ws` package needs an `error` listener, or a refused upgrade throws.
- On reconnect, dedupe before `session.resume` answers: the owner pushes frames ahead of it.
- Re-list on `sessions.changed`, debounced, across all profiles. It is the only "something changed" signal.
- Never auto-approve. Tests should target quoted, throwaway paths.

## Live footprint and cleanup

- Spike sessions created in `default`, then deleted via `session.mutate delete`. REST returns 404 for both:
  - `local-c43f108fd1d85c069fa661c0ef10dd598d4d0b7c9bab4e07c04e3e9310b68af1` (S4b; also used for clarify, steer/interrupt, reconnect and A).
  - `local-7ceae6cf14e92eba1a95a9341fc48050985e88ccbffee9c526ce3a844222b177` (T1, `source:acp`).
- Isolated: `local-678e9025d088ff56b93d8d339b63bb342f9eeeb6ccc7cc808a1428d4046baa5a`, destroyed with `/private/tmp/hermes-spike`.
- Viewer-only resumes, detached, no writes: `$HERMES_SESSION_38` (default, Desktop) and `$HERMES_SESSION_20` (alex Bot Chat).
- `plugins.enabled`:
  - `bb_bridge` was added, then removed 16 min later. `~/.hermes/config.yaml` is byte-identical to the pre-spike copy (`cmp`).
  - The `~/.hermes/plugins/bb_bridge` symlink was removed; the route now returns 404.
  - The live dashboard keeps the module in memory until its next restart, but its gate refuses it.
- No gateway or dashboard restart. Host-wide lock dir unchanged. Live gateway instance unchanged before and after.
- Not mine: a `source=acp` empty session `local-a6fec510…` (cwd `~/.bb-spike/provider-maintenance-workspace`), probably the S-bb spike's ACP probe. It is an instance of 09-M6's empty-probe problem. Left in place.

## Open

- `gateway.sock.path` pointer fallback in `control.ts`.
- What happens to a steer queued before an interrupt.
- The upper bound of the editor MCP tool timeout, and whether progress notifications extend it.
- Cross-profile `sessions.changed` and Discord/cron writes (inferred from code).
- Conduit legacy co-writing of Bot Chats.
- Discord delivery. All untested.
- Decision for the user/parent: if bb-created sessions use `source:"acp"` for tools, they lose `clarify`. Alternatives:
  - `cli`/`gui` sessions plus B2 plugin tools;
  - accept bb's AskUserQuestion with a ≤ 300 s ceiling.

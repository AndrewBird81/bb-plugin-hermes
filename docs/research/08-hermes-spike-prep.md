## Key answers

Ground truth: `~/.hermes/hermes-agent` @ `c314285f07` (`v0.22.6+canary.20261103T064339Z-14-gc314285f07`, 2026-11-03); Conduit plugin `~/.hermes/plugins/conduit_push` v0.126.2. Read-only investigation on 2026-11-04: no WebSocket upgrades, no writes, no prompts sent, nothing started. Secrets are reported only as present/absent.
Labels: **V** = VERIFIED (I read the code, ran a GET, or read a log/DB row), **I** = INFERRED.

1. **Cheat-sheet** (§1)
   - V: The canonical contract is `x-canonical-methods` (48 entries) in `apps/shared/src/gateway-contract.openrpc.json`, dispatched by `gateway/session_controls.py:216-330`.
   - V: The wire event is the JSON-RPC notification `{"method":"event","params":{type,session_id,payload,seq,replay_epoch,…}}`.
   - V: `session.title` and `session.archive` are **legacy-only**. On the canonical socket they become `session.mutate{operation:"rename"|"archive"|"sidebar"}`.
   - V, correction to 03: canonical `prompt.submit` **always admits with intent `queue`** (`session_controls.py:833`); `busy_input_mode` does not apply. Interrupting or steering is a separate, explicit call.
2. **Dashboard plugin → canonical gateway**
   - V: Copy the in-tree pattern: `discover_gateway_endpoint(home)` (discovery only), then a ticket from `<root>/gateway.sock`, then the WS. `tui_gateway/owner_forward.py:69-91` and Conduit `bot_chat_adopt.py:140-178` already do this.
   - Do **not** call `connect_gateway()` without an endpoint. It runs `ensure_gateway_runtime` (`gateway_client.py:350`), which can start a gateway or replace an incompatible one.
   - V: The live gateway **does** mount the full dashboard app, plugin routes included, on its private listener. Its listener is gated because `dashboard.public_url` is non-loopback (`run_api.py:262-266`), and `app.state.session_authority` is set there (`run_api.py:97`).
   - I: bb cannot reach that listener: it is on an ephemeral loopback port, and tailscale `:8448` points at `:9119`.
3. **Auth**
   - V: Plugin HTTP routes take the gated middleware's `Authorization: Bearer <session token>`.
   - V: Plugin **WebSocket upgrades skip the middleware**. The route must call `hermes_cli.web_server_chat._ws_auth_ok(ws)` itself (kanban and Conduit both do).
   - V: That check accepts `?ticket=` (from `POST /api/auth/ws-ticket`, 30 s, single use) or `?token=<session token>`. It does **not** read a Bearer header.
4. **Discord**
   - V (code path, not run): a viewer's `prompt.submit` on a session the Discord chat still routes to runs on the ordinary messaging path, with `source` = the Discord source. The reply is **streamed and delivered to the Discord chat** and also published to viewers (`session_ingress.py:320-328`, `run_turn_runner.py:258-308`).
   - V: If the chat has moved past the session (detached), the reply goes to viewers only.
   - I/unknown: whether the viewer's own text is echoed into Discord. I found no code that does it.
5. **Bot Chat + Conduit**
   - V: All 5 Bot Chats are already gateway-adopted (`session_key` and `chat_id` set). There are 0 `session_turn_leases` and 0 `active_sessions` entries.
   - I: Two canonical viewers (bb plus Desktop, or bb plus another canonical client) share one FIFO, so they don't conflict.
   - I: The remaining risk is Conduit's **legacy** dashboard `/api/ws`. It can hold an active-session lease and runs legacy turns while the ledger is idle (`tui_gateway/session_lifecycle.py:180-214`); turns are serialized by turn leases.
6. **Isolated spike**
   - V: Feasible, but there are **host-wide singletons in `~/.local/state/hermes/gateway-locks`**: host-gateway and host-serve locks/records, plus Discord token locks.
   - Set `HERMES_GATEWAY_LOCK_DIR` to a spike directory and run the dashboard with `--isolated`.
   - Use `/private/tmp/...`, not `/tmp/...`: `/tmp` is a symlink, and the control socket then refuses tickets (`control_socket.py:407`).
7. **Plugin install impact**
   - V: The dashboard re-checks `plugins.enabled` on every request and hot-mounts a new plugin on its first **HTTP** request (no restart).
   - V: `hermes plugins enable|install` also sends `reload-plugins` to the live gateway (`plugins_activation.py:118-170`), which loads `plugin.yaml` hooks live and re-wires adapters.
   - I: Changing the code of an already-mounted `plugin_api.py` needs a dashboard restart. That drops Conduit's legacy chats but not gateway sessions.
   - V: The gateway imports enabled plugins' `plugin_api.py` at its next start.

## 1. hermes-gateway-v1 cheat-sheet (V: contract schemas + `gateway/session_controls.py`)

### Transport
- Dial: `ws://127.0.0.1:<ephemeral>/api/ws` with subprotocols `["hermes-gateway-v1", "hermes-gateway-ticket.<ticket>"]` (`gateway_client.py:39-45`).
  - The server echoes only `hermes-gateway-v1`.
  - An `Origin` header, a non-loopback peer or a bad ticket gets close code `4403`. Draining or not ready gets `1013` (`run_api.py:346-488`).
- Ticket: send one JSON line to `<root home>/gateway.sock`:
  - `{"protocol":1,"id":1,"verb":"session-ticket","params":{profile_id,instance_id,purpose:"interactive",scope?:"host",subject?}}`.
  - It returns `{ticket,expires_in_seconds:30,…}`. Only a same-UID peer gets one (`control_socket.py:369-397`).
  - A ticket with `scope:"host"` lets a single socket address any served profile through `params.profile` (`session_controls.py:306-313`).
- Errors:
  - `{code:4001, message:<reason>, data:{reason,…}}`. Reasons include `invalid_params`, `permission_denied`, `not_found`, `profile_mismatch`, `runtime_draining`, `stale_epoch`, `queue_full`.
  - An unknown method gets `-32601`.
  - Undeclared keys are rejected, because each contract is a closed key set (`session_controls.py:323-330`).
- Keepalive: `gateway.ping`. On accept the server sends the event `gateway.ready{skin,change_events,replay_epoch,heartbeat?,session_authority?}`.

### Methods (`*` = required)
| Method | Params | Result |
|---|---|---|
| `runtime.describe` | — | `instance_id, profile_id, authority_epoch, capabilities[]` (live set: `durable-admission-v1, event-replay-v1, local-cli-create-v1, acp-editor-policy-v1, acp-session-mcp-v1, clarify-batch-v1`; `session_controls.py:541-552`), `session_create{sources[],parameters[]}`, `skin` |
| `session.create` | `profile, request_id, source∈{cli,tui,gui,acp,tool,oneshot}, cwd, model, provider, reasoning, title, hidden, toolsets, skills, yolo, follow_profile_config, …` (29 keys) | **Snapshot** (below) |
| `session.resume` | `profile, *session_id, omit_messages, defer_history, display_projection, title, latest, source, workspace, cols` | Snapshot. Mounts cold messaging rows (`session_route_recovery.py`) |
| `session.list` | `profile, scope∈{live,stored}, limit, title, include_hidden` | `sessions[{session_id,id,title,source,started_at,message_count,running,model,resolved_id,root_title}], scope`. Bot Chat lookup: `title:"Bot Chat", include_hidden:true` |
| `session.events.since` | `profile, *session_id, last_sequence, last_seen, replay_epoch` | `events[ReplayEvent], latest_seq, last_sequence, epoch, replay_epoch, truncated, snapshot_required, count, open_requests` |
| `prompt.submit` | `profile, *session_id, *text, submission_id\|input_id` (**one is required, non-empty**; `:764,823`), `queued` (accepted, no effect), `attachments, display_kind:"hidden", title_preview, turn_author{id,name,is_bot,origin}, api_text, model_override, clarify_batch, surface, …` | `AdmissionStatus{admission_id, ref{profile_id,session_id}, sequence, status∈{queued,started,unknown,terminal}, outcome, authority_epoch, execution_generation}`. Refused with `permission_denied` unless **this socket** resumed or created the session (`:815`) |
| `session.interrupt` | `profile, *session_id, *execution_generation` | `{ref, instance_id, authority_epoch, revision, execution_generation, execution_state∈{idle,running,waiting,unknown,terminal}}` |
| `session.steer` / `session.redirect` | `profile, *session_id, *execution_generation, *text` | `{status∈{queued,redirected,rejected}, text, execution_generation, authority_epoch}` |
| `prompt.steer_queued` / `prompt.replace_queued` / `prompt.cancel{session_id,admission_id}` / `prompt.receipt{session_id,admission_id,include_result}` | — | `AdmissionStatus` (+ `result`, `usage`) |
| `approval.respond` | `profile, *session_id, *execution_generation, *prompt_id, *choice∈prompt.choices` (`once, deny, session, always`) | `{status∈{resolved,already_resolved}, prompt_id}` |
| `clarify.respond` | `*session_id, *execution_generation, *prompt_id, *answer` ("" = skip) | same as `approval.respond`. `clarify.lock` handles batch answers |
| `session.mutate` | `*session_id, *request_id, *expected_revision, *operation, *payload, expected_generation` | `{session_id, operation, revision}`. Payloads: `rename{title}`, `archive{archived:bool}`, `sidebar{title?,archived?,hidden?,pinned?,unread?}` (`hermes_state_mutations.py:5,49-55`). Also `delete, reset, rewind{target_message_id}, branch, model, compress, import, …` |
| `session.detach` | `*session_id, *subscription_id, end_reason` | `{session_id, subscription_id, detached}` |
| `session.info` | `*session_id` (only) | frozen launch policy: `source, model, profile_name, title, cwd, …` |
| `profiles.list` | `profile, include_sessions` | `profiles[{name,path,is_default,model,provider,description,display_name,canonical_session{id,resolved_id,title,…},last_session,ui_meta,has_avatar}], bot_mode_protocol, install_id` |

- Legacy-only (`METHODS`, not on the canonical socket): `session.title`, `session.archive`, `client.capabilities`. Use `session.mutate`.
- Snapshot (`CanonicalSnapshot`): `session_id, stored_session_id, messages[TranscriptMessage{role,text,content,tool_call_id,timestamp,row_id,display_kind,name,args,reasoning}], message_count, running, authority_epoch, replay_epoch, last_sequence, subscription_id, revision, execution_generation, pending[{admission_id,status,text,input_id,controls,…}], prompts[{kind∈{approval,clarify},prompt_id,execution_generation,choices,command,description,question,multi_select,timeout_s}], info, todo_state, open_requests`.
- `revision` and `execution_generation` are the fences for `session.mutate` and interrupt/approval calls.

### Event envelope (`gateway/session_events.py:48-60`; consumer `acp_adapter/gateway_server.py:930-975`)
- `{"jsonrpc":"2.0","method":"event","params":{type, session_id, payload, seq, replay_epoch, authority_epoch?, execution_generation?, admission_id?}}`.
- Dedupe rule: drop an event when `replay_epoch == snapshot.replay_epoch && seq <= last_sequence`.
- If the epoch changes, or `events.since` returns `snapshot_required`, call `session.resume` again.

| type | payload |
|---|---|
| `message.start` | `text?, display_kind?, display_text?, turn_id?, notification_category?` |
| `message.delta` | `*text\|null` (null = segment boundary), `rendered?, turn_id?, segment?, offset?` |
| `message.interim` | `*text, *already_streamed, turn_id?, segment?` |
| `message.complete` | `text, usage, status∈{complete,error,interrupted}, reasoning, error, failure_reason, partial, persisted_turn{row_ids,complete,user_row_id,final_assistant_row_id,submission_id}, …` |
| `reasoning.delta` / `reasoning.available` / `thinking.delta` | `*text, rendered?, verbose?` |
| `tool.start` | `*tool_id, *name, context, args, args_text, preview, labels` |
| `tool.generating` | `*name` |
| `tool.progress` | `*tool_id, *name, *progress, total, percent, message` |
| `tool.complete` | `*tool_id, *name, args, duration_s, result, summary, result_text, inline_diff, todos, labels` |
| `approval.request` | `kind:"approval", prompt_id, execution_generation, command, description, choices, edit?, timeout_s?` (`session_pending_controls.py:18-38`) |
| `clarify.request` | `kind:"clarify", prompt_id, execution_generation, question, choices, multi_select, timeout_s?` (`:40-52`) |
| `approval.settled` / `clarify.settled` | `prompt_id, execution_generation` (`:54-64, 79-81`) |
| `approval.cancelled` | `session_id, stored_session_id, reason, cancelled_count, request_ids[]` |
| `session.info` | `model, provider, running, title, stored_session_id, usage, profile_name, cwd, turn_started_at, …` |
| `session.title` | `*session_id, *title` |
| `session.usage` | `input_tokens, output_tokens, context_tokens, context_length, model, …` |
| `sessions.changed` | `ChangeSignalPayload` (empty object: a signal only) |
| `todo.updated` | `*todos[], *revision` |
| other | `status.update{kind,text}`, `error{message}`, `request.cancel{id,method,reason}`, `subagent.*`, `session.control.update` |

### Server→client requests (`gateway/session_server_requests.py:1-20`)
- Owner→viewer JSON-RPC requests (`sudo`, `secret`, batch `clarify`, Desktop UI requests) have a 120 s timeout. The viewer answers with a response frame that reuses the request id.
- Ordinary approvals and per-question clarifies are **events**, not requests. bb only needs `approval.request` and `clarify.request` events plus `*.respond`.
- `client.capabilities{server_requests,desktop_local}` → `{server_requests[],declines_not_shown,canonical_clarify_batch}` is a legacy dispatcher method (`tui_gateway/methods_voice.py:522`). It is not in the canonical handler table.

## 2. Gateway connection from a dashboard plugin

- Homes: default is `~/.hermes`; named profiles are `~/.hermes/profiles/<name>`.
  - V: `discover_gateway_endpoint(profile_home)` resolves a served profile to the multiplexer's endpoint, with `profile_id` = the profile's home and `control_home` = the root (`gateway_runtime.py:155-159, 289-311`).
- Recommended code, mirroring in-tree `tui_gateway/owner_forward.py:69-91, 221-235` (I: works from a plugin, same process):
  ```python
  from tui_gateway.owner_forward import discover_owner, connect_owner   # discovery only, never starts a gateway
  ep = await asyncio.to_thread(discover_owner, Path(root_home))
  async with connect_owner(Path(root_home), ep, scope="host", max_size=64 << 20) as gw:
      snap = await gw.rpc("session.resume", profile="alex", session_id=sid, omit_messages=True)
      # gw.events: asyncio queue of {"method":"event","params":{…}} frames
  ```
  - Alternative public API: `connect_gateway(endpoint=discover_gateway_endpoint(home).endpoint, max_size=…)` (`gateway_client.py:319-382`). It mints a profile-scoped ticket; Conduit's `bot_chat_adopt.py:140-178` does exactly this.
  - Risk: both helpers are internal and unversioned. Feature-detect with `inspect.signature`, as Conduit does.
- Never call `connect_gateway()` without `endpoint` and never set `HERMES_TUI_GATEWAY_URL` in the dashboard. Without an endpoint it runs `ensure_gateway_runtime(..., idle_exit=True)`, which may start a gateway or stop an incompatible one (`gateway_client.py:340-352`; `gateway_runtime.py:390-405`).
- Ticket subject: the socket peer, `uid:<n>`. A structured `subject=auth:v1:[provider,issuer,user]` can relabel it (`control_socket.py:384-391`). Sessions bb creates are owned by that subject (I).
- Blocking: ticket minting and discovery are synchronous socket I/O. Wrap them in `asyncio.to_thread`, because the plugin shares the dashboard event loop.
- Is there an in-gateway plugin route? V: yes, but it isn't worth it now.
  - `GatewayDashboardMount` imports `hermes_cli.web_server`. Plugin APIs are mounted at import (`web_server.py:858`), and the live gated listener mounts it at start (`run_api.py:266`).
  - Inside, `request.app.state.session_authority` / `gateway_runner` are set (`run_api.py:94-97`). Conduit uses this (`room_start.py:218-231`).
  - Reaching it from bb:
    - (a) Discover `api_origin` via the control socket and proxy from $HERMES_HOST. That duplicates the canonical WS.
    - (b) A `webapp:` block with a fixed port. This needs a gateway restart, and on the Webapp surface the static bearer is refused unless that listener issued it (`webapp_sign_in.py:112-121`).
  - Recommendation: the dashboard-side relay. Revisit only if S4 finds a canonical gap.

## 3. Auth for plugin routes in gated mode (V, code; WS behaviour not exercised)

| Route kind | Accepted | Rejected |
|---|---|---|
| Plugin HTTP `/api/plugins/<n>/…` | `Authorization: Bearer <HERMES_DASHBOARD_SESSION_TOKEN>` (session-token provider, `plugins/dashboard_auth/session_token/__init__.py:93-131`), cookies, native bearers | `X-Hermes-Session-Token` (02 §4) |
| Plugin WS upgrade | Whatever the route itself checks. With `_ws_auth_ok(ws)`: `?ticket=<POST /api/auth/ws-ticket>` (unnamed ticket, valid for any non-own-ticket socket; `web_session_sockets.py:50-66`), `?token=<session token>` (verified via providers, `web_server_chat.py:290-330`), `?internal=`, `X-Hermes-Gateway-Ticket` (native) | Bearer **header** (never read on upgrade), the legacy in-process `_SESSION_TOKEN` |

- `PluginApiWebSocketGate` (`web_server_dashboard.py:926-963`) only does the Host/Origin/peer check and plugin consent. It says the route's own code must check credentials. Precedents: `plugins/kanban/dashboard/plugin_api.py:51-58,1802-1806` and Conduit `dashboard/api/grok_live.py:206-226` (`_ws_auth_ok` + `_ws_request_is_allowed`).
- Recommended for bb: `POST /api/auth/ws-ticket` with Bearer, then `wss://…:8448/api/plugins/bb_bridge/ws?ticket=…` within 30 s. This keeps the static token out of URLs and logs. V: no `token=` values appear in the dashboard or gateway logs today.
- Host header must be `127.0.0.1` or the `public_url` host; an Origin header must be absent or allowed (`web_server_boundary.py:251-282`).
- Don't pass `?profile=<secondary>` to bb_bridge routes. V (code), behaviour not tested:
  - `plugin_request_scope` and `_plugin_route_secret_scope` would then gate on that profile's `plugins.enabled` and refuse a user plugin's in-process router (`web_server_plugin_profiles.py:176-196`; `web_server_dashboard.py:995-1014`).
  - Pass the profile inside the body or WS frames instead.
- `plugins.isolation: host` buffers responses and **cannot carry WebSockets** (`web_server_dashboard.py:1017-1020`). bb_bridge must run in process, so it must be async and non-blocking.

## 4. Delivery and writer conflicts

- Viewer submit on a Discord-routed session (V code path; I for the end result):
  1. `prompt.submit` → durable admission (intent `queue`) → `session_ingress.py:300-330`. It builds a `MessageEvent(source=live.source)` (the Discord source), and the comment at `:321-324` reads "the claim on a chat route (native or a viewer's submit)".
  2. `run_turn_runner.py:258-283`: `adapter = _delivery_adapter_for(ctx.source)` (the Discord adapter) → `GatewayStreamConsumer(chat_id=ctx.source.chat_id, initial_reply_to_id=ctx.event_message_id)`.
  3. `:303-308`: each delta is published to viewers (`_publish_execution("message.delta")`) **and** fed to the Discord stream.
  4. Result: the reply posts to Discord. Exception: rows the lane moved past (`/new`) mount detached under `agent:<ns>:detached:<sid>` and reach viewers only (`session_detached.py:1-27`, `session_route_recovery.py:14-18`).
  - Unknown, for S4: whether the viewer's text appears in Discord (no echo code found), and how Discord handles `reply_to` = the admission id.
- Discord-native turns: viewers attached to that session get the same canonical events (`stream_delta_cb` exists whenever `_approval_owner` is set). This gives bb its live mirror (I).
- Approvals on Discord turns: Discord buttons **and** attached viewers both get them. `resolve_gateway_approval(route, choice, request_id=prompt_id)` lets the first responder win; the others see `approval.settled` (`session_pending_controls.py:66-100`).
- Cron rows are LOCAL (`session_route_recovery.py:20-23`). A viewer turn there doesn't post anywhere (I).
- Bot Chat + Conduit (V data, I behaviour):
  - All Bot Chats have `session_key` and `chat_id`, i.e. they're already adopted. Conduit's sweep moved alex/david/todoist on 2026-11-02 (`gateway.log`).
  - `session_turn_leases` 0 rows in every DB; `runtime/active_sessions.json` 0 entries.
  - Turn lease (`hermes_state_runtime.py:847-870`): per-conversation, held only while a turn runs (TTL 300 s). It serializes writers; it doesn't lock viewers out.
  - Writer lease (`active_sessions.json`): only a legacy backend holds it (the standalone dashboard `/api/ws`, Conduit's path).
    - It blocks the adoption of **legacy** rows (`runtime_coordination_required`; `gateway/session_bot.py:700-704, 921-935`; `tools/bot_mode_dm.py:546-548`).
    - Legacy turns are refused only while the canonical ledger holds work (`tui_gateway/session_lifecycle.py:180-214`) and are then forwarded (`owner_forward.py`).
    - I: so with Conduit chatting through the legacy dashboard and bb through canonical, both write the same Bot Chat. Turns are serialized by the turn lease, but bb sees Conduit's turns only as transcript updates, not live.

## 5. Isolated spike instance on $HERMES_HOST (not started)

Host-wide state that a second instance would collide with (V):
- `~/.local/state/hermes/gateway-locks/`:
  - `host-gateway.{lock,json}` (pid 63362, home `~/.hermes`)
  - `host-serve.{lock,json,token}` (pid 18230, port 9119)
  - 4 `discord-bot-token-*.lock`
  - Override the whole directory with `HERMES_GATEWAY_LOCK_DIR` (`gateway/status.py:321-337`).
- Without the override:
  - a 2nd gateway loses `claim_host_lock(ROLE_GATEWAY)` and exits 75, unless `--force` (`gateway/run.py:4852-4893`);
  - a 2nd dashboard attaches to, or refuses against, the `ROLE_SERVE` record unless `--isolated` (`main_dashboard.py:915-945`);
  - a 2nd dashboard may try to reap an "orphaned" owner listed in its root's `spawn-ledger.json` (`web_server.py:1099-1130`; `process_identity.py:629-675`). With a separate root the live PIDs aren't in that ledger, so nothing is reaped (I). The override avoids the code path entirely.
- Per-home state, isolated by `HERMES_HOME`: `gateway.lock`, `gateway.pid`, `gateway.sock`, `state.db`, `spawn-ledger.json` (root = HERMES_HOME when it is outside `~/.hermes`; `hermes_constants.py:99-107`), and plugins.
  - A home outside `~/.hermes/profiles/` is its own root, never multiplexed (`gateway_runtime_multiplex.py:18-24`).

Steps (run nothing from hermes-host wrappers; they hard-code `HERMES_HOME=~/.hermes` and `--replace`):
1. `install -d -m 700 /private/tmp/hermes-spike /private/tmp/hermes-spike/locks /private/tmp/hermes-spike/plugins`.
   - Must be the real path: `/tmp` → `private/tmp` makes `home.absolute() != home.resolve()`, so the control socket gives no peer subject and refuses every ticket (`control_socket.py:399-410`).
2. `/private/tmp/hermes-spike/config.yaml`, minimal:
   - `model: {default: mlx_main, provider: mlx-main, base_url: http://127.0.0.1:8318/v1, key_env: OMLX_API_KEY}`, plus the `providers.mlx-main` block copied from `~/.hermes/profiles/alex/config.yaml:10-23`.
   - `approvals: {mode: manual}`, so approvals actually fire.
   - No `platforms`/Discord, no `api_server`, no `mcp_servers`, no `webapp`.
   - `plugins: {enabled: [bb_bridge]}`.
   - Optional `dashboard.public_url: https://spike.invalid` to reproduce gated mode. Clients still dial `127.0.0.1:<port>`, because the bound host passes the Host check.
3. `/private/tmp/hermes-spike/.env` (mode 600): `OMLX_API_KEY` (present in alex's `.env`; copying it duplicates a secret), plus a **new** random `HERMES_DASHBOARD_SESSION_TOKEN`. Never reuse the live token.
4. Common environment: `export HERMES_HOME=/private/tmp/hermes-spike HERMES_GATEWAY_LOCK_DIR=/private/tmp/hermes-spike/locks; unset HERMES_TUI_GATEWAY_URL`. Also export `HERMES_DASHBOARD_SESSION_TOKEN` if `public_url` is set: the gated gateway listener needs a provider.
5. Gateway, in the foreground: `~/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run` (no `--replace`, no `--force`).
6. Dashboard: `~/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main dashboard --host 127.0.0.1 --port 9139 --isolated --skip-build --no-open`. V: 9139 is free now.
7. Plugin: `ln -s ~/src/bb-plugin-hermes/hermes-plugin/bb_bridge /private/tmp/hermes-spike/plugins/bb_bridge`. Hit it with an HTTP GET first, which hot-mounts it.
8. Stop with Ctrl-C, then `rm -rf /private/tmp/hermes-spike`.

Risks:
- oMLX `mlx_main` is shared with the live alex and david profiles, so spike turns compete for the slot.
- The Discord-delivery question can't be answered in the spike without a **separate** test bot and guild. Never reuse a live bot token: the token locks would collide only if the lock dir were shared, but Discord itself would kick the live session.
- Don't run `hermes gateway start|stop|restart|install`, `hermes dashboard --stop`, or `hermes update` from a shell where `HERMES_HOME` might be unset. They target the `ai.hermes.*` launchd labels and the live root (`hermes_cli/gateway.py:2858-2861`).
- `hermes update` checks host obligations; avoid running it while the spike is up (I).
- Same install and venv as the live system: an edit to `~/.hermes/hermes-agent` hits both.

## 6. Installing the companion plugin on the live system

What reads `plugins.enabled`, and when (V):
- Dashboard:
  - At startup: `_mount_plugin_api_routes()` imports enabled plugins' `plugin_api.py` (`web_server_dashboard.py:1060-1086`).
  - On every request: the runtime gate re-reads it, for HTTP and WS (`:908-924`).
  - Later: `_PluginApiHotMount` mounts a newly enabled plugin on its **first HTTP request**, with no restart (`:1090-1180`). The fallback is registered for HTTP methods only, so a WS-first client won't trigger a hot mount (I).
  - Rescan: `GET /api/dashboard/plugins/rescan`.
- Gateway:
  - At startup: `PluginManager` loads `plugin.yaml` + `__init__.py:register` (hooks, tools).
  - Its embedded dashboard mount imports `plugin_api.py` too, at the next gateway start.
  - `hermes plugins enable|install` calls `activate_plugin_now` → control verb `reload-plugins`. That re-discovers plugins in the **live** gateway and re-wires the profile's adapters (`plugins_activation.py:118-170`; `gateway/run_plugin_rewire.py:82-110`).
  - Hooks and slash commands go live at once; tools and prompt sections wait for the next session; missing Python dependencies set `restart_required`.
  - It also nudges the `ROLE_SERVE` dashboard (`notify_serve_backend`).
- Restart cost:
  - Gateway restart: drops every live session and running turn (`_hermes.nix:98`). Avoid it.
  - Dashboard restart: only drops legacy dashboard-hosted chats (Conduit/SPA).
  - Updating already-imported `plugin_api.py` code requires a dashboard restart (I: modules are imported once).
- Recommendation for v0:
  - Make bb_bridge **dashboard-only**: `dashboard/manifest.json` with `"api": "plugin_api.py"`, no `plugin.yaml` hooks. The gateway then loads no hooks.
  - Keep `plugin_api.py` import side-effect-free, because the gateway imports it at its next restart.
- Installing from a checkout:
  - `hermes plugins install file://~/src/bb-plugin-hermes#hermes-plugin/bb_bridge` → git clone into `~/.hermes/plugins/` (a copy). `file://` triggers a warning (`plugins_cmd.py:298-333`). Updating means `hermes plugins update` or a reinstall with `--force`.
  - Symlink `~/.hermes/plugins/bb_bridge` → checkout: discovery uses `is_dir()`, which follows links (`web_server_dashboard.py:620-635`, I), and you get edit-in-place. But `hermes plugins` metadata won't know about it, and the trust boundary becomes the git checkout.
  - Enable by adding `bb_bridge` to `plugins.enabled` (config edit; the dashboard picks it up per request) or with `hermes plugins enable bb_bridge`. Whether a dashboard-only plugin with no `plugin.yaml` resolves through `_resolve_plugin_key_and_source` is unknown (I); test in the spike first.
  - `hermes plugins enable` sends `reload-plugins` to the live gateway; a hand edit doesn't.

## Residual risks / open items

- Nothing in this file was exercised over a WebSocket:
  - canonical WS framing;
  - `?ticket=` on plugin sockets;
  - Discord delivery of viewer replies;
  - legacy/canonical co-writing of Bot Chats.
  All are code reads; S4 must verify them.
- The internal helpers (`owner_forward`, `_session_ticket`, `_ws_auth_ok`) are private and unversioned on a daily canary. Wrap them behind one shim with feature detection.
- `session.resume` answers carry the whole history. Use `omit_messages:true` or a large `max_size`, because the default `connect_owner` limit is 1 MiB.
- `ensure_gateway_runtime` side effects if anyone calls `connect_gateway()` without an endpoint.
- A gated private gateway listener means the gateway imports enabled plugins' `plugin_api.py`. A heavy import slows every gateway cold start.

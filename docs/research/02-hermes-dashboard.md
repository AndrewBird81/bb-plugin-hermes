# Hermes dashboard as the bb integration surface

Lane: Hermes dashboard. Investigated 2026-11-04 on $HERMES_HOST. Read-only: no POST/PUT/PATCH/DELETE, no WebSocket upgrades, no prompts sent, no service changes.
Labels: **V** = VERIFIED (I ran or read it), **I** = INFERRED.

## Key answers

1. **Version/source.**
   - V: source is `~/.hermes/hermes-agent` (origin `NousResearch/hermes-agent`), detached HEAD `c314285f077e91937c995d419b9fa40af9eb4981` (2026-11-03), `git describe` = `v0.22.6+canary.20261103T064339Z-14-gc314285f07`. `install-stamp.json` gives displayVersion `0.22.6+481.gc314285.dirty`. Dirty means one untracked contributors file. `/api/health` reports `0.22.6`.
   - V: launcher chain is `~/.local/bin/hermes` → `~/src/hermes-host/bin/hermes` → `~/.hermes/hermes-agent/.hermes/bin/hermes`, which runs the pinned Python `~/.hermes/tools/python-3.14.9+20261021-darwin-arm64`. `acp` is routed through `hermes-bb-acp`.
2. **How the dashboard runs.**
   - V: launchd `ai.hermes.dashboard` runs `bin/hermes-dashboard`, which execs `python -m hermes_cli.main dashboard --host 127.0.0.1 --port 9119 --skip-build --no-open`. The process (PID 18230) listens on `127.0.0.1:9119` only.
   - V: tailnet exposure is `tailscale serve` at `https://$HERMES_HOST_TS.$TAILNET:8448` → `127.0.0.1:9119` (tailnet only). `:8446` is webui (`:8787`), not the dashboard.
   - V: `dashboard.public_url = https://$HERMES_HOST_TS.$TAILNET:8448` turns on the **auth gate** even on the loopback bind (`auth_required: true`). Providers: `basic` (username/password from `auth.env`) and `session-token` (the static `HERMES_DASHBOARD_SESSION_TOKEN`).
3. **Endpoints.** About 325 HTTP routes plus 9 WebSockets (details below).
   - Sessions REST is complete: list, cross-profile list, sidebar, search, detail, messages, timeline, PATCH for title/pinned/archived/unread/hidden, delete, export.
   - Live chat is the **`/api/ws` JSON-RPC WebSocket**. It is the same `tui_gateway` protocol Desktop and the TUI use (258 methods, 78 event types, 16 server→client requests including `approval`), with a generated OpenRPC contract.
   - `/api/pty` is a PTY running the Ink TUI. That suits a browser terminal, not bb.
4. **Auth.**
   - V: a non-browser client works with `Authorization: Bearer <HERMES_DASHBOARD_SESSION_TOKEN>`: 200 on loopback and over tailnet `:8448`.
   - V: the `X-Hermes-Session-Token` header is **rejected** in gated mode (401).
   - I (from code): WebSocket auth is `?token=<same token>` on `/api/ws`.
   - V (code): the Host header must be `127.0.0.1` or the public_url host. CORS only matters for browsers; bb server-to-server calls are unaffected.
5. **Dashboard plugins.**
   - Yes. `~/.hermes/plugins/<name>/dashboard/manifest.json` with `"api": "plugin_api.py"` exporting a FastAPI `router` is mounted at `/api/plugins/<name>/` (HTTP **and** WebSocket) behind the same auth gate. An optional JS bundle can add UI tabs or slots.
   - The plugin's Python runs only if the plugin is in `plugins.enabled`. It can import Hermes internals (`hermes_state.SessionDB`, etc.). There is a live precedent: `conduit_push` (third-party) ships `dashboard/plugin_api.py`.
   - So a companion plugin **can** expose a bb-shaped API: change cursor, an events WebSocket, send, approvals.
6. **Live GET probe.**
   - V: unauthenticated only `/api/health`, `/api/status`, `/api/auth/providers`, `/api/dashboard/plugins`, `/api/model/info`, and the config defaults/schema endpoints answer. Everything else returns 401 `{"error":"unauthenticated","reason":"no_cookie","login_url":"/login"}`.
   - V: with the bearer token, everything probed returned 200. Latency: 2–70 ms loopback, about 13–20 ms over tailnet; `/api/messaging/platforms` takes 0.52 s.
7. **Multi-profile.**
   - V: one dashboard process serves **all** profiles. REST takes `?profile=<name>` per request; `/api/profiles/sessions?profile=all` aggregates every profile's `state.db`.
   - V: JSON-RPC methods take a `profile` param.
   - V: the gateway is one **multiplex** process for default, alex, david, neo, todoist (`gateway_mode: "multiplex"`).
8. **Gaps vs goals.**
   - No REST change cursor; only a coarse `sessions.changed` event or row revisions.
   - Gateway-owned turns (Discord, cron) run in the gateway process. The standalone dashboard cannot stream them live, only re-read transcripts. Prompts it sends are forwarded to the owner.
   - "Bots" are profiles with gateway platforms; there is no first-class bot entity.
   - Approvals for gateway platform sessions happen on the platform.
   - The static token is all-powerful (env/secrets/files/shell).

## 1. Install and source (V)

- `~/.local/bin/hermes:2` → `exec ~/src/hermes-host/bin/hermes`.
- `~/src/hermes-host/bin/hermes:4-10`: launcher is `$HERMES_INSTALL_ROOT|~/.hermes/hermes-agent/.hermes/bin/hermes`; `acp` goes through `hermes-bb-acp`. hermes-host is at jj `zvtmzopp bb96c5ab`.
- `~/.hermes/hermes-agent/install-stamp.json`: `baseVersion 0.22.6`, `distance 481`, `dirty true`, `updateMechanism self`, built 2026-11-03.
- `pyproject.toml` has `version = "0.0.0"`; the real version comes from the stamp and git.
- Dashboard server code: `hermes_cli/web_server.py` (1528 lines; FastAPI app at line 209), `hermes_cli/web_server_*.py` (about 10.9k lines total), `hermes_cli/web_routers/*.py`, `hermes_cli/dashboard_auth/*`. SPA in `web/src` (client `web/src/lib/api.ts`, `api-plugins.ts`); prebuilt dist in `hermes_cli/web_dist`.
- JSON-RPC backend: `tui_gateway/` (`ws.py` 750 lines, `server.py` 2041 lines). Protocol docs: `tui_gateway/AGENTS.md`.
- Contract: `apps/shared/src/gateway-contract.openrpc.json` (1.2 MB; 258 methods). TS client: `apps/shared/src/json-rpc-gateway.ts` (`JsonRpcGatewayClient`). MIT licensed (`LICENSE`).
- Docs: `website/docs/user-guide/features/extending-the-dashboard.md` (945 lines).

## 2. Runtime setup (V)

- launchd: `~/Library/LaunchAgents/ai.hermes.dashboard.plist`.
  - KeepAlive, RunAtLoad, ThrottleInterval 30, WorkingDirectory `~/.hermes`.
  - env: `HERMES_HOME=~/.hermes`, `HERMES_HOST_DASHBOARD_HOST=127.0.0.1`, `HERMES_HOST_DASHBOARD_PORT=9119`.
  - Logs: `~/.hermes/logs/dashboard{,.error}.log`.
  - `launchctl list` shows PID 18230 with last exit `-15`; it has been up about 1 day.
- Source of the plist: nix-config `modules/aspects/services/_hermes.nix` (commit `02af3811`, 2026-11-03).
  - Lines 90-94: option `dashboardPort` (default 9119, "127.0.0.1 only").
  - Lines 120-126: `hermes-dashboard = mkAgent "dashboard"`.
  - The path given in the task, `home/services/hermes.nix`, does not exist (404).
- Wrapper `~/src/hermes-host/bin/hermes-dashboard`:
  - Sources `~/.config/hermes-host/auth.env` (mode 600). Its keys are `HERMES_DASHBOARD_SESSION_TOKEN`, `HERMES_WEBUI_PASSWORD`, `HERMES_DASHBOARD_BASIC_AUTH_USERNAME`, `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH` and `HERMES_DASHBOARD_BASIC_AUTH_SECRET`; all **present**.
  - Exits 78 if the token is missing.
- `bootstrap.sh`:
  - Lines 22-29: ports. gateway API 8642, dashboard 9119, webui 8787 → tailnet 8446, dashboard tailnet **8448** ("Hermes Conduit").
  - Lines 185-197: `cmd_serve` runs `tailscale serve --bg --https=8448 http://127.0.0.1:9119`. A comment notes it requires `dashboard.public_url`.
  - Lines 109-150: warns that `hermes update` respawns an orphan dashboard without the stable token.
- `~/.hermes/config.yaml` `dashboard:`:
  - `public_url: https://$HERMES_HOST_TS.$TAILNET:8448`.
  - `basic_auth.*` in YAML: absent/empty (the env vars supply it).
  - `oauth.client_id`/`portal_url`: empty.
- `tailscale serve status`: `:8446→8787`, `:8447→8318`, `:8448→9119`, all "(tailnet only)".
- `tailscale ping $BB_SERVER_TS`: direct, 1 ms. $BB_SERVER_TS ($BB_SERVER_IP) is a tailnet peer.
- Other listeners:
  - Gateway PID 63362 listens on `127.0.0.1:8642` (OpenAI-compatible api_server) and an ephemeral private listener `127.0.0.1:58355`: the native `hermes-gateway-v1` session WebSocket plus the dashboard API (`gateway/run_api.py:1-13`).
  - Gateway control socket: `~/.hermes/gateway.sock`.
  - Webui PID 61135 on `127.0.0.1:8787`.

## 3. Endpoint inventory

Source: `@router.<verb>` decorators in `hermes_cli/web_routers/*.py` (V, read). "probe" = I issued an authenticated GET (V).

### Sessions (`web_routers/sessions.py`, `profiles.py`)
- `GET /api/sessions` (`sessions.py:182`).
  - Query: `limit≤100, offset, min_messages, archived=exclude|only|include, order=created|recent, source, sources, exclude_sources, cwd_prefix, full, profile`.
  - Response: `{sessions[], total, limit, offset, storage}`.
  - probe: 17 ms.
- `GET /api/profiles/sessions` (`profiles.py:455`). Same filters, `limit≤500`, `profile=all|<name>`. Response adds `profile_totals{}` and `errors[]`. probe: 35 ms.
  - Row keys (V): `id, profile, profile_name, is_default_profile, source, created_source, title, title_source, preview, model, started_at, ended_at, end_reason, last_active, last_activity_at, last_activity_description, is_active, pinned, archived, auto_archived, hidden, unread, last_read_at, message_count, tool_call_count, tool_names, *_tokens, *_cost_usd, cwd, git_branch, git_repo_root, parent_session_id, session_key, chat_id, chat_type, thread_id, origin_json, runtime_revision, runtime_generation, transcript_revision, handoff_*`.
- `GET /api/profiles/sessions/sidebar` (`profiles.py:523`). Batched recents, cron and messaging slices; uses a "300s active heuristic". probe: 71 ms, 351 KB.
- `GET /api/sessions/search?q=` (`sessions.py:286`). FTS. Result keys: `snippet, role, session_id, lineage_root, profile, is_active, title, …`.
- `GET /api/sessions/stats` (`:538`). `{total, active_store, archived, messages, by_source{acp,cli,discord,cron,desktop,local,oneshot,api_server,tui}}`.
- `GET /api/sessions/{id}` (`:560`). Full row, including `system_prompt` and `model_config`.
- `GET /api/sessions/{id}/messages` (`:743`).
  - Response: `{session_id, profile, messages[], pagination{limit,offset,order,…}}`.
  - Message keys: `id, role, content, tool_call_id, tool_calls, tool_name, timestamp, reasoning*, display_kind, display_metadata, message_uid, tool_call_uid(s), platform_message_id, active, compacted`.
- `GET /api/sessions/{id}/timeline` (`:805`). `{entries[{row_id,preview,timestamp}], pagination{after_row_id,has_more,next_cursor}}`.
- `GET /api/sessions/{id}/messages/around`, `/mutation-snapshot`, `/latest-descendant`, `/export`.
- Writes (not probed):
  - `PATCH /api/sessions/{id}` (`:930`). Body `SessionRename`: `title, archived, hidden, pinned, unread, profile, request_id, expected_revision, expected_generation`.
  - `DELETE /api/sessions/{id}` (`:850`).
  - `POST /api/sessions/bulk-delete`, `/import`, `/prune`, `/owner-backfill`.
  - `DELETE /api/sessions/empty`.
- Note: there is **no** `since`/`updated_after` cursor on any list endpoint (V).

### Live chat / streaming (`web_routers/chat_ws.py`)
- `WS /api/ws` (`chat_ws.py:650`).
  - `tui_gateway.ws.handle_ws`: newline-delimited JSON-RPC both ways; `gateway.ready` is sent on accept (`tui_gateway/ws.py:1-4`).
  - Key methods, with params from OpenRPC (V):
    - `session.create{profile,cwd,title,model,provider,reasoning_effort,source,parent_session_id,close_on_disconnect,idempotency_key,…}` → `{session_id,stored_session_id,messages,info}`.
    - `session.resume{session_id,profile,lazy,omit_messages,…}` → `{running,pending_approval,open_requests,inflight,queued,todo_state,…}`.
    - `prompt.submit{session_id,profile,text,…}` → `{status,admission_id,forwarded,…}`.
    - `session.events.since{session_id,last_seen,replay_epoch}` → `{events,latest_seq,truncated,epoch,open_requests}`.
    - `session.interrupt`, `session.title`, `session.archive`, `session.list`, `session.active_list`.
    - `approval.respond{session_id,choice,all,request_id}`, `approval.pending`, `client.capabilities{server_requests:true}`.
  - Events (78): `message.start/delta/complete`, `thinking.delta`, `reasoning.delta`, `tool.start/progress/complete`, `subagent.*`, `session.info/title/usage`, `status.update`, `todo.updated`, `sessions.changed`, `cron.changed`, `platforms.changed`, `approval.cancelled`, `request.cancel`, `error`, …
  - Server→client requests (16): `approval, clarify, sudo, secret, …`. The client answers with the same `srq-<n>` id (`tui_gateway/AGENTS.md`).
  - `session.list` / `session.active_list` exist over RPC too.
- `WS /api/pty` (`:475`): PTY bridge to the Ink TUI (`?resume=&profile=&channel=`). Terminal bytes, unsuitable for bb rendering.
- `WS /api/pub` and `WS /api/events` (`:728-760`): per-channel fan-out of the PTY child's tool-call feed (sidebar). Only useful together with `/api/pty`.
- `WS /api/console` (`:241`): Hermes console engine.
- Other WebSockets: `/api/host-terminal` (`webapp.py:41`), `/api/display/ws`, `/api/audio/{transcribe,speak}-stream`.
- No SSE endpoint found (V, grep of route decorators).

### Profiles (`profiles.py`)
- `GET /api/profiles` → `[{name,path,is_default,model,provider,has_env,skill_count,gateway_running,description,display_name,bot_title,has_alias,…}]`. probe: 5 profiles.
- `GET /api/profiles/active` → `{active,current}`.
- Writes: `POST /api/profiles` (create), `POST /api/profiles/active` (switch), `PATCH`/`DELETE /api/profiles/{name}`, `GET`/`PUT /api/profiles/{name}/soul`, `PUT …/description`, `PUT …/model`, export/import, `GET /api/profiles/projects/tree`.

### Config / models / toolsets
- Config:
  - `GET /api/config` (108 top-level keys) and `PUT /api/config`; `GET /api/config/raw|defaults|schema`.
  - `GET /api/env`: dict of 418 entries `{is_set,redacted_value,is_password,…}`. `PUT`/`DELETE /api/env`. `POST /api/env/reveal` returns cleartext secrets.
- Models:
  - `GET /api/model/info` (public) → `{model,provider,effective_context_length,capabilities}`.
  - `GET /api/model/options` → `providers[{slug,models[],authenticated,…}]` (257 ms).
  - `POST /api/model/set`; `GET /api/model/auxiliary`; `GET`/`PUT /api/model/moa`.
- Toolsets: `GET /api/tools/toolsets` → `[{name,label,enabled,available,configured,tools[]}]`; `PUT /api/tools/toolsets/{name}`.
- Personality: `GET`/`PUT /api/profiles/{name}/soul`; `config.display.skin` via `/api/config`.

### Skills, cron, gateway/bots, logs, usage
- Skills:
  - `GET /api/skills` → `[{name,description,category,locked,enabled,usage,provenance}]`.
  - Hub endpoints under `/api/skills/hub/*`; toggle/lock/content writes.
- Cron:
  - `GET /api/cron/jobs` → `[{id,name,prompt,schedule{kind,expr,display},enabled,state,next_run_at,last_run_at,last_status,deliver,origin{platform,chat_id,…},…}]`.
  - `GET /api/cron/jobs/{id}`, `GET /api/cron/jobs/{id}/runs`.
  - Writes: pause/resume/trigger/cancel/delete. `POST /api/cron/fire` is **public** (`public_paths.py`).
- Gateway / platforms:
  - `GET /api/status` (public) → `{gateway_running,gateway_state,gateway_mode,gateway_shared_with[],gateway_platforms{"discord","api_server","alex:discord",…:{state,error_*,needs_attention}},active_sessions,active_agents,profiles,components,…}`.
  - `GET /api/messaging/platforms` → 32 platform descriptors `{id,name,enabled,configured,gateway_running,state,home_channel,env_vars[]}` (522 ms).
  - Telegram/WhatsApp onboarding flows; `POST /api/gateway/{start,stop,restart,drain}`.
- Logs: `GET /api/logs?lines=` → `{file,lines[]}`.
- Usage: `GET /api/analytics/usage` → `{daily[],by_model[],by_task[]}`; `GET /api/analytics/models`.
- Also present: files/fs (`/api/files/*`, `/api/fs/*` read/write), git (`/api/git/*`, including push and create-pr), MCP, OAuth, memory, credential pool, pairing, webhooks, ops (backup/import/doctor), `POST /api/hermes/update`.

## 4. Auth model

- Mode selection:
  - V: `web_server.py:337-345` `should_require_dashboard_auth` returns true for a non-loopback bind **or** a non-loopback `dashboard.public_url` (`web_server_boundary.py:121-123`). Here it is true.
  - V: `/api/health` returns `auth_required:true`.
- Gated middleware (`dashboard_auth/middleware.py:207-290`, V):
  - Public paths pass: `public_paths.py` plus `/login`, `/auth/*`, `/assets/`, `/dashboard-plugins/`.
  - A bearer is verified against session providers (`_verify_access_token`). Otherwise the cookie session is checked, with refresh.
- Static deployment token:
  - `plugins/dashboard_auth/session_token/__init__.py:93-131` (`SessionTokenProvider`) accepts `HERMES_DASHBOARD_SESSION_TOKEN` as a session with no expiry or rotation (user_id `deployment-token`).
  - V: `GET /api/auth/me` with the bearer → 200, provider `session-token`.
  - V: `X-Hermes-Session-Token` → 401 in gated mode. That header is only checked by the loopback-mode legacy gate (`web_server.py:298-308`).
- Browser flow:
  - `POST /auth/password-login` (basic) sets cookies (`routes.py:464`).
  - The SPA is not injected with the token in gated mode (`web_server_dashboard.py:160-200`).
  - WebSocket: `POST /api/auth/ws-ticket` (`routes.py:573`) mints a single-use ticket with a 30 s TTL (`ws_tickets.py:21`).
- Non-browser client (bb server):
  - V: `Authorization: Bearer <static token>` works for REST, both on loopback and through tailnet `https://$HERMES_HOST_TS.$TAILNET:8448` (200).
  - I: WebSocket `/api/ws?token=<static token>` passes `_ws_auth_ok`, which verifies `?token=` against session providers (`web_server_chat.py:215-230`). Not tested: an upgrade starts MCP discovery (`chat_ws.py:654-657`), which is a side effect.
  - Alternative: the native `/auth/native/{authorize,token,refresh}` (RFC 8252) flow mints rotating bearers via `basic`, so bb would not need the static token.
- Host check:
  - V (code): `host_header_middleware` (`web_server.py:349-366`) accepts only the bound host or a public_url host. bb must call `$HERMES_HOST_TS.$TAILNET:8448` (TLS by tailscaled) or go via $HERMES_HOST loopback.
  - The WebSocket Host check is repeated in `ws_host_origin_reason` (`web_server_boundary.py:251-282`). A missing Origin is allowed (non-browser).
- CORS: `_LocalOriginCORSMiddleware` (`web_server.py:568-582`) allows the own loopback origin, the Desktop dev renderer and public_url origins. Irrelevant for bb server-side calls; it blocks a bb **browser** UI from calling the dashboard directly (I).
- Implications:
  - The static token is full operator power: `/api/env/reveal`, `/api/fs/write-text`, shell via `/api/ws` `shell.exec`, git push, `POST /api/hermes/update`.
  - The bb server would hold a root-equivalent credential for $HERMES_HOST's Hermes. A companion plugin can't narrow the dashboard's main gate: any bearer that reaches the plugin also reaches everything else.
  - Restarts keep the token stable (from `auth.env`), but an orphan respawned by `hermes update` mints a random one (bootstrap.sh:109-120).

## 5. Dashboard plugin system

- Layout: `~/.hermes/plugins/<name>/dashboard/{manifest.json, dist/index.js, dist/style.css, plugin_api.py}` (extending-the-dashboard.md:427-445).
- Manifest fields (md:449-485): `name, label, description, icon (Lucide subset), version, tab{path,position,override,hidden}, slots[], entry, css, api`.
- Backend routes:
  - `api` file exports `router = APIRouter()`, mounted at `/api/plugins/<name>/` (md:726-748; `web_server_dashboard.py:1040,1060-1176`). Hot-mount happens on first request.
  - The runtime gate applies to "HTTP and WebSocket alike" (`web_server_dashboard.py:910-916`; `native_http.py:282`).
  - Handlers can import `hermes_state.SessionDB`, `hermes_cli.config` (md:763-787).
- Trust gate: a user plugin's Python is imported only if the plugin is in `plugins.enabled` (`web_server_dashboard.py:848-861`).
- Isolation: `plugins.isolation: in_process` (default; shares the event loop, so blocking stalls everything) or `host` (separate process, 504 after 60 s) (md:752-761).
- Per-profile discovery: profile `plugins/` dir, then root, then bundled (md:816-835). Rescan with `GET /api/dashboard/plugins/rescan`.
- UI: the IIFE calls `window.__HERMES_PLUGINS__.register(...)`, plus `registerSlot` for shell slots; `tab.override` can replace pages (md:495-720).
- Precedent (V): `~/.hermes/plugins/conduit_push/dashboard/manifest.json` (`"api":"plugin_api.py"`, hidden tab, `sessions:top` slot) is listed by `/api/dashboard/plugins` with `has_api`. The same directory carries `plugin.yaml` hooks (`pre_tool_call`, `post_llm_call`, `pre_approval_request`, `post_approval_response`, `on_session_end`, …).
- Feasibility for bb (I): a `bb_bridge` companion plugin could provide:
  - `GET /api/plugins/bb_bridge/sessions?since=<cursor>`: query `state.db` across profiles, ordered by `last_activity_at` / `transcript_revision`.
  - `WS /api/plugins/bb_bridge/events`: fan out from agent hooks (`plugin.yaml` hooks run in the **gateway** process too, so they see Discord and cron turns, which the dashboard alone cannot). Pairs with a dashboard-side relay.
  - `POST …/send` and `POST …/approve`: proxy to `/api/ws` `prompt.submit` / `approval.respond`, or to the gateway owner.
  - Cross-process: gateway-side hooks and dashboard-side routes are separate processes and need an IPC (file/sqlite/socket). This is the hard part.

## 6. Live probe (V, GET only, content redacted)

| Endpoint | Unauthed | Bearer | Latency | Notes |
|---|---|---|---|---|
| `/api/health` | 200 | – | 4 ms (tailnet 13 ms) | `{ok,version,displayVersion,commit,auth_required}` |
| `/api/status` | 200 | 200 | 37–68 ms | gateway multiplex, platforms all `connected` |
| `/api/auth/providers` | 200 | – | 2 ms | `[{name:"basic",supports_password:true}]` |
| `/api/dashboard/plugins` | 200 | 200 | 2 ms | 3 plugins |
| `/api/auth/me` | – | 200 | 4 ms | provider `session-token` |
| `/api/sessions?limit=…` | 401 | 200 | 17 ms (tailnet 21 ms) | `limit=2` returned 3 rows, `limit=1` returned 2 (I: lineage/compression grouping) |
| `/api/profiles/sessions?profile=all&limit=100` | 401 | 200 | 35 ms | total 433; per-profile totals default 271 / alex 131 / david 22 / neo 7 / todoist 2 |
| `/api/profiles/sessions/sidebar` | – | 200 | 71 ms | 351 KB |
| `/api/sessions/{id}`, `/messages`, `/timeline` | – | 200 | 6–13 ms | shapes in §3 |
| `/api/sessions/search?q=test` | – | 200 | 10 ms | |
| `/api/profiles`, `/api/profiles/active` | 401 | 200 | 2–23 ms | 5 profiles, all `gateway_running` |
| `/api/messaging/platforms` | – | 200 | 522 ms | 32 platforms |
| `/api/cron/jobs` | – | 200 | 8 ms | 5 jobs |
| `/api/model/info`, `/api/model/options` | 200 / – | 200 | 8 / 257 ms | |
| `/api/analytics/usage`, `/api/logs`, `/api/skills`, `/api/tools/toolsets`, `/api/chat/workspaces`, `/api/config`, `/api/env` | – | 200 | 5–68 ms | `env` values redacted server-side |

- The 100 most-recent rows by source: acp 53, cron 25, oneshot 10, desktop 4, local 3, discord 3, tui 2. Active 0, pinned 1, unread 0.
- `/api/sessions/stats` `by_source` also lists `cli` and `api_server`.
- Not probed: any WebSocket (an upgrade has side effects) and any write.

## 7. Multi-profile (V unless marked)

- One dashboard process serves every profile.
  - REST `?profile=<name>` was tested (`/api/sessions?profile=alex` → 200).
  - `/api/profiles/sessions` opens each profile's `state.db` directly (`profiles.py:463-466`).
  - JSON-RPC methods take `profile`, and `@_profile_scoped` binds home + secrets + terminal scope (`tui_gateway/AGENTS.md`, "Profile scope").
  - The `/api/ws` socket gets `profile_scope:'host'` (`chat_ws.py:675-678`).
- Profiles: `default, alex, david, neo, todoist`. `bot_title`/`display_name` are absent on all of them.
- Gateway: one multiplex process. `gateway_shared_with` lists all 5 profiles. Platforms are keyed `discord`, `alex:discord`, `david:discord`, `neo:discord`, plus `api_server`. todoist has no platform.
- "Bot" = a profile with a connected gateway platform (I). There is no separate bot API. `/api/profiles` exposes `bot_title` and `gateway_running`, and `/api/status.gateway_platforms` gives per-profile platform state.
- `POST /api/profiles/active` switches the default profile globally (a write). bb should pass `profile=` per request instead.

## 8. Gaps vs product goals

1. **Every session on the bb home page.**
   - Feasible with REST polling of `/api/profiles/sessions?profile=all&order=recent`. It has `is_active`, `pinned`, `archived`, `unread`, `title`, `preview`, `source` and `last_activity_at`.
   - Gap: no change cursor or delta feed.
   - Options: poll and diff on `runtime_revision`/`transcript_revision`; subscribe to `sessions.changed` over `/api/ws` (state.db content signature, about 0.5 s poll, ≥2 s floor; `change_watcher.py:278-289,381-395`, served homes only); or have the companion plugin add a cursor.
   - `is_active` is a 300 s heuristic, not a live "agent running" flag. `session.active_list` / `session.resume.running` are live only for dashboard-hosted sessions (I).
2. **Opened threads behave like bb agent threads.**
   - For sessions hosted by the dashboard backend: `/api/ws` gives full streaming, tool events, approvals and interrupts.
   - For gateway-owned sessions (Discord, cron, api_server): a standalone dashboard ("legacy serve backend") forwards `prompt.submit` to the owner gateway and relays frames **only for that admission** (`tui_gateway/owner_forward.py:1-17`). Turns started on Discord are not live-streamed to dashboard clients; they appear as transcript updates (I).
   - Live view of those turns needs the gateway's native `hermes-gateway-v1` listener (ephemeral port, ticketed via `gateway.sock`, loopback only) or companion-plugin hooks in the gateway.
3. **No machine/harness picker.** Not a dashboard concern; bb-side.
4. **Profile picker.** `/api/profiles` + `profile=` param, fully supported.
5. **Chat per bot.**
   - No bot entity: model each profile-with-platform as a bot.
   - The "bot chat" is the profile's gateway-owned session (`session_key`/`chat_id`/`origin_json` on rows), which hits the gap in goal 2.
6. **Settings page.** REST covers config, model options, toolsets, skills, cron, platforms, env (redacted), usage and logs. Write endpoints exist but are high-privilege.
7. **Auth / security.**
   - The only verified non-browser credential is the static deployment token, which grants full host power.
   - A plugin route cannot reduce that, because the gate is global.
   - Native RFC 8252 tokens via `basic` rotate but carry the same power (I).

## Gaps and risks

- Static bearer = root-equivalent on $HERMES_HOST Hermes (env reveal, fs write, shell, git push, update). Storing it on $BB_SERVER_TS widens the blast radius.
- Hermes is a fast-moving canary fork (481 commits past 0.22.6, "June 2026 hermes-0day" auth changes at `web_server.py:998`). Route and auth shapes drift, and `hermes update` can respawn an orphan dashboard with a random token (bootstrap.sh:109-120).
- WebSocket `?token=` auth on `/api/ws` is INFERRED from code; I didn't test it.
- Gateway-originated turns cannot be live-streamed through the standalone dashboard (I, from `owner_forward.py` docstring and `session_authority=None` outside `gateway/run_api.py:97`).
- `sessions.changed` covers only the watcher home plus "served" profiles, which may miss profiles the dashboard hasn't hosted yet (I).
- In-process plugin handlers share the dashboard event loop. A buggy companion plugin can stall the dashboard, so use `plugins.isolation: host` or async-only code.
- The tailnet path depends on `tailscale serve :8448` staying configured. It is not managed by nix (bootstrap.sh `serve`, run manually).
- I didn't confirm whether a tailnet ACL lets $BB_SERVER_TS reach $HERMES_HOST:8448. Ping works.
- `/api/sessions?limit=N` returned N+1 rows (I: lineage grouping). Paging logic must not assume an exact page size.
- `POST /api/cron/fire` is public (no auth). Unrelated to bb, but notable.

## Open questions for the user

- Is giving $BB_SERVER_TS the static `HERMES_DASHBOARD_SESSION_TOKEN` acceptable? The alternatives are a dedicated basic-auth login via the native token flow (still full power) or a companion plugin with its own narrower token (needs Hermes core support or a separate listener).
- Must Discord/cron turns stream live inside bb, or is "updates when the turn completes" enough? Live streaming means a gateway-side companion plugin or the native gateway WebSocket, not just the dashboard.
- Should a "bot" map 1:1 to a profile with a connected platform (alex, david, neo, default), or to a specific platform chat (`chat_id`) within a profile?
- Should bb-created Hermes chats run in the dashboard backend (`/api/ws session.create`) or in the gateway (owner FIFO, same place as Discord)? This decides which process owns them.
- OK to require `plugins.isolation: host` for the companion plugin?

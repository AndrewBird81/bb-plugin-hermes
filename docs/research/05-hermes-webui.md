# 05 — hermes-webui evaluation

Scope: `~/src/hermes-webui` @ `e168b67e` (tag `exp-v0.52.264`, 2026-08-25), upstream `nesquena/hermes-webui`, MIT. Hermes agent checkout `~/.hermes/hermes-agent` @ `c314285f07` (2026-11-03). Read-only; GET probes only.

## Key answers

1. **Architecture / running?**
   - VERIFIED: Python stdlib `ThreadingHTTPServer` + vanilla JS; **imports hermes-agent in-process** (`AIAgent.run_conversation`, `tools.approval` module state) by default (`ARCHITECTURE.md:122-170, 298-358`). No dashboard use for chat; dashboard (9119) is only probed for status (`api/dashboard_probe.py:1-20`).
   - VERIFIED: **This install is not in default mode.** launchd `ai.hermes.webui` (pid 61135, `127.0.0.1:8787`) sets `HERMES_WEBUI_CHAT_BACKEND=gateway`, `HERMES_WEBUI_GATEWAY_BASE_URL=http://127.0.0.1:8642`, `HERMES_WEBUI_GATEWAY_USE_RUNS_API=true` → chat is delegated to the **Hermes gateway API server Runs API** (`api/gateway_chat.py:151-153, 257-311, 563-774`). Fronted by tailscale serve; password auth required (`~/src/hermes-host/bin/hermes-webui`).
2. **API**: cookie-auth JSON + SSE. Sessions `/api/sessions`, `/api/session[/new|/rename|/pin|/archive|/delete|/import_cli|/stream]`; chat `POST /api/chat/start` → `GET /api/chat/stream` (SSE: `token`, `reasoning`, `tool`, `tool_complete`, `approval`, `done`, `error`, `cancel`); `/api/chat/cancel|steer`; approvals `/api/approval/pending|respond|stream`; clarify `/api/clarify/pending|respond|stream`; profiles `/api/profiles`, `/api/profile/active|switch|create|delete`; auth `/api/auth/*` (password, OIDC, passkeys; no bearer token) — VERIFIED (`api/routes.py`, `api/auth.py:61, 1075`).
3. **Foreign-session discovery**: VERIFIED — read-only SQLite on the active profile's `state.db` (`file:…?mode=ro`, `api/agent_sessions.py:10-50`), daemon thread polls every 5 s with a cheap fingerprint, pushes `sessions_changed` over `GET /api/sessions/gateway/stream` (`api/gateway_watcher.py:1-10, 45-130, 189`; `api/routes.py:14391, 19286-19336`). Opening one **copies** messages into a WebUI JSON sidecar (`/api/session/import_cli`, `api/routes.py:28208-28300`, `api/models.py:6737-6770`) with prefix-match refresh. Per-profile watchers; `all_profiles` mode exists.
4. **Features vs dashboard needed by us**: full chat UX, approval + clarify cards, multi-profile, compression-chain collapsing, source labels (Telegram/Slack/CLI/cron…), pin/archive/projects, resumable stream journal. **No "bot" concept** (grep: no `/p/<profile>`, no Bot Chat) — VERIFIED.
5. **Reusable**: MIT. Best lifts: Runs-API SSE translator (`gateway_chat.py:431-774`), approval-event mapping (`:525-561`), `state.db` projection + lineage collapse (`agent_sessions.py:365-530`), cheap change fingerprint (`gateway_watcher.py:45-130`), source label table (`agent_sessions.py:~55-76`).
6. **Verdict**: don't use webui as backend. Its own live path here is already "webui → gateway API server `/v1/runs`"; bb should talk to that layer (or a companion plugin) directly. Webui adds a second session store, cookie auth, process-global profile switching, and a 30k-line `routes.py`. Mine it for ideas/code only.

## 1. Architecture (detail)
- VERIFIED `ARCHITECTURE.md:122-170`: runs in hermes-agent venv; `sys.path.insert` of agent dir; per-request `HERMES_HOME`, `HERMES_SESSION_KEY`, `TERMINAL_CWD` env vars are **process-global** ("Two concurrent chat requests will clobber each other").
- VERIFIED `ARCHITECTURE.md:257-297`: `POST /api/chat/start` spawns daemon thread + `queue.Queue`; `GET /api/chat/stream?stream_id=` relays; 30 s heartbeat.
- VERIFIED `api/runtime_adapter.py:1-27`: `HERMES_WEBUI_RUNTIME_ADAPTER` = `legacy-direct|legacy-journal|runner-local`; live chat still on legacy path (in-flux refactor, issue #1925).
- VERIFIED `api/runner_client.py:55-104`: a separate "runner" HTTP contract (`/v1/runs/{id}/cancel`, `/approval`, `/clarifications/{id}/respond`, `/messages`, `/v1/sessions/{id}/goal`) — **does not match** the Hermes gateway's routes (`/stop`, `/clarify`, `/steer`; `gateway/platforms/api_server_runs.py:286-292`). Off by default.
- VERIFIED process/ports here (`lsof`, `launchctl list`):
  - `ai.hermes.webui` → `127.0.0.1:8787`
  - `ai.hermes.dashboard` → `127.0.0.1:9119`
  - `ai.hermes.gateway` → `127.0.0.1:8642` (API server) + `58355`
- VERIFIED `GET :8787/health` 200 (keys: `status, sessions, active_streams, active_runs, runs, …`); `GET /api/auth/status` → `auth_enabled: true, password_auth_enabled: true, oidc/passkeys: false`; other `/api/*` → 401 without cookie.
- VERIFIED secrets: `HERMES_WEBUI_PASSWORD` present (from `~/.config/hermes-host/auth.env`); `HERMES_WEBUI_GATEWAY_API_KEY` present (taken from `API_SERVER_KEY` in `~/.hermes/.env`). Values not read.
- VERIFIED state dir `~/.hermes/webui/`: 11 session sidecars, `settings.json`, models cache.

## 2. Gateway Runs API as webui uses it (most relevant finding)
- VERIFIED `gateway_chat.py:563-650`:
  - `POST {gw}/v1/runs` headers `Authorization: Bearer <API_SERVER_KEY>`, `X-Hermes-Session-Id: <sid>`, `X-Hermes-Session-Key: webui:<sid>`
  - body `{model, input, session_id, instructions?, conversation_history?, …extras}` → `{run_id}`
- VERIFIED `:652-774`: `GET {gw}/v1/runs/{run_id}/events` SSE; event names consumed:
  - `message.delta` `{delta}`
  - `tool.started` / `tool.completed` `{tool|name, toolCallId, args, label|preview, status, error}`
  - `reasoning.available`
  - `approval.request` `{approval_id, tool, command, description, pattern_key(s), risk_level, choices, allow_permanent}`
  - `run.completed` `{output, usage, error?}`, `run.failed`, `run.cancelled`; `[DONE]`
- VERIFIED `:776-790`: stop = `POST /v1/runs/{id}/stop`. Approval response via `/v1/runs/{id}/approval` `{choice, approval_id}` (`runner_client.py:82-86`, matches gateway route).
- VERIFIED `api/config.py:9319-9337`: gates approvals on `GET /v1/capabilities` flags `approval_events`, `run_approval_response`, `approval_identity_v1`.
- VERIFIED: webui gateway mode does **not** relay clarify (no `clarify` in `gateway_chat.py`), though gateway exposes `POST /v1/runs/{run_id}/clarify` (`api_server_runs.py:289`).
- VERIFIED gateway also exposes `/api/sessions/{id}`, `/messages`, `/fork`, PATCH/DELETE (`gateway/platforms/api_server.py:74-78`), `/p/<profile>/` prefix routing (`api_server_profile_prefix.py:1-30`) and a per-profile **Bot Chat** (`api_server_bot_chat.py:1-10`). Webui uses none of these.
- VERIFIED `GET :8642/v1/health` 200 unauthenticated (`platform, status, version`); `/v1/capabilities` 401 without key.

## 3. Session discovery/sync (detail)
- VERIFIED `agent_sessions.py:498-530`: `read_importable_agent_session_rows(db_path, limit=200, exclude_sources=("cron","webui"))`; skips empty rows; oversamples `limit*8`; re-adds subagent parents.
- VERIFIED `agent_sessions.py:365-380`: compression chains (`parent_session_id`) collapsed into one logical row; import uses latest segment.
- VERIFIED `ARCHITECTURE.md:239-256`: interactive window 20 rows; cron/webhook/kanban recovered in separate bounded passes.
- VERIFIED `gateway_watcher.py:45-130`: fingerprint = hash of sessions-table columns (`id, source, title, model, message_count, started_at, ended_at, end_reason, parent_session_id, archived, user_id, chat_id, thread_id, session_key, platform…`) + per-session `COUNT/MAX(messages.timestamp)` (index-covered).
- VERIFIED `routes.py:28208-28300`: import refresh only extends when existing messages are a prefix of `state.db` messages (protects hybrid sessions); subagent children forced `read_only`.
- INFERRED: "running" state of a Telegram/cron session is only observable as `state.db` growth (5 s lag); no live token stream for runs not started by webui.
- INFERRED: two stores (webui JSON + `state.db`) can diverge; webui has many recovery/tombstone modules (`session_recovery.py`, `compression_recovery.py`) — a sign this is hard.

## 4. Features vs our goals
| Goal | webui | Note |
|---|---|---|
| 1 all sessions on home | yes, via `state.db` poll | per-profile, 5 s |
| 2 streaming/tools/approvals | yes | clarify not in gateway mode |
| 3 no machine/harness picker | n/a | |
| 4 profile picker | yes, process-global switch | `profiles.py:1-10` mutates `os.environ['HERMES_HOME']` + monkey-patches agent modules |
| 5 chat per bot | **no** | gateway Bot Chat exists, unused |
| 6 settings | huge Control Center | far beyond "basic" |

## 5. Reusable ideas/code (MIT, © 2025 Hermes Web UI Contributors — keep notice if copied)
- Runs-API client + SSE→UI event translation (`gateway_chat.py:431-774`) — maps directly onto bb thread events.
- Approval payload normalizer (`gateway_chat.py:525-561`) + capability gating (`config.py:9319-9337`).
- Read-only `state.db` open pattern + compression-lineage collapse (`agent_sessions.py:10-50, 365-530`).
- Cheap change fingerprint for polling (`gateway_watcher.py:45-130`) — usable in a companion Hermes plugin to emit session-list events.
- Source labels table (`agent_sessions.py:~55-76`) for bb thread badges.
- Prefix-match refresh rule for hybrid sessions (`routes.py:28245-28255`).
- Python; bb plugin language may differ → port logic, not files.

## 6. Verdict
- **webui as backend — not recommended.**
  - Gain: working session list, approvals, profiles today.
  - Lose: extra hop (bb → webui → gateway), cookie/password login flow for a machine client, duplicate session store, process-global profile state (no concurrent multi-profile), no bots, a fast-moving codebase (30k-line `routes.py`, internal APIs churn).
- **Dashboard (9119)** — not assessed for chat here (other lanes). Webui does not use it for chat.
- **Recommended: gateway API server (8642) Runs API + `/api/sessions` + `/p/<profile>/` + Bot Chat, plus a thin companion Hermes plugin for push events (session created/updated/run state) instead of polling `state.db`.** Webui's own production path here already proves Runs API streaming/approvals work on this host.

## Gaps and risks
- Did not log in to webui; `/api/sessions` response shape read from code only.
- Did not verify gateway `/v1/runs` behaviour live (no prompts allowed); event names come from webui consumer code, not gateway source.
- Gateway API server binds `127.0.0.1:8642`; bb server is remote — needs tailscale serve/proxy (not checked here).
- Runs API YOLO/session-approval not native (`gateway_chat.py:373-395`, hermes-agent PR #61946).
- `runner_client.py` endpoints mismatch gateway; don't copy that file as-is.
- Webui on this host is a launchd service with password auth; nix-config `home/services/hermes.nix` not read in this lane.

## Open questions for the user
- OK to target the gateway API server (8642) rather than the dashboard for chat/run streaming? It needs `API_SERVER_KEY` shared with bb.
- Keep hermes-webui running alongside bb, or retire it once bb covers chat? (Affects whether bb must coexist with `webui:<sid>` session keys.)
- Is "bot" = Hermes profile Bot Chat (`api_server_bot_chat.py`)? If so, webui has nothing to reuse for goal 5.

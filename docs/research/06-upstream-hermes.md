# 06 — Upstream Hermes Agent: interfaces, profiles/bots, clients (as of 2026-11-04)

Labels: **[D]** direct evidence (quoted/paraphrased from cited source) · **[I]** researcher inference · dates are source dates.
Local install: `c314285f07` (2026-11-03), same day as tag v0.22.7 (2026-11-03). [I] Upstream docs below should match it closely; unverified against local source.

## Key answers

1. **Dashboard / plugins / remote / profiles**
   - [D] `hermes dashboard` (browser UI) and `hermes serve` (headless) boot the *same* `web_server.start_server` on :9119; REST under `/api/*`, JSON-RPC WebSocket `/api/ws`, PTY `/api/pty`, `/api/events` sidebar feed. Dashboard plugins can add **both UI (tabs, slots) and FastAPI routes** under `/api/plugins/<name>/`, behind dashboard auth.
   - [D] Dashboard is **machine-level, multi-profile** (`?profile=<name>` switcher). Remote access is official: non-loopback bind requires an auth provider (basic user/password, Nous Portal OAuth, custom OIDC); WebSocket auth is a single-use ticket.
2. **Programmatic chat interfaces**
   - [D] Three documented protocols: ACP (stdio), TUI-gateway JSON-RPC (stdio or WebSocket), API server (HTTP+SSE, :8642). Since PR #106742 (merged 2026-10-14) **one gateway process owns every local session**; the API server **cannot bind sessions owned by other surfaces** (409 `permission_denied`) and docs say to use the gateway WebSocket (`prompt.submit`) for those.
   - [D] `/v1/capabilities` is the "stable surface" discovery endpoint; runs API has status/events/approval/clarify/steer/stop. `hermes mcp serve` is now "the mcp-serve plugin" (CLI reference).
3. **Profiles / bots**
   - [D] Profile = isolated `HERMES_HOME` under `~/.hermes/profiles/<name>/`. Upstream distinguishes **Bot Mode bot** (a profile in the Desktop roster with avatar + one canonical persistent "Bot Chat"), **messaging bot** (platform account/token), and subagent. One multiplexing gateway per host serves all profiles (default-on since 2026-09-16; standalone only via `--force`).
4. **Conduit / Desktop**
   - [D] Hermes Conduit is a **third-party** iPhone/iPad/Watch app (kaishi00, "not affiliated with Nous") that signs into the **Hermes dashboard (:9119)**; optional host plugin "Hermes Conduit Notifier". Its "Bot Chats" and "rooms" are UIs over upstream Bot Mode (Bot Chats; gateway-hosted Group Chats).
   - [D] Official **Hermes Desktop** (Electron) has remote mode (Settings → Gateways: Remote URL + sign-in, SSH, Hermes Cloud) and multi-connection rosters.
5. **Recent/upcoming changes that matter** — unified gateway runtime (#106742, Oct 14), forced profile multiplexing (#109417, closed Sep 21), `sessions.changed` change-broadcasts (#73673, Jul 28), replay spool for reconnect (#143711, open Oct 23), mutation-identity fences on session REST, `client.capabilities {"server_requests": true}` now mandatory for WS clients to answer approvals.
6. **IDE/hub integrations** — [D] Zed/VS Code/JetBrains via `hermes acp`. **bb itself already ships `acp-hermes-agent`** (get-bb/bb #552, 2026-07-08). Lessons: capability declarations and replay-before-respond on `session/load` broke Zed until fixed.
7. **bb provider docs** — [D] Yes: `docs/provider-plugin-api.md` and `docs/provider-bridge-protocol.md` in github.com/get-bb/bb (`bb.providers.register`, `experimental_defineProviderBridge`, ACP kit). getbb.app/plugin-guide exists (fetch failed).

## 1. Dashboard capabilities and API

- [D] Pages: Status, Chat (embedded `hermes --tui` over PTY), Sessions (filter Chats/Automation/All by source incl. telegram/discord/cron/api/acp; live-session pulsing badge; FTS search; rename/export/delete), Config, API Keys, Logs, Analytics, Cron, Profiles, Skills, MCP, Webhooks, Pairing, Channels, System. https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard
- [D] REST: `GET /api/status` (public; reports `auth_required`, `auth_providers`), `GET /api/sessions` (20 most recent), `GET /api/sessions/{id}`, `GET /api/sessions/{id}/messages` (`limit`≤500, `offset`, `order=oldest|latest`), `GET /api/sessions/search?q=`, `GET /api/sessions/stats`, `PATCH /api/sessions/{id}`, `GET /api/sessions/{id}/export`, `DELETE /api/sessions/{id}` (needs mutation identity from `GET /api/sessions/{id}/mutation-snapshot`, else 409), `GET /api/chat/workspaces`. Bulk delete/prune return 409 while a gateway owns the store. (same page)
- [D] Management endpoint families (`/api/config`, `/api/env`, `/api/skills`, `/api/mcp`, `/api/model/...`) are profile-scoped. (same page)
- [D] Auth: loopback uses a per-process session token (`window.__HERMES_SESSION_TOKEN__`; REST header `X-Hermes-Session-Token`, WS `?token=`); gated mode rejects `?token=` and uses `/api/auth/ws-ticket` single-use tickets. Token regenerates each restart unless `HERMES_DASHBOARD_SESSION_TOKEN` is pinned (PR #38534). https://github.com/NousResearch/hermes-agent/blob/5e01a5db/web/src/lib/gatewayClient.ts, https://github.com/NousResearch/hermes-agent/pull/38534
- [D] `--insecure` is now deprecated/no-op; public bind always requires an auth provider. Auth provider plugins: `ctx.register_dashboard_auth_provider()`. (web-dashboard page; https://hermes-agent.nousresearch.com/docs/developer-guide/plugins)
- [D] Dashboard plugin = `~/.hermes/plugins/<name>/dashboard/{manifest.json, dist/index.js, plugin_api.py}`; one plugin dir can also carry a CLI/gateway plugin (`plugin.yaml`, `__init__.py`). UI uses `window.__HERMES_PLUGIN_SDK__` (React, components, `api.getSessions`, `fetchJSON` with auth). Routes mounted at `/api/plugins/<name>/`; rescan via `GET /api/dashboard/plugins/rescan`. Kanban plugin shows a plugin WebSocket (`/events?token=`) pattern. https://hermes-agent.nousresearch.com/docs/user-guide/features/extending-the-dashboard, https://github.com/NousResearch/hermes-agent/blob/72ff3e90/plugins/kanban/dashboard/plugin_api.py
- [D] Plugins can observe group-room member activity via hook `on_room_member_activity`. https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode
- [I] A companion Hermes plugin can expose bb-specific REST/WS routes inside the dashboard process with no core patch — viable for a "sessions firehose" endpoint.

## 2. Programmatic chat interfaces

### Gateway WebSocket / TUI-gateway JSON-RPC (richest; what Desktop uses)
- [D] Methods incl. `session.create/list/active_list/activate/resume/close/interrupt/history/branch/title/usage/status`, `prompt.submit`, `session.steer`, `commands.catalog`, `client.capabilities`, `gateway.capabilities`. Events: `message.delta`, `message.complete`, `tool.start`, `tool.generating`, `tool.complete`, `status.update`, `gateway.ready`, … https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration
- [D] Approvals/clarify/sudo/secret are **server→client JSON-RPC requests**; WS clients must call `client.capabilities {"server_requests": true}` after `gateway.ready` or every such request is refused immediately (breaking change for 3rd-party WS clients). (same page)
- [D] Multiple viewers can attach to one live session (`session.resume`); approvals are shared — "answer in any window and every viewer settles". https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-local-sessions, https://github.com/NousResearch/hermes-agent/pull/106742
- [D] Reconnect: every event frame has per-session `seq`; `session.events.since` replays from a bounded ring (512 events/session, 64 sessions) with `replay_epoch`, `truncated`, generation; durable spool fix still an open PR. https://github.com/NousResearch/hermes-agent/pull/98800, https://github.com/NousResearch/hermes-agent/pull/143711
- [D] Global broadcasts `sessions.changed` (state.db write from any process, ≥2s floor), `cron.changed`, advertised via `change_events` on `gateway.ready`. Merged 2026-07-28. https://github.com/NousResearch/hermes-agent/pull/73673
- [D] Native local attach: `hermes gateway ensure --json` → endpoint; WS subprotocols `hermes-gateway-v1` + `hermes-gateway-ticket.<ticket>`; tickets minted on a **same-user private control socket**, 30 s, single use; native HTTP uses `X-Hermes-Gateway-Ticket`. https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-internals, https://raw.githubusercontent.com/NousResearch/hermes-agent/main/apps/desktop/src/AGENTS.md
- [D] Stability: docs call this protocol documented for "custom desktop / web / TUI hosts", but it changes fast (canonical vs legacy `/api/ws`, desktop contract versions v2–v4). [I] Treat as semi-stable; pin to `gateway.capabilities`/protocol strings.

### API server (:8642)
- [D] `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/capabilities`, `/v1/runs` (+ `/{id}`, `/events` SSE, `/approval`, `/clarify`, `/steer`, `/stop`, `/resolve-unknown`), `/api/sessions/{id}/chat` and `/chat/stream`, `/api/model/options`, `/api/jobs`, `/health`, `/health/detailed`. Bearer `API_SERVER_KEY`. https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server, https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/api_server.py
- [D] Run SSE events: `message.delta`, `message.interim`, `tool.started`, `tool.completed` (preview ≤500 chars, redacted), `reasoning.available`, `approval.request`, `subagent.start/complete`, `run.completed` (usage + runtime), `run.failed`/cancelled; `: keepalive` every 10 s; buffers expire 5 min. (api-server page; commit https://github.com/NousResearch/hermes-agent/commit/cc2b56b26a9f61c451c022b865f2a87d18c505ec)
- [D] Headers: `X-Hermes-Session-Id` (continuity), `X-Hermes-Session-Key` (conversation key); `Idempotency-Key` durable (runs: 24 h). Capability flags include `session_chat_streaming`, `session_fork`, `approval_events`, `run_steer`; `admin_config_rw:false`. (api_server.py)
- [D] **Sessions owned by CLI/TUI/Desktop/ACP/messaging cannot be driven via the API server** (409 `permission_denied`). Multiplex: `/p/<profile>/v1/...` with that profile's own `API_SERVER_KEY`. (api-server page)

### ACP (`hermes acp`)
- [D] Streams messages, thoughts, tool calls, diffs, terminal, permission requests; advertises session list/load/resume/fork; sessions persisted in `state.db`; ACP restore only for rows with `source == "acp"`. https://hermes-agent.nousresearch.com/docs/user-guide/features/acp, https://github.com/NousResearch/hermes-agent/blob/main/acp_adapter/session.py
- [D] Post-#106742 ACP is "a transport-only client" of the gateway: load/prompt/cancel/permissions share the canonical session; "disconnecting the editor never denies a pending approval". (PR #106742)

### MCP serve
- [D] Exposes messaging conversations as MCP tools (`conversations_list`, `messages_read`, `events_poll/wait`, `messages_send`, `permissions_list_open/respond`); polls DB internally; now packaged as the `mcp-serve` plugin. https://github.com/NousResearch/hermes-agent/blob/659d1123/mcp_serve.py, https://hermes-agent.nousresearch.com/docs/reference/cli-commands

## 3. Profiles, multi-agent, "bots"

- [D] Profiles: own config, `.env`, `SOUL.md`, memory, sessions (`state.db`), skills, cron. "Every Bot is a profile, but not every profile is a Bot"; a profile becomes a Bot when Bot Mode stores roster metadata (title, avatar, section, hidden) and pins its canonical Bot Chat. https://hermes-agent.nousresearch.com/docs/user-guide/profiles
- [D] Bot Mode: one permanent Bot Chat per Bot (`/new` compacts instead of forking); bot-to-bot DMs; Group Chats (2–6 bots, up to 3 rounds, `@mentions`, `@user` escalation); room state in root `shared-state.db`; each member's room session is an ordinary session titled `Group: …`. Cross-machine via `hermes peer`. https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode
- [D] Multiplexing gateway serves all profiles; per-profile isolation of secrets/sessions; profile routing by platform/guild/channel/thread. https://hermes-agent.nousresearch.com/docs/user-guide/multi-profile-gateways, https://github.com/NousResearch/hermes-agent/issues/109417
- [D] Maintainer position (2026-09-19): "we do not treat profiles as isolation". (#109417)
- [I] Our "dedicated chat per bot" maps directly to upstream's canonical Bot Chat; reuse it instead of inventing a bb-side session.

## 4. Conduit and other clients

- [D] Conduit (https://github.com/kaishi00/hermes-conduit, App Store id6790977764): native SwiftUI; "signs in to the Hermes dashboard you run"; Bots Home, Bot Chats, gateway-hosted group chats/rooms, Kanban, cron, multiple dashboards/profiles; Notifier plugin (https://github.com/kaishi00/hermes-conduit-notifier) adds push, voice, cards. Setup FAQ: `hermes webapp` (:9120) works for one profile; Bot Chats in other profiles need the dashboard. https://hermesconduit.app/setup/
- [D] Herald: another 3rd-party mobile client, connects through `hermes serve`. https://heraldapp.dev/compare/herald-vs-hermes-conduit
- [D] hermes-webui (nesquena, :8787): community Python/vanilla-JS UI, runs the agent in-process; multi-profile. https://github.com/nesquena/hermes-webui
- [I] Conduit is the closest precedent for our design: dashboard-as-transport + small companion host plugin.

## 5. Recent changes affecting us

- [D] #106742 (merged 2026-10-14): one gateway owns every local session; durable admissions FIFO; revision-checked mutations; ACP/API/CLI/TUI/Desktop become clients. **Follow-up explicitly not in that PR: "The browser dashboard and Desktop URL, Cloud and SSH modes stay on standalone `hermes serve`, which keeps its own agent and writes the store."** https://github.com/NousResearch/hermes-agent/pull/106742
- [D] Issue #58671 (OPEN, 2026-07-05): gateway/cron turns never reach dashboard WS clients as events; consumers poll SQLite. Partially addressed by `sessions.changed` nudges (#73673). https://github.com/NousResearch/hermes-agent/issues/58671
- [D] Releases are frequent patch roll-ups (v0.22.4 2026-10-21 … v0.22.7 2026-11-03); "full curated notes … ship with v0.23.0". https://github.com/NousResearch/hermes-agent/releases
- [D] Remote dashboard session refresh fixes (v0.21.3, 2026-09-14); downgrade past the unified-runtime cutover unsupported (#106742).

## 6. Existing IDE / hub integrations

- [D] bb: `acp-hermes-agent` provider launching `hermes acp`, with `nativeReasoning` via `session/set_config_option` (get-bb/bb #552, 2026-07-08); skills delivered via session instructions (#559); PATH-detection fix for `~/.local/bin/hermes` (#1389); fork kept "tip" because Hermes advertises `sessionCapabilities.fork` (#2150). https://github.com/get-bb/bb/commit/1b0a174f60b68d773d50d42027f178fb3f2882ad, https://github.com/get-bb/bb/commit/2ad4bfaae426417bf86c143a04bf5465656ffc65
- [D] bb ACP V1 caveats: permissions are cooperative; steer emulated by chaining prompts; resume uses `session/load` if advertised. https://github.com/get-bb/bb/commit/bafc727859e004d2b322091a8225e9b8a37985e5
- [D] Zed lessons: Hermes failed to declare `loadSession` (issue #6633, fixed #6985, Apr 2026); history replay deferred after `session/load` response broke spec clients (fixed by awaiting replay). https://github.com/NousResearch/hermes-agent/issues/6633, https://github.com/NousResearch/hermes-agent/pull/6985
- [I] ACP gives bb-native threads cheaply but only for sessions bb creates; it does not surface gateway/cron/messaging sessions.

## 7. bb provider plugin docs

- [D] `bb.providers.register({...capabilities, models, deriveProviderOptions})` on server; bridge in `bb.host` artifact via `experimental_defineProviderBridge({handleLine, start, onClose})`, line-delimited JSON-RPC, `thread/delta` grammar; conformance kit in `@get-bb/plugin-sdk/provider-bridge/testing`. "Zero first-party privilege." https://github.com/get-bb/bb/blob/main/docs/provider-plugin-api.md, https://github.com/get-bb/bb/blob/main/docs/provider-bridge-protocol.md
- [D] Custom ACP agents via `provider-acp` `customAgents` setting. https://github.com/get-bb/bb/blob/main/docs/configuration.md
- [D] Third-party summary (not official): https://nobilix.github.io/bb-plugin-atlas/advanced/providers/

## Contradictions

- [D] TUI doc says the API server "does not serve `/api/ws`" and there is no "point any TUI at any standalone gateway" mode (https://hermes-agent.nousresearch.com/docs/user-guide/tui) vs Desktop/gateway-internals docs: Desktop dials the gateway's `/api/ws` after `gateway ensure`. [I] TUI page likely predates #106742; the gateway listener now hosts `/api/ws` (port not confirmed).
- [D] Multi-profile-gateways page still says "the Desktop app spawns its own per-profile `hermes serve` backend" vs Desktop page "needs no separate `hermes serve`". [I] Stale doc.
- [D] Docs call `/api/ws` "legacy" for dashboard Chat; #106742 review lists "Legacy `/api/ws` … every reconnect replay refused (`replay_epoch`)" (N163) — status unknown.

## Gaps and risks

- **Dashboard ≠ session owner (risk: high).** Per #106742 the dashboard/`hermes serve` still runs its own agent; "one writer per store" holds only for local gateway surfaces. Driving chats through :9119 `/api/ws` may create a second writer or diverge from gateway-owned sessions. Verify on `c314285f07` whether `hermes serve` now attaches to the gateway.
- **Live status for external sessions.** No documented cross-process event firehose; `sessions.changed` is a nudge only. [I] Live tool-call streaming for Telegram/cron sessions likely needs either the gateway WS (`session.resume` as viewer) or a companion plugin.
- **Gateway WS auth needs a same-user control socket.** [I] Fine for a bb host daemon on the same machine; remote needs dashboard auth tickets. Port/path of the gateway listener not confirmed.
- **API server can't drive foreign sessions** (409) → unsuitable as the main transport for "open any Hermes session in bb".
- **Protocol churn.** Breaking changes landed without grace (`client.capabilities` requirement, mutation-identity 409s, desktop contract v2–v4). Gate on `gateway.capabilities`, `/v1/capabilities`, `desktop_protocol == "hermes-gateway-v1"`.
- **Replay is bounded** (512 events/session); mid-turn reconnect can miss in-flight output until #143711 lands.
- **Unverified:** ACP `session/list` scope (ACP-only vs all sources); exact `/api/ws` event schema post-cutover; whether dashboard plugins run inside the gateway process or only `serve`; getbb.app plugin-guide content (fetch failed).
- **Conduit internals** unread (2.5 GB repo); claims come from README/App Store/site only.

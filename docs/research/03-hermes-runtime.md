# 03 — Hermes runtime: session store and live-chat interfaces

Ground truth: `~/.hermes/hermes-agent` = NousResearch/hermes-agent `v0.22.6+canary.20261103T064339Z-14-gc314285f07` (commit `c314285f077e`, 2026-11-03). Launcher chain: `~/.local/bin/hermes` → `~/src/hermes-host/bin/hermes` → `~/.hermes/hermes-agent/.hermes/bin/hermes` (VERIFIED).
Service definitions: `AndrewBird81/nix-config` @ `77be95d7` — `home/services/hermes.nix` does **not** exist; the file is `modules/aspects/services/_hermes.nix` (VERIFIED).

## Key answers

1. **Session store**
   - One SQLite `state.db` per profile, in WAL mode: `~/.hermes/state.db` (default) and `~/.hermes/profiles/<name>/state.db`. `schema_version` = 32. FTS5 plus trigram FTS on messages. (VERIFIED)
   - Sessions here: 282 default, 131 alex, 24 david, 7 neo, 2 todoist. Sources include `acp, cli, discord, cron, desktop, local, api_server, oneshot, subagent, tui, a2a`. **The gateway platform here is Discord; Telegram and Slack are not configured.** (VERIFIED)
   - Active detection: `ended_at IS NULL` plus recent `last_activity_at` (the dashboard uses a 300 s window), or the canonical `running` flag (better). Change detection: `transcript_revision`, `runtime_revision`, `last_activity_at`, monotonic `messages.id`, WAL mtime. (VERIFIED)
2. **Live interfaces**
   - **Canonical gateway WebSocket** (`hermes-gateway-v1`, `/api/ws` on the gateway's loopback listener; a ticket comes from the `gateway.sock` control socket). This is the richest interface: create, resume, list, submit, interrupt, steer, approvals, clarify, event replay. (VERIFIED, source)
   - **ACP** (`hermes acp`): a thin viewer *over* that canonical gateway (`GatewayACPAgent`). (VERIFIED)
   - **API server** `127.0.0.1:8642`: `/v1/runs` SSE, `/api/sessions/*`, OpenAI routes, auth `API_SERVER_KEY`. (VERIFIED, probe)
   - **Dashboard** `127.0.0.1:9119` (tailnet `:8448`): REST `/api/sessions*` with Bearer, VERIFIED 200. Its `/api/ws` is the *legacy* tui_gateway dispatcher (this standalone dashboard has no session authority), plus `/api/pty`.
   - `hermes mcp serve` has left core; it is now plugin `mcp-serve` and is not installed. (VERIFIED)
3. **Approvals, clarify, interrupt**
   - Canonical WS: `approval.request` / `clarify.request` events → `approval.respond` / `clarify.respond`; `session.interrupt`. (VERIFIED)
   - ACP: `session/request_permission`, `elicitation/create` for clarify, `session/cancel`. (VERIFIED)
   - Runs API: `approval.request` SSE → `POST /v1/runs/{id}/approval|clarify|stop`. (VERIFIED)
   - Legacy tui_gateway: server→client JSON-RPC requests `approval` / `clarify`. (VERIFIED, docs)
4. **Profiles**
   - `HERMES_HOME`-style homes: default = `~/.hermes`, named = `~/.hermes/profiles/{alex,david,neo,todoist}`. **One gateway process multiplexes all 5** (`gateway.multiplex_profiles: true`). Each profile has its own authority, state.db, `.env` and Discord bot token (david/neo have a token; todoist has none). (VERIFIED)
   - Canonical RPCs take an optional `profile`; tickets are per profile home. Dashboard REST takes `?profile=`. API server mirrors routes at `/p/<profile>/…`. ACP binds to the profile of its launching `HERMES_HOME` / `-p`. (VERIFIED, source)
5. **Concurrency**
   - One owner process runs many sessions at once. Each session has a durable FIFO (`session_admissions`, intents `queue | steer | redirect`). (VERIFIED)
   - A viewer can mount a cold Discord session. If the chat has moved on, the session mounts **detached** and its replies go only to app viewers, never to the chat. (VERIFIED, docstrings)
   - Unknown: whether a viewer prompt on the chat's *current* conversation is also posted to Discord (INFERRED yes; see Gaps).
   - Here `display.busy_input_mode: interrupt`, so a bb send into a running turn can interrupt it unless sent with `queued: true`. (VERIFIED, config + contract)
6. **Recommendation**
   - Make "a bb thread == a Hermes session" over the **canonical gateway WebSocket**, reached through a **companion Hermes dashboard plugin** on $HERMES_HOST. The plugin bridges `/api/plugins/bb/…` (auth: dashboard Bearer) to `connect_gateway()` per profile.
   - Use dashboard REST for list, history, pin and archive. Use ACP only as a fallback; it lists only ACP-created sessions.

## 1. Session store (details)

- Files (VERIFIED, `ls`):
  - `~/.hermes/state.db` (+`-wal`, `-shm`), `~/.hermes/profiles/<p>/state.db`.
  - Mode `0600`. `pragma journal_mode` = `wal`.
  - Side stores: `response_store.db` (API responses), `runs_idempotency.db`, `kanban.db`, `runtime/active_sessions.json` (open-surface leases; 0 entries now), `sessions/` (legacy JSON index, `hermes-agent/gateway/mirror.py:1-25`).
- `sessions` columns (VERIFIED, `.schema sessions`):
  - Identity: `id` (PK), `source`, `created_source`, `user_id`, `session_key`, `chat_id`, `chat_type`, `thread_id`, `display_name`, `origin_json`, `profile_name`, `transport_profile`.
  - Model and cost: `model`, `model_config`, `system_prompt`, `system_prompt_hash`, `billing_*`, `*_tokens`, `estimated_cost_usd`, `actual_cost_usd`, `cost_*`, `pricing_version`, `api_call_count`, `tool_call_count`, `tool_names`.
  - Lifecycle: `started_at`, `ended_at`, `end_reason`, `expiry_finalized`, `last_activity_at`, `last_activity_description`, `last_activity_provenance`, `last_read_at`.
  - Lineage: `parent_session_id` (FK self), `rewind_count`, `handoff_state`, `handoff_platform`, `handoff_error`, `compression_*` (6 cols).
  - UI: `title` (UNIQUE when not null), `title_source`, `archived`, `auto_archived`, `pinned`, `hidden`.
  - Revisions: `runtime_revision`, `runtime_generation`, `transcript_revision`, `git_metadata_generation`.
  - Workspace: `cwd`, `git_branch`, `git_repo_root`.
- `messages` columns (VERIFIED): `id` (AUTOINCREMENT), `session_id`, `role`, `content`, `api_content`, `tool_call_id`, `tool_calls`, `tool_name`, `timestamp`, `token_count`, `finish_reason`, `reasoning`, `reasoning_content`, `reasoning_details`, `codex_reasoning_items`, `codex_message_items`, `platform_message_id`, `observed`, `active`, `compacted`, `_compressed_summary`, `effect_disposition`, `display_kind`, `display_metadata`, `display_identity`, `display_order`, `message_uid`, `absorbed_message_uids`, `tool_call_uids`, `tool_call_uid`.
  - Triggers keep FTS (`messages_fts`, `messages_fts_trigram`) in sync. A rewrite of an existing row bumps `sessions.transcript_revision`; a new row does not.
- Other relevant tables (VERIFIED):
  - `session_turn_leases(conversation_id, holder, acquired_at, expires_at)`: 0 rows now.
  - `session_admissions` (durable FIFO: `intent` ∈ queue/steer/redirect, `status` ∈ queued/started/unknown/terminal).
  - `gateway_routing(scope, session_key, entry_json, updated_at)`: chat route → session.
  - `conversation_generations`.
- Counts by `source` (sessions / open = `ended_at` null; VERIFIED):

  | profile | source → count (open) |
  |---|---|
  | default | acp 138 (39), cli 47 (3), discord 28 (4), cron 18 (0), desktop 18 (2), local 13, api_server 9 (8), oneshot 9, subagent 1, tui 1; 2,984 msgs |
  | alex | cron 122 (14), discord 2 (2), oneshot 2, tui 2, acp 1, cli 1, desktop 1; 1,260 msgs |
  | david | acp 11 (11), cli 7, a2a 2, desktop 2, discord 1, oneshot 1; 390 msgs |
  | neo | oneshot 4, discord 2, desktop 1; 67 msgs |
  | todoist | desktop 1, tui 1; 0 msgs |

- `end_reason` values seen (default profile): `acp_disconnect` 110, null 56, `agent_close` 26, `session_reset` 24, `cli_close` 22, `cron_complete` 18, `startup_orphan_reap` 10, `ws_orphan_reap` 9, `new_session` 4, `compression` 3 (VERIFIED). An open `ended_at` alone does not mean live: alex has 14 cron rows never closed.
- Canonical (gateway-owned) rows are stored as `source='local'` with a `created_source` (e.g. acp, cli). Legacy rows keep `acp`, `cli`, `desktop`… (`hermes-agent/acp_adapter/catalog.py:16-19`; `hermes_state_local_migration.py:16-27`, VERIFIED read).
- Parent/child links:
  - `parent_session_id` covers compression continuations (`end_reason='compression'`), `/branch`, subagents and delegations.
  - The resolver is `db.get_compression_tip(id)` and `resolve_resume_session_id`. Messaging lineage publishes to the lineage *root* (`gateway/session_route_recovery.py:1-25`, `gateway/session_listing.py:46-60`).
  - (VERIFIED, read)
- Titles: unique per DB (`idx_sessions_title_unique`), with `title_source`. Each profile has exactly one `title='Bot Chat'` row (the Bot Mode canonical chat; sources desktop/tui), constant `BOT_CHAT_TITLE` at `hermes-agent/tools/bot_mode_probe.py:32`. (VERIFIED)
- Active detection options:
  - Dashboard: `is_active = ended_at IS NULL AND now - last_active < 300` (`hermes_cli/web_routers/sessions.py:124-135`, VERIFIED read).
  - Canonical `session.list` rows and the `session.resume` snapshot carry `running`, `pending` and `prompts` (`tui_gateway/contracts/canonical_sessions.py:137-186`, VERIFIED read). Most reliable.
- Change detection:
  - The legacy dashboard emits `sessions.changed` from a state.db mtime plus a sessions-column signature (`tui_gateway/change_watcher.py:191-260`, VERIFIED read).
  - The canonical per-session stream has `seq`, `replay_epoch` and `session.events.since(last_sequence)` for gap replay.
  - INFERRED: no global "session created" push exists on the canonical WS, so poll the list, or use a plugin hook (`on_session_start`).

## 2. Interfaces

### 2a. ACP (`acp_adapter/`)
- In production `HermesACPAgent()` returns `GatewayACPAgent`, a **viewer of the gateway daemon** with no in-process agent (`acp_adapter/server.py:245-249`, `acp_adapter/entry.py:~201-225`, VERIFIED read).
- Methods: `initialize` (loadSession, image prompts, session fork/list/resume), `authenticate`, `session/new`, `session/load`, `session/resume`, `session/fork`, `session/list`, `session/prompt`, `session/cancel`, `session/set_model`, `session/set_mode`, `session/set_config_option` (`server.py:527-551, 615-700, 1017-1088`; `gateway_server.py:271-645`, VERIFIED).
- Streamed `session/update` kinds: `agent_message_chunk`, `user_message_chunk` (replay), `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan` (todos), `usage_update`, `session_info_update`, `available_commands_update`, `current_mode_update`, `config_option_update` (grep over `acp_adapter/*.py`, VERIFIED).
- Load and resume replay the full live transcript before replying. Pending prompts are re-offered (`gateway_server.py:343-391`).
- Session list: only ACP-created rows (`catalog_sessions` → `list_sessions_rich(source="acp")`, `catalog.py:11-19`; `gateway_server.py:633-642`).
- Resuming a Discord session: INFERRED possible. `_resume` calls canonical `session.resume`, and the authority mounts cold messaging rows (`session_route_recovery.py`). The legacy in-process path refused non-`acp` rows (`session.py:457`). Not tested: it would mutate state.
- Wrapper `~/src/hermes-host/bin/hermes-bb-acp` (VERIFIED, read in full):
  - A stdout-only JSON-line relay that rewrites model-picker display names (`models.availableModels`, `configOptions` model select, `config_option_update`) per `config/bb-models.json`.
  - stdin, permissions and cancel pass through untouched. It has no profile flag, so bb's provider always targets the **default** profile.

### 2b. API server (gateway platform `api_server`)
- Enabled: `API_SERVER_ENABLED` and `API_SERVER_KEY` are present in `.env` for default, alex and todoist. Listening on `127.0.0.1:8642` (from `gateway_state.json` + `lsof`). `GET /health` → 200; `/v1/capabilities` without a key → 401 `gateway_auth_failed`. (VERIFIED probe)
- Routes (`gateway/platforms/api_server.py:1551-1592`, `api_server_runs.py:286-292`, VERIFIED read):
  - Health and discovery: `/health`, `/v1/models`, `/v1/capabilities`, `/v1/skills`, `/v1/toolsets`.
  - Sessions: `/api/sessions` CRUD, `/api/sessions/{id}/messages`, `/fork`, `/chat`, `/chat/stream` (SSE), `/model`.
  - OpenAI: `/v1/chat/completions`, `/v1/responses`.
  - Runs: `/v1/runs` plus `/{id}`, `/events` (SSE), `/approval`, `/clarify`, `/steer`, `/stop`, `/resolve-unknown`.
  - Jobs (cron): `/api/jobs*`.
  - Each route is mirrored under `/p/{profile}/…`.
- Run SSE event types: `run.queued`, `run.started`, `run.completed`, `run.failed`, `run.cancelled`, `run.interrupted`, `run.steered`, `run.stopping`, `message.started`, `message.delta`, `message.interim`, `reasoning.available`, `tool.started`, `tool.progress`, `tool.completed`, `tool.failed`, `approval.request`, `approval.responded`, `subagent.start`, `subagent.complete` (grep, VERIFIED).
- Continuity: `X-Hermes-Session-Id` / `X-Hermes-Session-Key` headers, `previous_response_id`, or `conversation_history` (`api_server.py:57-58`, `api_server_runs.py:488-524`).
- Sessions it creates are `source='api_server'`; dashboard pickers exclude them (`session_listing.py:13-18`).
- hermes-webui already uses this interface: `HERMES_WEBUI_GATEWAY_BASE_URL=http://127.0.0.1:8642`, `USE_RUNS_API=true` (`_hermes.nix:108-111`, VERIFIED).

### 2c. TUI gateway JSON-RPC (`tui_gateway/`)
- Transport: newline-delimited JSON-RPC over stdio (Ink TUI) or WebSocket (`tui_gateway/ws.py`). It is also the backend of Desktop and dashboard `/chat` (`tui_gateway/AGENTS.md:1-30`, VERIFIED read).
- Contract: `apps/shared/src/gateway-contract.openrpc.json` (VERIFIED parsed). 258 legacy methods, 16 server→client requests, 78 notifications, and **48 canonical (`hermes-gateway-v1`) methods**.
  - Canonical methods include `runtime.describe`, `session.create`, `session.resume`, `session.list`, `session.info`, `session.detach`, `session.stats`, `session.events.since`, `session.interrupt`, `session.steer`, `session.redirect`, `session.mutate`, `session.export`, `prompt.submit`, `prompt.cancel`, `prompt.receipt`, `prompt.steer_queued`, `prompt.replace_queued`, `approval.respond`, `clarify.respond`, `clarify.lock`, `profiles.list`, `config.get`, `cron.*`.
  - Notifications include `message.start|delta|interim|complete`, `reasoning.delta|available`, `thinking.delta`, `tool.start|generating|progress|complete`, `subagent.*`, `todo.updated`, `session.info|title|usage`, `sessions.changed`, `request.cancel`, `approval.cancelled`, `status.update`, `error`.
- Canonical snapshot (`session.resume`): `messages`, `running`, `pending` admissions, `prompts` (open approvals), `open_requests`, `replay_epoch`, `last_sequence`, `subscription_id`, `execution_generation`, `todo_state` (`contracts/canonical_sessions.py:137-162`).
- Canonical event envelope: `{type, session_id, payload, seq, replay_epoch, execution_generation, admission_id}` (`canonical_sessions.py:301-309`; consumer `acp_adapter/gateway_server.py:940-1000`).
- Multi-viewer: resume attaches another subscriber, and events fan out to every viewer (`website/docs/developer-guide/programmatic-integration.md:58`).
- Endpoints and auth:
  - **Canonical**: gateway process listener `127.0.0.1:58355`, an *ephemeral* port (VERIFIED `lsof`). Path `/api/ws`, subprotocol `hermes-gateway-v1` plus `hermes-gateway-ticket.<ticket>`. The ticket is minted over unix socket `~/.hermes/gateway.sock`, same OS user only (`hermes_cli/gateway_client.py:39-45, 273-382`; `gateway/run_api.py:1-14`). Not reachable off-host as-is.
  - **Dashboard `/api/ws`** (`hermes_cli/web_routers/chat_ws.py:650-700`): uses `app.state.session_authority`, set only on the gateway's own listener (`gateway/run_api.py:97`). The standalone dashboard (pid on 9119) therefore serves the **legacy** dispatcher. For gateway-owned sessions, `tui_gateway/owner_forward.py:1-16` forwards prompts to the owner. (VERIFIED, read)
  - **Dashboard auth**: gated (public_url set) → `GET /api/sessions` with no credential returns 401 `no_cookie`; with `Authorization: Bearer <HERMES_DASHBOARD_SESSION_TOKEN>` it returns 200 (VERIFIED probe, loopback; token present, value not printed). For WS the gated mode accepts a `?token=` that a session provider verifies; the in-process `_SESSION_TOKEN` is refused (`hermes_cli/web_server_chat.py:204-330`).
- Dashboard REST useful to bb (`hermes_cli/web_routers/sessions.py`): `GET /api/sessions?profile=&order=recent&sources=&exclude_sources=&archived=` (`:182-215`), `GET /api/sessions/{id}/messages?order=latest&limit=` (`:743-760`), `PATCH /api/sessions/{id}` for `title`, `archived`, `hidden`, `pinned`, `unread` with an expected revision (`:930-939`). Rows carry `is_active`, `unread`, `pinned`, `profile`, `preview`, `source`, `parent_session_id` (VERIFIED, response keys).

### 2d. Other server modes
- `hermes mcp serve` moved to plugin `mcp-serve` (`hermes_cli/left_core_migration.py:478-484`, `plugin-catalog/mcp-serve.yaml`); not installed (VERIFIED).
- A2A exists (`a2a` source rows in david; canonical `a2a.forward`). Not explored further.

## 3. Approvals, clarify, interrupts

- Policy here: `approvals.mode: smart`, `timeout: 60`, `cron_mode: deny` (`~/.hermes/config.yaml:528-533`, VERIFIED).
- Canonical WS (VERIFIED, read):
  - Approvals arrive as `approval.request` events (`prompt_id`, `execution_generation`) and are answered with `approval.respond{session_id, prompt_id, choice}`. They are withdrawn with `approval.settled`.
  - Clarify works the same way via `clarify.request` → `clarify.respond` / `clarify.lock`.
  - sudo and secret prompts are server→client requests to attached viewers, with a 120 s timeout (`gateway/session_server_requests.py:1-20`).
  - Open prompts survive viewer disconnects and are replayed in `prompts` / `open_requests` on resume.
  - Interrupt: `session.interrupt`. Steer and redirect: `session.steer` / `session.redirect`.
- ACP: maps approvals to `session/request_permission` with options `allow_once`, `allow_session`, `allow_always`, `deny` (`acp_adapter/permissions.py:15-19`). Clarify uses `elicitation/create` when the client advertises form elicitation, otherwise a permission card with Skip (`acp_adapter/elicitation.py:1-20`). Cancel is `session/cancel` and covers only this editor's own admission (`gateway_server.py:417-453`).
- Runs API: `approval.request` SSE, then `POST /v1/runs/{id}/approval|clarify|stop|steer`.
- Legacy tui_gateway: JSON-RPC requests `approval` → `{choice}` and `clarify` → `{answers}`. The client must send `client.capabilities{server_requests:true}`, otherwise every request is refused at once (`programmatic-integration.md:88-101`).
- Messaging (Discord): approvals render as platform buttons, and a timeout notice is posted to the chat (`gateway/run_turn_runner_approval_settle.py:1-10`). INFERRED: a viewer attached to the same session also gets `approval.request`, and whichever surface answers first wins (`request.cancel` on the others).
- Plugin hook points: `pre_approval_request`, `post_approval_response`, and `register_approval_transport(name, present_fn)`, which is selected by `security.approval.transport` (`hermes_cli/plugins.py:144-147, 437-449`).

## 4. Profiles

- `hermes profile list` (VERIFIED, run):

  | profile | model | gateway |
  |---|---|---|
  | `default` (active) | gpt-6.1-terra | running |
  | `alex` | mlx_main | running |
  | `david` (alias `david`) | mlx_main | running |
  | `neo` | gpt-6.1-sol | running |
  | `todoist` | — | running |

- Layout per profile: `config.yaml`, `.env`, `SOUL.md`, `state.db`, `memories/`, `skills/`, `cron/`, `sessions/`, `distribution.yaml`, `workspace/` (VERIFIED, `ls`).
- One process (`hermes_cli.main gateway run --replace`, pid 63362) serves every profile: `gateway.multiplex_profiles: true` (`config.yaml:595`).
  - Each profile has its own adapters, secrets, sessions and cron. They share one listener, one lock and one event loop.
  - Session keys are namespaced `agent:main` / `agent:<name>` (`website/docs/developer-guide/multiplexing-gateway.md:19-26, 203-212`, VERIFIED read).
  - Platforms: `discord`, `alex:discord`, `david:discord`, … all connected (`gateway_state.json`, VERIFIED). **Each bot is a profile with its own Discord bot.**
- Targeting a profile:
  - Canonical RPCs take `profile` (`ProfileParams`). Tickets are minted per home via `control_home_for(home, endpoint)` (`gateway_client.py:273-305`). The dashboard WS is `profile_scope: 'host'`.
  - Dashboard REST: `?profile=`. API server: `/p/<profile>/…`. ACP: `hermes -p <name> acp`, one viewer process per profile (INFERRED from `gateway_server.py:74-75`).
  - Profile admin RPCs: `profiles.list|describe|create|configure|get_asset|set_asset` (`multiplexing-gateway.md:276-283`).
- Oddity: david's DB has 4 rows with `profile_name='todoist'` (VERIFIED count). Rows can carry a different `profile_name` than their DB, so key bb threads on (db-profile, session id).

## 5. Concurrency and conflicts

- Many concurrent sessions run in one owner. The API server has `max_concurrent_runs: 10` (`config.yaml:593-594`).
- Each session has one durable FIFO (`session_admissions`). Submit receipts are admissions, not completions (`gateway-local-sessions.md:29-32`).
- Busy input: `display.busy_input_mode: interrupt` here (`config.yaml:290`). A normal submit during a running turn may interrupt it. Canonical `prompt.submit` has `queued: bool` to force queueing (`canonical_sessions.py:209-235`), and rewinds are refused while busy (4009).
- Discord session continued from bb:
  - The chat route is `gateway_routing.session_key` (e.g. `agent:<ns>:discord:group:<chat>:thread_<id>`) → session id.
  - A viewer `session.resume` mounts the cold row. If the chat still names it, the viewer joins the **same** conversation and transcript, so the bot's context includes the bb messages. (VERIFIED, docstrings `session_route_recovery.py:1-25`, `session_ingress.py:322`)
  - If the chat has `/new`'d past it, the row mounts **detached** (`agent:<ns>:detached:<sid>`). Turns then run only for app viewers, never posted to the chat; a chat `/resume` re-attaches it (`gateway/session_detached.py:1-27`).
  - Viewer submits on a live chat route take the chat's route claim. INFERRED, unverified: the reply is also delivered to Discord.
- Ordering risks:
  - A Discord message and a bb message interleave by admission order.
  - Compression rotates the physical id while the lineage root stays stable. Always address the root / `logical_owner`; an `unknown` admission can only be discarded.
  - A second writer on the same state.db (e.g. a bb-side process) is explicitly unsupported: "one owner, one FIFO" (`owner_forward.py:9-12`).

## 6. Recommendation sketch

- **Recommended: canonical gateway WebSocket, bridged by a companion dashboard plugin on $HERMES_HOST.**
  - Why:
    - It is the only interface with full parity: create/resume any local or messaging session, multi-viewer streaming, typed tool/reasoning/todo events, approvals and clarify with replay, interrupt/steer/queue, `profile` per call, seq-based gap replay.
    - Desktop and dashboard already depend on it, so it will stay supported.
  - Constraint: tickets need same-user access to `gateway.sock`, and the listener port is ephemeral loopback. Something on $HERMES_HOST must dial it.
  - The dashboard plugin backend is that something. It is mounted at `/api/plugins/<name>/`, behind the dashboard auth gate (Bearer verified on REST), and is in-process with Hermes internals (`website/docs/user-guide/features/extending-the-dashboard.md:726-760`). Plugin websockets are supported for in-process plugins (`hermes_cli/web_server_plugin_profiles.py:9, 270-282`; INFERRED for the launch profile). It is reachable by $BB_SERVER_TS over the tailnet at `https://$HERMES_HOST_TS.$TAILNET:8448`.
- **What the companion plugin must add**:
  1. `GET /api/plugins/bb/sessions?since=` across **all profiles**: id, profile, source, title, pinned, archived, hidden, running, pending-approval, last activity, lineage root. It can wrap `list_sessions_rich` per profile DB or call dashboard REST per profile.
  2. WS `/api/plugins/bb/ws`: a per-bb-thread proxy that calls `connect_gateway()` for the thread's profile home. It forwards `session.resume`, `prompt.submit` (default `queued:true` unless bb asks to interrupt), `session.interrupt`, `approval.respond`, `clarify.respond`, `session.events.since`, and relays events with `seq` and `replay_epoch`.
  3. Change feed: `on_session_start`, `on_session_end` and `post_gateway_admission` hooks, plus a state.db signature poll, pushed as `sessions.changed` so bb can show new Discord, cron and CLI sessions without polling every DB.
  4. Bot chats: resolve each profile's `title='Bot Chat'` session (`include_hidden`), so bb can pin one thread per bot.
  5. Settings: proxy `profiles.list` / `config.get` (read-only) for the bb settings page.
- **Alternatives**:
  - ACP via the bb $HERMES_HOST machine (works today): simplest, but it lists only ACP-created sessions, sees one profile per process, and requires the machine harness that goal (3) wants hidden.
  - API server `/v1/runs` + `/api/sessions`: good SSE and approvals, but its sessions are `api_server`-sourced and it cannot attach to Discord/CLI sessions as a viewer.
  - Dashboard legacy `/api/ws`: reachable today with the token, but it is a legacy second dispatcher (owner-forwarding). Avoid it for writes.

## Gaps and risks

- Not verified live (would need WS sessions or prompts):
  - `session.resume` of a Discord row from a third-party client.
  - Whether viewer replies post to Discord.
  - Dashboard `/api/ws` `?token=` acceptance in gated mode.
  - Plugin-WS on the gated tailnet listener.
- Bearer token was verified on loopback `:9119` only. Over `:8448` only the unauthenticated `/api/status` was probed (200).
- `busy_input_mode: interrupt` is a footgun for remote sends. Keep a bb-side default of `queued:true`.
- Upstream is a fast-moving canary (daily). The canonical contract is versioned (`runtime.describe` capabilities, `hermes-gateway-v1`); feature-detect, don't pin.
- The gateway listener port changes per start, so discovery must go through `connect_gateway()` / the control socket, never a hard-coded port.
- Open `ended_at` rows are not live (alex has 14 unclosed cron rows). Derive progress from canonical `running` / `pending`.
- Security: `~/.hermes/config.yaml` `mcp_servers."Home Assistant".headers` holds an inline bearer credential (present). It is unrelated to this design, but any plugin that dumps config must redact.
- `~/.hermes/state.db` holds private transcripts. The plugin must enforce the dashboard auth and should not expose `system_prompt`, `model_config` or `origin_json` to bb.

## Open questions for the user

- Should a bb reply into a Discord-originated thread also appear in Discord, or stay app-only (detached)? This decides whether bb attaches to the live route or forks.
- Is it OK for $BB_SERVER_TS to hold the dashboard session token (a host-wide credential with full capabilities), or should the companion mint a narrower bb-specific token?
- Default busy behaviour for bb sends into a running Hermes turn: queue (recommended), steer, or interrupt?
- Should hidden rows (Bot Chats, `hidden=1`) and `oneshot`/`subagent`/`cron` rows appear on the bb home page, or be filtered?
- Keep bb's existing `acp-hermes-agent` provider alongside the new plugin, or retire it once the plugin ships?

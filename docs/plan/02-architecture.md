# 02 — Architecture

## Components

| Component | Runs on | Entry | Owns |
|---|---|---|---|
| Server part | bb server | `server.ts` | Provider registration (hidden, `models.scope:"workspace"`); mapping db; switches; import queue; wakes; RPC (`diagnostics`, `stopHosted`, `newChat`, `setBot`); `message.dispatch` hook (D15) |
| Host worker | Hermes machine, bb host daemon | `host.ts` default export (`experimental_defineHostEntry`) | One host-scoped canonical connection; change watch; history reads; Bot Chat lookup; models; skill and wrapper files; version check |
| Bridge | Hermes machine, one process per hosted thread (S1-S3 fact 2) | `host.ts` export `experimental_providerBridge` | Its own canonical connection; turns, deltas, interactions; replay and mirror rendering; S8's send rules |
| Canonical client | library (worker, bridge) | `src/hermes/client.ts` | Discovery, ticket, dial, RPC, replay cursors; ported from `spike/hermes` `src/hermes/` |
| History reader | library (worker, bridge) | `src/hermes/history.ts` | Read-only REST reads (below) |
| App | bb UI | `app.tsx` | Settings page, rail panel, row badge, thread banners; `useBbNavigate` |

How Hermes' other apps reach the same chats:

![Conduit reaches Hermes through the dashboard; Desktop, CLI and TUI through the gateway](../diagrams/other-apps.svg)

- The picture shows CLI and TUI writing saved chats. At `c314285f07` they don't: both run each turn in the gateway (`hermes_cli/gateway_agent.py:1-8`, `ui-tui/CANONICAL_GATEWAY.md:1-9`). Only the dashboard (Conduit, remote Desktop, dashboard chat) runs turns outside the gateway, unless that chat's gateway queue is busy (S8, "How Hermes coordinates the two writers" 1).

## Placement

- The bb server can't reach Hermes files or `gateway.sock`. All Hermes I/O goes through the worker (host RPC, 30 s timeout, r01 §1) or a bridge.
- Settings: **Hermes machine** (a bb host id) and **Hermes folder** (default `~/.hermes`). The folder reaches the worker in `ensureWatch{root}` and bridges via `deriveProviderOptions`. Logic never names a machine. Unset machine → no Hermes I/O (R3 M3).
- Canonical connection: `identify` → `session-ticket{scope:"host"}` → `/api/ws` with subprotocols `["hermes-gateway-v1","hermes-gateway-ticket.<t>"]` (S0-S4 cheat-sheet 1). Rediscover on every connect; `gateway.sock.path` fallback. One host ticket drives every served profile (S8 §Per-profile reach).
- **Never start a gateway** (r09 M5): no `connect_gateway()` without an endpoint, no `hermes gateway …`, no `ensure` verbs.

## History reader

Choice (README confirm item 4): Hermes' REST projection, as Hermes Desktop reads it (R6 C3).
- `GET /api/sessions?profile=…` and `GET /api/sessions/{id}/messages` on the gateway's own listener (`api_origin` from `identify`).
- Auth: a `native-http` ticket minted on `gateway.sock` per request (`apps/desktop/electron/local-gateway.ts:487`). No credential, config change or port (D1).
- The route is `read_only=True`, includes compression ancestors, and applies Hermes' display projection: scaffold rows, steers, withheld prompts (`hermes_cli/web_routers/sessions.py:671-787`). We never re-implement it.
- Unavailable while the gateway restarts: reads wait.
- Fallback only if T0.5 finds a missing field: TypeScript `node:sqlite` with `readOnly` (A36), re-implementing only what's missing.
- Change detection: a key check of both responses on each version change (flow 11).
- Author: bb's rows carry `bb:` in `display_metadata.submission_id` (A4).

## Mapping db (`bb.storage.database()`, SQLite on the server)

`bindings`: one row per Hermes-backed thread. `UNIQUE(profile_home, lineage_root)`; one `kind=bot` row per `profile_home`.

| Column | Note |
|---|---|
| `thread_id` PK | bb thread |
| `profile_home` | Hermes `profile_id`, not the name (r03 §4) |
| `lineage_root`, `session_id` | logical id (`chat_id` owner) and current tip. Null until the first send creates the session |
| `expected_id` | bb-created session id, computed before the first send (identity rules) |
| `kind` | `bot` · `chat` · `mirror` |
| `source`, `tag` | raw `source`/`created_source`, and the tag shown (`CLI`, `TUI`, `Desktop`, `Conduit`) |
| `state` | `pending` (no session yet) · `replaying` · `live` |
| `legacy` | not gateway-owned yet (D16) |
| `archived_by_switch` | set by switch-off, cleared by switch-on (D48) |
| `title_set` | the last title the plugin set; a different bb title means the user renamed it |

`turns`: one row per Hermes turn bb has shown or queued. PK `(thread_id, anchor_uid)`.
- Anchor = `message_uid` of the user message, else of the first reply message. uids survive compaction clones and `/retry`; row ids don't (R1 M2).
- Columns: `kind` (`replay` · `mirror` · `bb`), `state` (`queued` · `done` · `partial`), `reply_uids`, `at`.
- Wake atomicity (R1 M1): `INSERT OR IGNORE`, send only if inserted; a failed send deletes the row. On boot, `queued` rows with no bb turn are re-sent or deleted.
- bb's own turns: recorded as `bb` from the bridge's `hermes/persisted-turn` extension state (A37), beside the `submission_id` check.

Also:
- `bots(profile_home PK, name, enabled, enabled_at)`.
- `tombstones(profile_home, lineage_root, at)`: never import (Q1).
- `kv`: `worker_boot_id`, worker identity `{uid, instance_id}`.
- No transcript text on the server. Migrations: additive, one transaction at load. `VACUUM INTO` a copy before any plugin remove.

Identity rules:
- bb-created session id: `"local-" + sha256(json([profile_home, "uid:<uid>", "bb:<threadId>"]))` (S0-S4 §S4b), stored as `expected_id` right after `threads.spawn`, so a re-list never mistakes it for an outside chat.
- Every spawn carries `pluginMetadata.hermes.origin`. The `thread.created` handler binds only threads made elsewhere (`bb thread spawn`).
- `providerThreadId` = `<profile_home>#<lineage_root>`, announced only at a turn boundary (S1-S3 fact 1). Bot threads: `<profile_home>#bot`.

## Contracts

### Markers (`src/shared/marker.ts`, agent-only `<hermes-bb>{json}</hermes-bb>`)

| `op` | Fields | Sent on | Bridge action |
|---|---|---|---|
| `init` | `profile, bot?` | spawn of a bot thread or empty side chat | Refused unless identity is `pending:`. Saves the profile; publishes chip and catalog |
| `bind` | `profile_home, lineage_root, legacy, anchor_uid, since?` | first import turn | Bind; render that turn from history; `since` → the "Earlier messages stay in Hermes" note |
| `replay` | `anchor_uid` | later import turns | Render that turn from history |
| `mirror` | `anchor_uid, rest?` | wake | Render or watch the outside turn (flow 6) |

Input parsing (R1 M6): bb may merge queued sends into one turn. The bridge splits input into ordered segments: each marker, and the visible text before it. Text with no marker is a bb prompt.

### Server ↔ host worker (`src/shared/host-contract.ts`)

| Call | Input → output |
|---|---|
| `ensureWatch` | `{root, enabled_bots}` → `{worker_boot_id, connected, instance_id, version, supported}`. Every 60 s: an idle worker dies at 300 s with no exit event (S7 §6). New boot id → full reconcile |
| `describe` | → `{uid, profiles[{name, home, handle, terminal_cwd, served}]}` |
| `models` | `{profile}` → `model.options` rows; enabled bots prewarmed |
| `listSessions` | `{profile_home, since?}` → `[{session_id, lineage_root, title, source, created_source, hidden, archived, cwd, message_count, last_activity_at, legacy}]` |
| `readTurns` | `{profile_home, lineage_root, after_uid?, since?}` → `[{anchor_uid, user_text, user_hidden, source, submission_id, reply_uids, ts, complete}]`, root to tip |
| `findBotChat` | `{profile_home}` → `{found, lineage_root, session_id}` · `{none}` · `{held}` |
| `setBotAccess` | `{profile_home, on}` → writes or deletes skill and wrapper, then `refresh-prompts` (flow 1) |
| `diagnostics` | → pid, uptime, boot id, watch state, version check, bridge build registry |

Signals (worker → server): `changed{profile_homes[]}`, debounced; `watch{state}`. `sessions.changed` is only a hint (r11 §8), so the worker also stats each enabled profile's `state.db-wal` every 2 s.

### Bridge state (`<bridge dataDir>/`)

- `threads.json`: `{threadId: {profile, bot}}`, needed before a Hermes session exists.
- `bridges/<pid>.json`: `{build, threadId, startedAt}` for `diagnostics` (A22).
- `models/<profile>.json`: last-known model list.

## Protocol mapping

bb → bridge → Hermes:

| bb method / input | Hermes call | Notes |
|---|---|---|
| `initialize` | — | `sessionRestore`, `approvalEnforcedBy:"provider"`, grammar v3, `permissionModes:["auto"]` (A2, D17), reasoning levels, `supportsNativeUserQuestion:true`. No fork, manual compaction, archive or rename support (Later) |
| `provider/health` | — | `not_installed` always: hides Hermes from pickers (S1-S3 §S3a) |
| any turn on another host | — | `provider.error` "Hermes runs on <machine>: add `--machine <machine>`" |
| any turn, bot switched off | — | `provider.error` "<bot> is switched off in the Hermes plugin settings" |
| `model/list` | legacy `model.options{profile}`, 2 s | Last-known list on timeout. Never creates a session (r09 M6) |
| `thread/start` | — | Identity `pending:<threadId>`; publish `bb/session-options` (the chat's bot only) and `bb/provider-model-catalog` (reasoning from `capabilities`, r11 §1) |
| `thread/resume` | — | Records identity only (R4 M4) |
| `turn/start`, side chat, `pending` | `session.create{profile, request_id:"bb:<threadId>", source:"cli", cwd, model, provider, reasoning?}` | `cwd` = `terminal.cwd`, else `~`. A20 |
| `turn/start`, bot thread | flow 3 | S8 steps 1–4 |
| `turn/start`, legacy binding | `session.resume{omit_messages:true}` adopts once (D16) | `runtime_coordination_required` → flow 3 step 4 |
| `turn/start`, any | then `prompt.submit{session_id, text, attachments?, submission_id:"bb:<threadId>:<clientRequestId>", turn_author:{id:"bb:<threadId>", name:"bb"}}` | One `submission_id` per message; never auto-resend (S8 step 4) |
| attachments | `prompt.submit.attachments` `{path, mime}` (A50) | Non-image model → `provider.warning`; text still sent |
| text `/new` or `/reset` | `session.mutate{operation:"compress", request_id, expected_revision, expected_generation}` while idle | `invalid_params` without `expected_generation` (S8 E7). Never a new session (A46) |
| reasoning / model pick mid-chat | `session.mutate{operation:"reasoning"\|"model"}` while idle, same fences | `default` → omitted |
| unoffered model | — | bot default + `provider.warning` |
| marker segment | none, or `session.resume` to watch a running canonical turn (never on a legacy row) | Never `prompt.submit` |
| `turn/steer` | bb's own running → `session.steer{execution_generation, text}`; else a queued `prompt.submit` | Never another client's turn (R1 M4) |
| `thread/stop{interrupt}` | bb's own running → `session.interrupt{execution_generation}`; bb's own queued → `prompt.cancel{session_id, admission_id}`; waiting on Conduit → drop locally; forwarded Conduit admission → `session.interrupt` fenced by its generation; other outside turns → stop watching + banner (A47) | S8 step 8; D27 narrowed |
| `thread/stop{release}` | `session.detach{session_id, subscription_id, end_reason:null}` | No `profile` key (R1 S6); A24 |
| interaction answer | `approval.respond{session_id, execution_generation, prompt_id, choice}` / `clarify.respond{…, answer}` | `already_resolved` → close silently |
| Hermes `not_found` | — | Bot thread: resolve by title again. Others: "Deleted in Hermes" |
| reconnect | `prompt.resolve_unknown` for bb's own `unknown` admissions | Flow 8; in `contract/used-surface.json` |

Hermes events → bb deltas:
- **Text and tool events:** from bb's own admission, the mirrored one, or a foreign admission on bb's subscription (e.g. `desktop-forward-…`), rendered live as an outside turn. This replaces the old "only our admission" filter (S8 step 5).
- **Approval and `clarify` requests:** session-scoped, raised whichever admission they belong to (R1 S1); every attach re-raises the snapshot's `prompts[]`.

| Hermes event | bb delta |
|---|---|
| `message.start` / `message.delta{text}` / `{text:null}` | `item.open` / `item.textDelta` / `item.textClose` (agentMessage) |
| `reasoning.delta` | `item.textDelta` reasoningText |
| `thinking.delta`, `agent.step` | ignored |
| `tool.start` / `.progress` / `.complete` | `item.open` / `item.progress` / `item.close` by `tool_call_id`; terminal → command, write/patch → fileChange, read → fileRead, web search → webSearch, else tool. `subagent.*` → a tool item |
| `approval.request` / `clarify.request` | `interaction/request` approval / userQuestion; choices never widened |
| `*.settled`, `approval.cancelled` | close the interaction (A3) |
| `todo.updated` / usage | planSteps / `usage`, `contextWindow` |
| `session.info{stored_session_id}` change | follow the tip; `context.compacted` |
| "another Hermes process is using this session" status | waiting text (S8 step 5) |
| `message.complete{status}` | `turn.boundary` completed / interrupted / failed |
| `error` | `provider.error` |

## Flows

1. **Bot switch** (app → server `setBot{profile_home, on}`)
   - Before on: the row shows `listSessions{since: now − 30 d}` after the source filter, minus bound and tombstoned (README confirm item 2).
   - On:
     1. `bots.enabled = 1`, `enabled_at = now`.
     2. Worker `setBotAccess{on}`: write `<plugin data>/bin/bb-hermes` if missing; render the bundled skill with the wrapper path into `<profile home>/skills/bb-plugin-hermes/` with `.bb-plugin-hermes.json` `{plugin, version, profile_home}`; run `hermes -p <profile> sessions refresh-prompts` (A43, A45).
     3. Bot thread: unarchive the existing `bot` binding, else `threads.spawn{providerId:"hermes", environment:{type:"host", hostId, workspace:{type:"personal"}}, sessionOptions:{profile}, title:<bot name>, pinned:true, input:[init{profile, bot:true}]}`, muted, then `markRead`.
     4. Bot thread not bound yet → `findBotChat`: found → bind and import its turns since `enabled_at − 30 d` (flow 5); `held` → retry in the background (flow 3 step 4); `none` → stays `pending`.
     5. Unarchive bindings with `archived_by_switch`, clear it, then reconcile: missing turns wake as finished turns (flow 6).
     6. [P2] Import unbound chats active since `enabled_at − 30 d` (flow 5).
   - Off: `bots.enabled = 0`; `threads.stop` each hosted thread of the bot; archive its unarchived threads with `archived_by_switch = 1`; worker deletes the skill dir (only with our marker) and the wrapper if no bot is on, then `refresh-prompts`; watch and wakes skip the profile.
2. **Side chat**
   1. Rail → RPC `newChat{profile}` → `threads.spawn{…, title:"New <bot> chat", pluginMetadata:{hermes:{origin:"newChat"}}, input:[init{profile}]}`; binding `chat`/`pending` with `expected_id`; notification level `muted` during init, then `markRead` and restore.
   2. First visible turn: model check → `session.create` → `prompt.submit` → stream → boundary → identity. The server sets the title to the first message cut to 60 characters (S7 finding 4).
   - `bb thread spawn --provider hermes` → `thread.created` → bind the same way (A18).
3. **Bot thread send** (S8 §Recommended protocol; also legacy Conduit chats from step 3 on)
   1. Resolve each send and each re-list: `session.list{profile, title:"Bot Chat", include_hidden:true}`. `profiles.list.canonical_session: null` doesn't mean none (S8 E6). Cache `chat_id` for dedupe and reads only.
   2. None: re-check, then `session.create{profile, title:"Bot Chat", hidden:true, follow_profile_config:true, request_id:"bb:botchat:<profile_home>"}`. It returns any Bot Chat created meanwhile (E1). Lazy, never at setup: keeps the double-mint window (E12) to the user's first send.
   3. `session.resume{omit_messages:true}` (adopts a legacy row once) → `prompt.submit`. Always submit; the gateway orders it.
   4. `runtime_coordination_required` from lookup, create or resume: keep the bb turn open, banner "Open in Conduit: sends when it's free" (A47), retry at 2, 5, 10, 30 s, then every 60 s. Never create, never take over. Stop drops the wait.
   5. Conduit busy: bb's turn queues and shows Hermes' waiting status; no retry (E3a). bb busy, Conduit sends: a foreign admission on bb's subscription, rendered live tagged `[Conduit]` (E3b).
   6. Title moved (deleted, renamed or re-minted in Hermes, r12 §1): the binding follows the new `lineage_root`; bb keeps the old turns.
4. **Turn controls:** track bb's own `admission_id`s from `AdmissionStatus`. Approvals, `clarify`, Stop and steer follow the tables; cards show the request's deadline.
5. **Import and replay** (server, one serial queue)
   1. Per chat, oldest first: `readTurns{since}` → binding `replaying` → `turns` rows `replay`.
   2. Mirrored chat: `threads.spawn{visibility:"hidden", title, input:["[<tag> · Oct 12] "+user0, bind]}`; bot thread: `threads.send` into it. Then `threads.send(queue-if-active, [tag+user_i, replay])` per turn (S1-S3 §S1b). bb's own past turns render untagged.
   3. On idle: `update{visibility:"visible"}`, archive if Hermes archived it, `markRead`, `threads.stop`, `state=live`.
   - The bridge renders from history only; no canonical call (D16).
   - Interrupted (restart, sleep): on boot a `replaying` binding's hidden thread is deleted with its rows and re-queued (R3 S2; A38).
6. **Wake and mirror**
   1. Hint or WAL stat → `changed` → debounced re-list → `readTurns` for each `live` binding of enabled bots. [P2] Unbound allowed chats → flow 5, turns since `enabled_at − 30 d`.
   2. Anchors not in `turns` and not bb's (`submission_id` starts `bb:`, A4): `INSERT OR IGNORE` as `queued`; if inserted, `threads.send{queue-if-active, ["[<tag>] <text>", mirror{anchor_uid}]}`. Hidden user row → marker only. A done anchor with a new reply uid (`/retry`) → `mirror{rest:true}`.
   3. Server sets the thread's level to `input-only` for the mirror turn (approvals and `clarify` still push; S1-S3 §S3c), then restores it.
   4. Bridge, by turn state: complete → render rows. Running as canonical work (CLI, TUI, Desktop, forwarded Conduit) → `session.resume` + `events.since` from the turn's first seq, close on its `message.complete` (A19; R1 S2). No canonical admission (Conduit's own) → render the user row, close `partial`; reply rows arrive by re-list as `mirror{rest:true}` (S8 step 6). No store polling.
   5. On idle: `turns` → `done`. The finished turn marks the thread unread (bb).
7. **Compaction and rotation:** in place keeps the id (A-S8d). Rotating: new segment, same `chat_id`; the `Bot Chat` title moves to the tip; resuming the root reaches the tip (S8 E8). The bridge follows `session.info.stored_session_id`; cloned rows keep their uids, so nothing renders twice (A8).
8. **Gateway restart:** rediscover and new ticket, backoff 1/2/5/10 s. Bridge: `events.since`; on `snapshot_required`, an epoch change or `truncated` → re-resume. bb's own `unknown` admissions → `prompt.resolve_unknown` at once, turn failed "Hermes restarted: resend?" (S8 E11b). Re-raise open prompts. Worker: full reconcile.
9. **bb or daemon restart:** bridges die; the next turn → `thread/resume{providerThreadId}` (S1-S3 §S1c); retries reuse their `submission_id` (A4). New `worker_boot_id` → full reconcile (~1.9 s, S7 §6); interrupted imports redone; orphaned `queued` turns re-sent or deleted.
10. **Hermes machine offline:** `watch` disconnected → thread banner "<machine> is offline: sends wait until it reconnects" (A9). On reconnect: reconcile; missed outside turns mirror as finished turns.
11. **Hermes version change** (new `version` or `instance_id`): diff `contract/used-surface.json` against `<folder>/hermes-agent/apps/shared/src/gateway-contract.openrpc.json` (A51) and key-check the two REST responses. Fail → health "not supported"; import and mirroring pause; sends continue while their methods are present.
12. **Redeploy:** `bb plugin update hermes` (A26) → RPC `stopHosted` stops idle Hermes threads, busy ones at `thread.idle` → `diagnostics` shows no bridge on the old build (S7 §7).

## Invariants

- **One thread per Hermes chat** `(profile_home, lineage_root)`, checked before every spawn: bb accepts duplicates, then orphans one (S1-S3 fact 4). Imports, wakes and bot threads share one serial queue.
- **One bot thread per enabled bot,** bound by title. A session titled `Bot Chat` never gets its own thread.
- **Source allow-list fails closed:** `source` or, for `source=local`, `created_source` ∈ {`cli`, `tui`, `gui`, `desktop`}; not hidden (Bot Chat apart); ≥ 1 message; not bb-created; not tombstoned. Anything else, unknown labels included, stays out.
- **Reading never writes Hermes:** markers never `prompt.submit`; history is REST `read_only`; `thread/resume` and `model/list` never touch sessions; no session before the first visible message; no `session.resume` or `session.mutate` on a legacy row before the first bb send (A23).
- **Events:** drop `replay_epoch == cursor.epoch && seq <= cursor.last` (S0-S4 §S4e). Steer and Stop act only on bb's own admission or a forwarded Conduit one.
- **Turns:** one wake per anchor; bb's rows never mirror; approvals and `clarify` never filtered by admission.
- **Approvals:** never auto-approve; never widen Hermes' choices.
- **Hermes-side writes:** only those a bb user action causes (creates, sends, adoptions, Stop, steer, answers, `/new` compactions, model and reasoning picks, `prompt.resolve_unknown` for bb's own turns), plus the marked skill dir and `refresh-prompts` epochs.
- **Off bot:** no Hermes I/O for that profile except removing its skill.

## bb access and security

- **What an enabled bot gets** (D43; S8 §Secondary option 1):
  - `<plugin data>/bin/bb-hermes`: sets `BB_SERVER_URL` only when the bb server is remote, then runs `bb` (A44).
  - `<profile home>/skills/bb-plugin-hermes/SKILL.md`: a general bb skill calling the wrapper; bundled in `assets/skill/`, rendered with the wrapper path.
  - No `config.yaml` or `.env` edit, no restart; survives `hermes update` and `hermes profile update --force` (S8 §Secondary).
  - Reach: the bb CLI as the Hermes machine's user, on every thread and machine. Hermes' danger detector flags no `bb` command, so nothing prompts (r12 §4). Restrictions Later.
  - The bot's own bb skills, if any, are untouched.
- **No network credentials:** same-UID socket tickets only; nothing Hermes-related on the bb server; no `experimental_contributeEnv` (r01 G11).
- **Transcripts:** reach bb only as thread content, tool results included (filter Later, D36). Mapping db, `diagnostics` and logs hold ids only. `system_prompt`, `model_config` and `origin_json` are never forwarded (r03 §6).
- **Live safety:** the plugin never restarts or starts a gateway or dashboard, and never reads `.env` files.

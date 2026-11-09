# 02 — Architecture

## Components

| Component | Runs on | Entry | Owns |
|---|---|---|---|
| Server part | bb server | `server.ts` | Provider registration (hidden, `models.scope:"workspace"`); mapping db; switches; import queue; wakes; RPC (`diagnostics`, `bots`, `setBot`, `stopHosted`, `threadInfo`); `message.dispatch` hook (D15) |
| Host worker | Hermes machine, bb host daemon | `host.ts` default export (`experimental_defineHostEntry`) | One host-scoped canonical connection; change watch; history reads; Bot Chat lookup; models; skill and wrapper files; version check |
| Bridge | Hermes machine, one process per hosted thread (S1-S3 fact 2) | `host.ts` export `experimental_providerBridge` | Its own canonical connection; turns, deltas, interactions; replay and mirror rendering; S8's send rules |
| Canonical client | library (worker, bridge) | `src/hermes/client.ts` | Discovery, ticket, dial, RPC, replay cursors; ported from `spike/hermes` `src/hermes/` |
| History reader | library (worker, bridge) | `src/hermes/history.ts` | Read-only REST reads (below) |
| App | bb UI | `app.tsx` | Settings page, New Thread and thread banners, Hermes icon |

How Hermes' other apps reach the same chats:

![Conduit reaches Hermes through the dashboard; Desktop, CLI and TUI through the gateway](../diagrams/other-apps.svg)

- CLI and TUI run each turn in the gateway (`hermes_cli/gateway_agent.py:1-8`, `ui-tui/CANONICAL_GATEWAY.md:1-9`). Only the dashboard (Conduit, remote Desktop, dashboard chat) runs turns outside the gateway, unless that chat's gateway queue is busy (S8, "How Hermes coordinates the two writers" 1).

## Placement

- The bb server can't reach Hermes files or `gateway.sock`. All Hermes I/O goes through the worker (host RPC, 30 s timeout, r01 §1) or a bridge.
- Settings: **Hermes folder** (default `~/.hermes`) is a `bb.settings` field (`bb plugin config hermes set folder …`). **Hermes machine** (a bb host id) lives in the mapping db's `kv`, set by RPC `setConnection` from the app's picker, so bb's settings form never shows a host id. Bridges get the machine, and the server's view of their thread's binding, through `deriveProviderOptions` (§Provider options). The folder reaches the worker in `ensureWatch{root}` and bridges via `deriveProviderOptions`. Logic never names a machine. Unset machine → no Hermes I/O (R3 M3).
- Canonical connection: `identify` → `session-ticket{scope:"host"}` → `/api/ws` with subprotocols `["hermes-gateway-v1","hermes-gateway-ticket.<t>"]` (S0-S4 cheat-sheet 1). Rediscover on every connect; `gateway.sock.path` fallback. One host ticket drives every served profile (S8 §Per-profile reach).
- **Never start a gateway** (r09 M5): no `connect_gateway()` without an endpoint, no `hermes gateway …`, no `ensure` verbs.

## History reader

Choice (README confirm item 4): Hermes' REST projection, as Hermes Desktop reads it (R6 C3).
- `GET /api/sessions?profile=…` and `GET /api/sessions/{id}/messages` on the gateway's own listener (`api_origin` from `identify`). Read messages with `include_compacted=true`; pages: list ≤ 100, messages ≤ 500, default = the latest page (`order=oldest` for import). The list never shows hidden rows: the Bot Chat comes from `session.list` (flow 3). A rotated chain lists its tip; any chain id's messages answer for the tip, ancestors included (T0.5).
- Auth: a `native-http` ticket for that profile, minted on the root's `gateway.sock` per request (`apps/desktop/electron/local-gateway.ts:487`). No credential, config change or port (D1).
- The route is `read_only=True`, includes compression ancestors, and applies Hermes' display projection: scaffold rows, steers, withheld prompts (`hermes_cli/web_routers/sessions.py:671-787`). We never re-implement it.
- Unavailable while the gateway restarts: reads wait.
- Fallback only if T0.5 finds a missing field: TypeScript `node:sqlite` with `readOnly` (A36), re-implementing only what's missing.
- Change detection: a key check of both responses on each version change (flow 11).
- Author: bb's submits and queued prompts carry `bb:` in `display_metadata.submission_id`; steers and `/retry` rows don't (A4, T0.5), so the `persisted_turn` record stays the backstop.

## Mapping db (`bb.storage.database()`, SQLite on the server)

`bindings`: one row per Hermes-backed thread. `UNIQUE(profile_home, lineage_root)`; one `kind=bot` row per `profile_home`.

| Column | Note |
|---|---|
| `thread_id` PK | bb thread |
| `profile_home` | Hermes `profile_id`, not the name (r03 §4) |
| `lineage_root`, `session_id` | logical id (`chat_id` owner; a legacy chain with no `chat_id`: its root, REST `_lineage_root_id`, so a rotation never makes a second thread) and current tip. Null until the first send creates the session |
| `expected_id` | bb-created session id, computed before the first send (identity rules) |
| `kind` | `bot` · `chat` · `mirror` |
| `source`, `tag` | the chat's recorded surface (`source`, or `created_source` for `source=local`): eligibility only, never UI text: each value has several writers in Hermes (`docs/operations.md` §Surfaces), so no badge names an app. `tag` stays null: every outside turn reads `[Outside bb]`, since Hermes records no per-turn source (owner ruling) |
| `cursor_uid` | the last anchor wakes have read past (migration 2) |
| `state` | `pending` (no session yet) · `replaying` · `live` |
| `legacy` | not gateway-owned yet (D16) |
| `archived_by_switch` | set by switch-off, cleared by switch-on (D48) |
| `title_set` | the last title the plugin set; a different bb title means the user renamed it |

`turns`: one row per Hermes turn bb has shown or queued. PK `(thread_id, anchor_uid)`.
- Anchor = `message_uid` of the user message, else of the first reply message. uids survive compaction clones; row ids don't (R1 M2). Dedupe rows by `message_uid` (first wins); `display_kind: steer` user rows and hidden reply rows are never anchors (A8, T0.5).
- Columns: `kind` (`replay` · `mirror` · `bb`), `state` (`queued` · `done` · `partial`), `reply_uids`, `at`.
- Wake atomicity (R1 M1): `INSERT OR IGNORE`, send only if inserted; a failed send deletes the row. On boot, `queued` rows with no bb turn are re-sent or deleted.
- bb's own turns: recorded as `bb` from the bridge's `hermes/persisted-turn` extension state (A37), beside the `submission_id` check.

Also:
- `bots(profile_home PK, name, handle, cwd, enabled, enabled_at)`: `handle` and `cwd` (migration 2) let provider options answer before the worker does. `turns.prev_state` (migration 2): a failed `rest` wake returns to its old state instead of being deleted.
- `tombstones(profile_home, lineage_root, at)`: never import (Q1).
- `kv`: `machine` (the Hermes machine), `worker_boot_id`, worker identity `{uid, instance_id}`.
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

Input parsing (R1 M6): bb may merge queued sends into one turn. The bridge splits input into ordered segments: each marker, with its label (the visible part right before it, when the marker says `labeled`), and bb prompts (the other parts between markers). `segmentInput` in `marker.ts`.

### Server ↔ host worker (`src/shared/host-contract.ts`)

Every call carries `root` (the folder); profiles are named by `profile_home`, which the worker maps to the name Hermes routes by.

| Call | Input → output |
|---|---|
| `ensureWatch` | `{root, enabled_bots}` (profile homes) → `{worker_boot_id, connected, instance_id, version, supported, detail}` (`detail`: a bounded reason code for health). Every 60 s: an idle worker dies at 300 s with no exit event (S7 §6). New boot id → full reconcile. Also writes `worker.json` for bridges |
| `describe` | `{root}` → `{uid, profiles[{name, home, handle, terminal_cwd, served}]}` |
| `models` | `{root, profile_home}` → the normalized catalog (`src/shared/models.ts`); enabled bots prewarmed into `models/` |
| `listSessions` | `{root, profile_home, since?}` → `{sessions[{session_id, lineage_root, title, source, created_source, hidden, archived, cwd, message_count, last_activity_at, legacy}]}`; `last_activity_at` is REST `last_active` (the raw column is heartbeats only) |
| `readTurns` | `{root, profile_home, lineage_root, after_uid?, since?}` → `{session_id (tip), turns[{anchor_uid, user_text, user_hidden, surface, submission_id, reply_uids, ts, complete}], truncated}`, root to tip |
| `firstSubmissions` | `{root, profile_home, lineage_roots[≤100]}` → `{submissions{<lineage_root>: submission_id \| null}}`: each chat's first user row, from its oldest page; `bb:` = bb created it. Discovery excludes bb-created chats by this and `expected_id`, never by surface (bb's side chats are stored `local`/`desktop`, like Desktop's) |
| `findBotChat` | `{root, profile_home}` → `{state:"found", lineage_root, session_id, legacy}` · `{state:"none"}` · `{state:"held"}`. Read-only: `profiles.list` `canonical_session`, which lists only a Bot Chat Hermes has adopted |
| `setBotAccess` | `{root, profile_home, on, enabled_bots}` → `{skill, wrapper, refreshed, detail}`: writes or deletes skill and wrapper (the wrapper goes when `enabled_bots` is empty), then `refresh-prompts` (flow 1) |
| `diagnostics` | → pid, uptime, boot id, watch state, version check, bridge build registry |

Signals (worker → server): `changed{profile_homes[]}`, debounced; `watch{state}`. `sessions.changed` is only a hint (r11 §8), and on the canonical socket it arrives only for the root profile, never for a Conduit dashboard turn (T1.0), so the worker also stats each enabled profile's `state.db-wal` every 2 s: the only signal for secondary profiles and for Conduit's own turns.

### Bridge state (`<bridge dataDir>/`)

- `threads/<threadId>.json`: `{profile, bot, …}`, one file per thread so bridge processes never overwrite each other, for `model/list`, which runs with no provider options (cwd → threadId → profile, S7 1c).
- `worker.json` (written by the worker, `src/shared/bridge-files.ts`): `{root, worker_boot_id, written_at, enabled[{profile, profile_home, bot_label, cwd, served}]}`. Present = this machine runs the worker; absent → turns fail "Hermes isn't on this machine. Start the thread on <machine> (--machine <machine>)." (the server sends the machine's name in provider options and refuses the dispatch itself, `message.dispatch`), and `model/list` (absent, or no bot on) answers one placeholder default, never sent to Hermes, so `bb thread spawn` on another machine reaches that refusal instead of bb's "catalog is empty". `enabled` feeds `model/list`'s `profile` session option (A18).
- `bridges/<pid>.json`: `{build, threadId, startedAt}` for `diagnostics`. bb gives bridges `…/plugins/hermes/bridge-data` and the worker `…/host-data` (A22 false), so the worker reads the sibling `bridge-data/bridges/`. `build` is `<plugin version>+<host artifact digest>`, the same for the worker and bridges of one deploy; the bundled version makes every release a new artifact, even with unchanged host code (A26).
- `models/<sha256(profile_home)[:16]>.json`: last-known catalog, written by the worker's prewarm and by bridges.

### Provider options and extension states

- `deriveProviderOptions` (synchronous, every command; `src/shared/provider-options.ts`): `{folder, machine{id, name}, thread}`, read leniently: bb's daemon merges its own keys in (`additionalWorkspaceWriteRoots`, T1.14). `thread` is the server's binding view `{kind, profile, profile_home, bot_label, enabled, lineage_root, session_id, legacy, cwd}`, null when unbound (S1-S3 fact 1 pattern (a)).
- Extension states the bridge publishes (`src/shared/extension-state.ts`): `persisted-turn` (bb's own turns as stored, cumulative, last 20; A37) and `status` (the thread banner: `held` "Open in another Hermes app: sends when it's free", `running_elsewhere` "Running outside bb", never an app's name; A47).

## Protocol mapping

bb → bridge → Hermes:

| bb method / input | Hermes call | Notes |
|---|---|---|
| `initialize` | — | `sessionRestore`, `approvalEnforcedBy:"provider"`, grammar v3, `permissionModes:["auto"]` (A2, D17), reasoning levels, `supportsNativeUserQuestion:true`. No fork, manual compaction, archive or rename support (Later) |
| `provider/health` | — | `not_installed` always: hides Hermes from pickers (S1-S3 §S3a) |
| any turn on another host | — | `provider.error` "Hermes isn't on this machine. Start the thread on <machine> (--machine <machine>)."; the dispatch hook refuses first, naming this machine |
| any turn, bot switched off | — | `provider.error` "<bot> is switched off in the Hermes plugin settings" |
| `model/list` | legacy `model.options{profile}`, 2 s | Last-known list on timeout. Never creates a session (r09 M6) |
| `thread/start` | — | Identity `pending:<threadId>`; publish `bb/session-options` (the chat's bot only) and `bb/provider-model-catalog` (reasoning from `capabilities`, r11 §1; each model with the bot option of every switched-on bot, this chat's picked, because a project's New Thread reads the project's catalog, r13 §6) |
| `thread/resume` | — | Records identity only (R4 M4) |
| `turn/start`, side chat, `pending` | `session.create{profile, request_id:"bb:<threadId>", source:"gui", cwd, model, provider, reasoning?}` | `cwd` = in a project (provider options `project`: the thread's project isn't the personal one), bb's `thread/start` folder (D54); else `terminal.cwd`, else `~`. `gui`, not `cli`: `hermes chat -c` continues a `cli` chat (A20 failed) |
| `turn/start`, bot thread | flow 3 | S8 steps 1–4 |
| `turn/start`, legacy binding | `session.resume{omit_messages:true}` adopts once (D16) | `runtime_coordination_required` → flow 3 step 4 |
| `turn/start`, any | then `prompt.submit{session_id, text, attachments?, submission_id:"bb:<threadId>:<clientRequestId>", turn_author:{id:"bb:<threadId>", name:"bb"}}` | One `submission_id` per message; never auto-resend (S8 step 4) |
| attachments | each image copied into `<profile home>/cache/images/` (a direct child, unique name), then `prompt.submit.attachments` `{path, mime}`; only `image/png\|jpeg\|gif\|webp` (A50, `gateway/session_ingress_media.py:140-182`) | Other files → `provider.warning`; text still sent. `model.options` has no vision flag, so a non-image model isn't detected |
| text `/new` or `/reset` | `session.mutate{operation:"compress", request_id, expected_revision, expected_generation}` while idle | `invalid_params` without `expected_generation` (S8 E7). Never a new session (A46) |
| reasoning / model pick mid-chat | `session.mutate{operation:"reasoning"\|"model"}` while idle, same fences | `default` → omitted. `model.options` gives no per-model effort list (Hermes clamps per route, `hermes_cli/inventory.py:542-546`), so every reasoning model offers the whole ladder; bb's `ultracode` → `xhigh` |
| unoffered model | — | bot default + `provider.warning` |
| marker segment | none, or `session.resume` to watch a running canonical turn (never on a legacy row) | Never `prompt.submit` |
| `turn/steer` | bb's own running → `session.steer{execution_generation, text}`; else a queued `prompt.submit` | Never another client's turn (R1 M4) |
| `thread/stop{interrupt}` | bb's own running → `session.interrupt{execution_generation}`; bb's own queued → `prompt.cancel{session_id, admission_id}`; waiting on Conduit → drop locally; forwarded Conduit admission → `session.interrupt` fenced by its generation; other outside turns → stop watching + banner (A47) | S8 step 8; D27 narrowed |
| `thread/stop{release}` | `session.detach{profile, session_id, subscription_id, end_reason:null}` | `profile` routes it on the host socket; without it a non-root profile's detach is a silent no-op (T0.3, isolated Hermes). A24 |
| interaction answer | `approval.respond{session_id, execution_generation, prompt_id, choice}` / `clarify.respond{…, answer}` | `already_resolved` → close silently |
| Hermes `not_found` | — | Bot thread: resolve by title again. Others: "Deleted in Hermes" |
| reconnect | `prompt.resolve_unknown` for bb's own `unknown` admissions | Flow 8; in `contract/used-surface.json` |

Hermes events → bb deltas:
- **Text and tool events:** from bb's own admission, the mirrored one, or a foreign admission on bb's subscription (e.g. `desktop-forward-…`), rendered live as an outside turn. This replaces the old "only our admission" filter (S8 step 5).
- **Approval and `clarify` requests:** session-scoped, raised whichever admission they belong to (R1 S1); every attach re-raises the snapshot's `prompts[]`. bb routes `interaction/request` only into an open turn (T1.2), so an outside turn's approval shows in its wake's mirror turn, and the bridge re-raises open prompts at every turn open. A live card outlives its turn (bb doesn't drop it at turn end, T1.14); an answer after the turn reopens the bound session to reach Hermes, fenced by its generation.

| Hermes event | bb delta |
|---|---|
| `message.start` / `message.delta{text}` / `{text:null}` | `item.open` / `item.textDelta` / `item.textClose` (agentMessage) |
| `reasoning.delta` | `item.textDelta` reasoningText |
| `thinking.delta`, `agent.step` | ignored |
| `tool.start` / `.progress` / `.complete` | `item.open` / `item.progress` / `item.close` by `tool_call_id`; terminal → command, write/patch → fileChange, read → fileRead, web search → webSearch, else tool. `subagent.*` → a tool item |
| `approval.request` / `clarify.request` | `interaction/request` approval / userQuestion; choices never widened |
| `*.settled` (Hermes sends `approval.settled`, never `approval.cancelled`, T1.0) | close the interaction (A3): bb 0.49.0 gives a bridge no way to close a card it raised, and bb's server refuses to cancel a provider card ("stop the turn instead"), so the bridge lists it in `status.dead_requests` and the server stops (releases) the thread once idle, which interrupts the card (matched by `providerRequestId` suffix, one stop per dead set); never an answer |
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
     2. Worker `setBotAccess{on}`: write `<plugin data>/bin/bb-hermes` if missing; render the bundled skill with the wrapper path into `<profile home>/skills/bb-plugin-hermes/` with `.bb-plugin-hermes.json` `{plugin, version, profile_home}`; run `hermes -p <profile> sessions refresh-prompts` (A43, A45) with the folder's own CLI only (`<root>/hermes-agent/{.hermes/bin,venv/bin}/hermes`, never `PATH`: a CLI of another install makes Hermes install a ~1.1 GB runtime into the folder, T1.8), on every on and off call so a retry still reaches the sessions; a refresh past its deadline is left to finish.
     3. Bot thread (after an `ensureWatch` with the new enabled list, so `worker.json` and the catalog list the bot before bb resolves the spawn's model; every keep-alive spawns a missing one): unarchive the existing `bot` binding, else `threads.spawn{providerId:"hermes", environment:{type:"host", hostId, workspace:{type:"personal"}}, sessionOptions:{profile}, title:<bot name>, pinned:true, input:[spawnStart]}`, then `threads.send[init{profile, bot:true}]`, muted, then `markRead` once the init is over (confirmed after a quiet period: bb can report `idle` with nothing queued while it still dispatches a queued turn).
     4. Bot thread not bound yet → `findBotChat` (read-only, here and at every reconcile while `pending`): found → bind and import its turns since `enabled_at − 30 d` (flow 5); `none` → stays `pending`. A legacy Bot Chat Hermes hasn't adopted yet binds at bb's first send in the bot thread, which adopts it (flow 3); its older turns import after that turn.
     5. Unarchive bindings with `archived_by_switch`, clear it, then reconcile: missing turns wake as finished turns (flow 6).
     6. [P2] Import unbound chats active since `enabled_at − 30 d` (flow 5).
   - On needs a connected Hermes; off works offline, and the skill removal is retried at the next reconnect.
   - Off: `bots.enabled = 0`; `threads.stop` each hosted thread of the bot; archive its unarchived threads with `archived_by_switch = 1`; worker deletes the skill dir (only with our marker) and the wrapper if no bot is on, then `refresh-prompts`; watch and wakes skip the profile.
2. **Side chat**
   1. bb's New Thread with the Bot chip (D51), or `bb thread spawn --provider hermes --option profile=<bot>` (A18) → `thread.created` → binding `chat`/`pending` with `expected_id`, before the first turn: the bot from the chip's `bb/session-option-selections`, else the recorded `thread/start` (r13 §3). bb names the thread.
   2. First visible turn: model check → `session.create` → `prompt.submit` → stream → boundary → identity.
3. **Bot thread send** (S8 §Recommended protocol; also legacy Conduit chats from step 3 on)
   1. Resolve each send: `session.list{profile, title:"Bot Chat", include_hidden:true}`. It adopts an unheld legacy Bot Chat (`resolve_titled_session` → `adopt_legacy_session`, T1.7 isolated), so only a bb send uses it; re-lists use the read-only `findBotChat`. `profiles.list.canonical_session: null` doesn't mean none (S8 E6). Cache `chat_id` for dedupe and reads only.
   2. None: re-check, then `session.create{profile, title:"Bot Chat", hidden:true, follow_profile_config:true, request_id:"bb:botchat:<profile_home>"}`. It returns any Bot Chat created meanwhile (E1). Lazy, never at setup: keeps the double-mint window (E12) to the user's first send.
   3. `session.resume{omit_messages:true}` (adopts a legacy row once) → `prompt.submit`. Always submit; the gateway orders it.
   4. `runtime_coordination_required` from lookup, create or resume: keep the bb turn open, banner "Open in another Hermes app: sends when it's free" (A47), retry at 2, 5, 10, 30 s, then every 60 s. Never create, never take over. Stop drops the wait.
   5. Conduit busy: bb's turn queues and shows Hermes' waiting status; no retry (E3a). bb busy, Conduit sends: a foreign admission on bb's subscription, rendered live tagged `[Outside bb]` (E3b).
   6. Title moved (deleted, renamed or re-minted in Hermes, r12 §1): the binding follows the new `lineage_root`, which the bridge reports in `persisted-turn`; bb keeps the old turns, and the old chat is tombstoned (its turns are in the bot thread already). A failed chain read falls back to the listed id, which for a rotated Bot Chat is its root (recorded, `rotated-bot-chat.json`): no false move.
4. **Turn controls:** track bb's own `admission_id`s from `AdmissionStatus`. Approvals, `clarify`, Stop and steer follow the tables; cards show the request's deadline.
5. **Import and replay** (server, one serial queue)
   1. Per chat, oldest first: `readTurns{since}` → binding `replaying` → `turns` rows `replay`. Only history imports: a turn after the cutoff (the bot thread: `enabled_at`; a first-pass chat: the pass's start) is news and wakes as `[Outside bb]`, unread, once the thread is live.
   2. Mirrored chat: `threads.spawn{visibility:"hidden", title, input:[spawnStart]}`, then `threads.send["[Outside bb · Oct 12] "+user0, bind{labeled}]`; bot thread: `threads.send` into it. `spawnStart` is one empty agent-only text: bb derives a thread's immutable `titleFallback` from every text part of the spawn input, agent-only ones included, so no spawn carries a marker. At most 2 import threads at once (one bridge process each). Then `threads.send(queue-if-active, [tag+user_i, replay{labeled}])` per turn (S1-S3 §S1b). bb's own past turns render untagged; no turn names an app.
   3. Once every import turn ran (confirmed as in flow 1 step 3): `update{visibility:"visible"}`, archive if Hermes archived it, `markRead` (only in the bot's first discovery pass after its switch-on, or after the P2 upgrade; a chat started later stays unread, 01 §8), `threads.stop`, `state=live`.
   - The bridge renders from history only; no canonical call (D16).
   - Interrupted (restart, sleep): on boot a `replaying` binding's hidden thread is deleted with its rows and re-queued (R3 S2; A38).
6. **Wake and mirror**
   1. Hint or WAL stat → `changed` → debounced re-list → `readTurns` for each `live` binding of enabled bots. [P2] Unbound allowed chats → flow 5, turns since `enabled_at − 30 d`.
   2. Anchors not in `turns` and not bb's (`submission_id` starts `bb:`, A4): `INSERT OR IGNORE` as `queued`; if inserted, `threads.send{queue-if-active, ["[Outside bb] <text>", mirror{anchor_uid, labeled}]}`. Hidden user row → marker only. A done anchor with a new reply uid → `mirror{rest:true}`. A `/retry` adds a new user row (new uid) and keeps the first turn (T0.5), so it mirrors as a new turn, as Hermes' own view shows it (owner default). bb's own `/retry` turn never mirrors a second time (`persisted_turn` record).
   3. Server sets the thread's level to `input-only` for the mirror turn (approvals and `clarify` still push; S1-S3 §S3c), then restores it.
   4. Bridge, by turn state: complete → render rows. Running as canonical work (CLI, TUI, Desktop, forwarded Conduit) → `session.resume` + `events.since` from the turn's first seq, close on its `message.complete` (A19; R1 S2). No canonical admission (Conduit's own) → render the user row, close `partial`; reply rows arrive by re-list as `mirror{rest:true}` (S8 step 6). No store polling.
   5. Each queued row settles at every `persisted-turn` ingest from the bridge's `mirrored` record of its anchor (replays are recorded too): `done`, or `partial` when more rows can come; a rest row only from a record that covers its claimed reply rows. The bridge keeps the newest 20 records (the state stays under bb's 64 KiB limit): a row whose record left a full window of records all sent after it ran, `done`. A row with no record once the thread is confirmed quiet (flow 1 step 3) failed to render: `partial` with no rows, so a rest wake shows it at the next reconcile; after 3 such tries in one server process it settles `done` (`render_failed`). The finished turn marks the thread unread (bb).
   6. A chat deleted in Hermes (`readTurns` 404): its thread stays (01 §7), no error; it is read again at most every 30 min, so a chat that comes back mirrors.
7. **Compaction and rotation:** in place keeps the id (A-S8d). Rotating: new segment, same `chat_id`; the `Bot Chat` title moves to the tip; rows land on the tip (S8 E8). A subscriber of the root stays on the root: events, replay epoch and `session.info.stored_session_id` keep the root id, and the compress shows as `session.updated` (T1.0 `rotating-viewer`). REST answers for any chain id with the tip's `session_id`; the bridge keeps the lineage root from the chain, and `session.list{title}` names the tip. Cloned rows keep their uids, so nothing renders twice (A8).
8. **Gateway restart:** rediscover and new ticket, backoff 1/2/5/10 s. Bridge: `events.since`; on `snapshot_required`, an epoch change or `truncated` → re-resume. bb's own `unknown` admissions → `prompt.resolve_unknown` at once, turn failed "Hermes restarted: resend?" (S8 E11b). Re-raise open prompts. Worker: full reconcile.
9. **bb or daemon restart:** bridges die; the next turn → `thread/resume{providerThreadId}` (S1-S3 §S1c); retries reuse their `submission_id` (A4). New `worker_boot_id` → full reconcile (~1.9 s, S7 §6); interrupted imports redone; orphaned `queued` turns re-sent or deleted.
10. **Hermes machine offline:** `watch` disconnected → thread banner "<machine> is offline: sends wait until it reconnects" (A9). On reconnect: reconcile; missed outside turns mirror as finished turns.
11. **Hermes version change** (new `version` or `instance_id`): diff `contract/used-surface.json` against `<folder>/hermes-agent/apps/shared/src/gateway-contract.openrpc.json` (A51) and key-check the two REST responses. Fail → health "not supported"; import and mirroring pause; sends continue while their methods are present.
12. **Redeploy:** `bb plugin update hermes` (A26) → RPC `stopHosted` stops idle Hermes threads, busy ones at `thread.idle` → `diagnostics` shows no bridge on the old build (S7 §7).

## Invariants

- **One thread per Hermes chat** `(profile_home, lineage_root)`, checked before every spawn: bb accepts duplicates, then orphans one (S1-S3 fact 4). Imports, wakes and bot threads share one serial queue.
- **One bot thread per enabled bot,** bound by title. A session titled `Bot Chat` never gets its own thread.
- **Source allow-list fails closed:** `source` or, for `source=local`, `created_source` ∈ {`cli`, `tui`, `gui`, `desktop`}; not hidden (Bot Chat apart); ≥ 1 message; not bb-created (`expected_id`, or a `bb:` first submission: never by surface); not tombstoned. Anything else, unknown labels included, stays out.
- **Reading never writes Hermes:** markers never `prompt.submit`; history is REST `read_only`; `thread/resume` and `model/list` never touch sessions; no session before the first visible message; no `session.resume` or `session.mutate` on a legacy row before the first bb send (A23).
- **Events:** drop `replay_epoch == cursor.epoch && seq <= cursor.last` (S0-S4 §S4e). Steer and Stop act only on bb's own admission or a forwarded Conduit one.
- **Turns:** one wake per anchor; bb's rows never mirror; approvals and `clarify` never filtered by admission.
- **Approvals:** never auto-approve; never widen Hermes' choices.
- **Hermes-side writes:** only those a bb user action causes (creates, sends, adoptions, Stop, steer, answers, `/new` compactions, model and reasoning picks, image copies into `<profile home>/cache/images/`, `prompt.resolve_unknown` for bb's own turns), plus the marked skill dir and `refresh-prompts` epochs.
- **Off bot:** no call names that profile except the switch row's read-only count (`listSessions`, `firstSubmissions`; flow 1 "Before on") and removing its skill. Accepted: Hermes' own read of every served profile's store behind the host-scoped `profiles.list{include_sessions:true}` (cached, read-only; nothing from those rows leaves the worker).

## bb access and security

- **What an enabled bot gets** (D43; S8 §Secondary option 1):
  - `<plugin data>/bin/bb-hermes`: sets `BB_SERVER_URL` whenever bb's default (`127.0.0.1:38886`) would miss the server, and `BB_HOST_DAEMON_PORT` when it isn't 38887, from the daemon's per-call environment; then runs `bb` (A44).
  - `<profile home>/skills/bb-plugin-hermes/SKILL.md`: a general bb skill calling the wrapper; bundled in `assets/skill/`, rendered with the wrapper path.
  - No `config.yaml` or `.env` edit, no restart; survives `hermes update` and `hermes profile update --force` (S8 §Secondary).
  - Reach: the bb CLI as the Hermes machine's user, on every thread and machine. Hermes' danger detector flags no `bb` command, so nothing prompts (r12 §4). Restrictions Later.
  - The bot's own bb skills, if any, are untouched.
- **No network credentials:** same-UID socket tickets only; nothing Hermes-related on the bb server; no `experimental_contributeEnv` (r01 G11).
- **Transcripts:** reach bb only as thread content, tool results included (filter Later, D36). Mapping db, `diagnostics` and logs hold ids and bounded codes only (a host error's code is bb's `body.code`, or the code a worker message starts with). `system_prompt`, `model_config` and `origin_json` are never forwarded (r03 §6).
- **Live safety:** the plugin never restarts or starts a gateway or dashboard, and never reads `.env` files.

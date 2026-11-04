# 02 — Architecture

## Components

| Component | Runs on | Entry | Owns |
|---|---|---|---|
| Server part | bb server ($BB_SERVER_HOST, remote) | `server.ts` | Provider registration (hidden, `models.scope:"workspace"`); mapping db; sync service (import, mirror wakes, state sync, bots, handoff); outbox; settings; RPC for app and CLI; realtime events for app navigation |
| Host worker | $HERMES_HOST host daemon (worker process) | `host.ts` default export, `experimental_defineHostEntry` | One host-scoped canonical connection; change watch (`sessions.changed` + `state.db-wal` stat); list, read, mutate for the server; writes `bindings.json`; signals |
| Bridge | $HERMES_HOST host daemon, one process per hosted thread (S1-S3 fact 2) | `host.ts` export `experimental_providerBridge` | Its own canonical connection; turns; deltas; interactions; replay and mirror rendering |
| App | bb UI | `app.tsx` | `navPanel`, `homepageSection`, ⇧⌘H command (via `experimental_appOverlay`, S7 §3); `settingsSection` health; navigation with `useBbNavigate` |
| Canonical client | library in worker and bridge | `src/hermes/` | Discovery, ticket, dial, RPC, replay cursors. Ported from `spike-hermes/src/hermes/` |
| `bb_tools` Hermes plugin | Hermes gateway process, $HERMES_HOST, each enabled profile | `hermes-plugin/bb_tools/` | Native `bb` toolset wrapping the `bb` CLI; Discord echo hook |

```
bb server ($BB_SERVER_HOST)                        $HERMES_HOST
┌───────────────────────┐   host RPC    ┌────────────────────────────────────────────┐
│ server part           │──────────────▶│ host worker ─┐                             │
│  mapping db, outbox,  │◀── signals ───│              ├─ gateway.sock (ticket)      │
│  sync, settings, RPC  │               │ bridge × N ──┘   └▶ /api/ws hermes-gateway-v1
│                       │── turns ─────▶│ (host daemon)       Hermes gateway (all profiles)
└───────────────────────┘               │ bb_tools (in gateway) ── bb CLI ──▶ bb server
                                        └────────────────────────────────────────────┘
```

Placement facts:
- The server part can't reach `gateway.sock`. Every Hermes read or write goes through the host worker (host RPC, 30 s timeout; 01 §1) or a bridge.
- Worker and bridges reach Hermes only via `~/.hermes/gateway.sock`: `identify` → `session-ticket{scope:"host"}` → `/api/ws` with subprotocols `["hermes-gateway-v1","hermes-gateway-ticket.<t>"]` (S0-S4 §S4a, cheat-sheet 1). Rediscover on every connect (the port changes per restart). Add the `gateway.sock.path` pointer fallback (S0-S4 open).
- Never call anything that can start or replace a gateway (08 §2, 09 M5).

## Mapping db (`bb.storage.database()`, SQLite on the server)

`bindings`: one row per Hermes-backed thread. `UNIQUE(profile_home, lineage_root)`.

| Column | Type | Note |
|---|---|---|
| `thread_id` | text PK | bb thread |
| `profile_home` | text | Hermes `profile_id` (home path). Key, not the name: david's DB holds `todoist` rows (03 §4) |
| `lineage_root` | text | Hermes logical id: `chat_id` owner, stable across compaction (11 §3) |
| `session_id` | text | current physical tip |
| `kind` | text | `chat` · `import` · `bot` · `subagent` · `handoff` |
| `source` | text | Hermes `created_source` or `source` (`cli`, `tui`, `desktop`, `discord`, …) |
| `session_key` | text null | messaging route key (Discord), for `bindings.json` |
| `parent_thread_id` | text null | subagent parent |
| `project_id` | text null | |
| `state` | text | `pending` (no Hermes session yet) · `replaying` · `live` · `upstream_deleted` |
| `mirrored_row_id` | int | last Hermes message row rendered in bb |
| `revision` | int | last seen Hermes `revision` |
| `synced` | json | last value each side wrote: `{pinned, archived, title, read}` (echo suppression) |
| `created_at`, `updated_at` | int | |

Other tables:
- `tombstones(profile_home, lineage_root, reason, at)`: never import. Written on bb delete (Q1). A failed import leaves no binding and is retried at the next reconcile.
- `outbox(id, thread_id, op, payload, attempts, next_at)`: bb → Hermes mutations held while the worker is unreachable.
- `kv(key, value)`: `first_import_done`, `last_reconcile_at`, worker identity `{uid, instance_id, authority_epoch}`.

bb-created ids: `lineage_root = session_id = "local-" + sha256(json([profile_home, "uid:<uid>", "bb:<threadId>"]))` (S0-S4 §S4b). The server computes it at spawn from the worker's `describe` (uid, homes), so the feed recognises the session before the bridge creates it. A profile pick on an empty chat recomputes both.

`providerThreadId` = `<profile_home>#<lineage_root>`. Announced only at a turn boundary (S1-S3 fact 1).

No transcript text is stored in the mapping db.

## Contracts

### Markers (`src/shared/marker.ts`; agent-only `<hermes-bb>{json}</hermes-bb>`)

| `op` | Fields | Sent by | Bridge action |
|---|---|---|---|
| `init` | `profile, handoffFrom?` | empty-chat spawn; profile pick on an empty chat (S7 §1c) | Store profile; publish chip + catalog; no Hermes call |
| `bind` | `profile_home, lineage_root, session_id` | first turn of import, bot, subagent | Resume, render turn 0 from transcript |
| `replay` | `index` | import turns 1…n−1 | Render turn i from transcript |
| `mirror` | `after_row_id, user_row_id?` | wake | Render the outside turn; attach live if running |
| `rebind` | `lineage_root, session_id` | Bot Chat re-minted | Re-announce identity after the boundary |

### Server ↔ host worker (`src/shared/host-contract.ts`)

| Call | Input → output |
|---|---|
| `ensureWatch` | `{}` → `{connected, instance_id, authority_epoch}`. Idempotent; called every 60 s by a `bb.background.service`. Mandatory: without it the worker is killed at 300 s with no exit event (S7 §6) |
| `describe` | `{}` → `{uid, version, capabilities, profiles[{name, home, handle, bot_chat{id, resolved_id}}]}` |
| `models` | `{profile}` → `model.options` rows, cached (cold default 15.5 s; 11 §1) |
| `listSessions` | `{profile?, since?}` → rows `{profile_home, session_id, lineage_root, session_key, title, source, created_source, cwd, parent_session_id, message_count, started_at, last_activity_at, pinned, archived, last_read_at, running, revision}`. Field source: ASSUMED A1 |
| `readTurns` | `{profile_home, session_id, after_row_id, limit}` → `[{user_row_id, text, origin, author_id, final_row_id}]` |
| `mutate` | `{profile_home, session_id, op, payload, expected_revision}` → `{revision}` |
| `export` | `{profile_home, session_id, max_bytes}` → trimmed `session.export{format:"md"}` (handoff) |
| `setBindings` | `{rows}` → writes `bindings.json` |

Signals (worker → server): `changed{profile_homes[]}` (debounced) and `watch{state, instance_id}`. Latency 0–4 ms (S7 §6). Signals are ephemeral: the server re-lists on every (re)connect.

Change watch: canonical `sessions.changed` is a hint only. Sibling profiles may never be watched, and `unread` isn't covered (11 §8). The worker also stats each profile's `state.db-wal` mtime every 2 s and re-lists only that profile.

### Bridge state

- `<bridge dataDir>/threads.json`: `{threadId: {profile}}`. Needed only before the Hermes session exists: `sessionOptions` reaches the bridge only when it differs from what was last published (S7 §1a). After that, the profile comes from `providerThreadId`.

### Files on $HERMES_HOST (written by the host worker, read by `bb_tools`)

- `~/.hermes/bb_tools/bindings.json`, mode 0600:
  - key `"<profile_home>|<logical id>"`, or `"<profile_home>|<session_key>"` for messaging routes;
  - value `{thread_id, project_id, environment_id, server_url, daemon_port}` (11 §5).
  - Writer: the worker, not the bridge as 11 §5 suggests, because bridges are short-lived and see one thread each.
- `~/.hermes/bb_tools/echo.json`: echo fallback only, if the private `admission_author` import fails (11 §4). The bridge writes `{session_key, sha256(text), expires}` before `prompt.submit`.

## Protocol mapping

bb runtime → bridge → Hermes:

| bb method / input | Hermes call | Notes |
|---|---|---|
| `initialize` | — | caps `sessionRestore`, `threadArchive`, `threadRename`, `approvalEnforcedBy:"provider"`, grammar v3 |
| `provider/health` | — | always `not_installed` (hide, S1-S3 §S3a). Real health is the worker's `ensureWatch` |
| `model/list` | `model.options{profile}` via cache | Never creates a session (09 M6). `cwd` → thread → profile when present; the published catalog is authoritative (S7 §1c) |
| `thread/start` | none | Placeholder identity `pending:<threadId>`; emit `bb/session-options` (all visible profiles) + `bb/provider-model-catalog`. Profile = `sessionOptions.profile`, else bridge state, else `deriveProviderOptions` → Settings default (threads made outside our UI) |
| `thread/resume{providerThreadId}` | `session.resume{profile, session_id, omit_messages:true}` | Then `events.since` for the cursor. Nothing for `pending:` ids |
| `turn/start`, visible text, `state=pending` | `session.create{profile, request_id:"bb:<threadId>", source:"cli", cwd?, model, provider}` then `prompt.submit` | Lazy create; `cli` keeps `clarify` (S0-S4 §T3). Model checked against `model.options` |
| `turn/start`, visible text | `prompt.submit{session_id, text, submission_id:"bb:<threadId>:<clientRequestId>", turn_author:{id:"bb:<threadId>", name:<bb user name>}}` | `turn_author` drives the echo (11 §4). Handoff: text = handoff block + message (11 §7) |
| `turn/start`, `bind`/`replay`/`mirror`/`init` marker | none, or `session.resume` | Never `prompt.submit` |
| `turn/steer` during a bb turn | `session.steer{execution_generation, text}` | `stale_generation` → `prompt.submit` (S0-S4 §S4d) |
| `turn/steer` during a mirror turn | `prompt.submit` (queued) | S1-S3 §S2c |
| `thread/stop{interrupt}` | `session.interrupt{execution_generation}` | Wait for `message.complete{status:"interrupted"}` |
| `thread/stop{release}` | `session.detach` + close socket | |
| `thread/archive`, `thread/unarchive`, `thread/name/set` | none | The server is the single writer (§flows 8) |
| interaction answer | `approval.respond{prompt_id, choice, execution_generation}` / `clarify.respond{answer}` | `already_resolved` → close silently |
| model pick mid-chat | `session.mutate model{model, provider}` while idle | 11 §1 |
| `turn/start.model` not offered for the profile | none | Map to the profile default + `provider.warning` (S7 finding 6) |
| `turn/start.options.sessionOptions.profile` changed, chat has messages | none | Refuse the turn with a message; the server hands off (S7 §1d) |

Hermes events → bb deltas (in the open turn; only events of this turn's `admission_id`, or the mirrored admission):

| Hermes event | bb delta |
|---|---|
| `message.start` | `item.open` agentMessage |
| `message.delta{text}` / `{text:null}` | `item.textDelta` agentMessage / `item.textClose` (segment boundary) |
| `reasoning.delta` | `item.textDelta` reasoningText |
| `thinking.delta`, `agent.step` | ignored (spinner text, S0-S4 cheat-sheet 7) |
| `tool.start` / `tool.progress` / `tool.complete` | `item.open` / `item.progress` / `item.close`, id = `tool_call_id`. Kind by tool: terminal → command, write/patch → fileChange, read → fileRead, web search → webSearch, else tool |
| `approval.request` | `interaction/request` approval (command or file_change), choices narrowed to Hermes' list |
| `clarify.request` | `interaction/request` userQuestion (`supportsNativeUserQuestion:true`) |
| `approval.settled` / `clarify.settled` / `approval.cancelled` | close the pending interaction (ASSUMED A3) |
| `subagent.*` | `item.open/close` delegation, linked to the sub-thread (ASSUMED A6) |
| `todo.updated` | planSteps item |
| `session.usage` / `message.complete.usage` | `contextWindow` / `usage` |
| `session.info{stored_session_id}` change | follow the new tip; `context.compacted` |
| `message.complete{status}` | `turn.boundary` completed / interrupted / failed |
| `error` | `provider.error` |

## Sequence flows

1. **New chat**
   1. App → RPC `newChat{profile, projectId?}`.
   2. Server: worker `describe` (cached) → compute the bb-created id → insert binding `state=pending` → `threadNotifications.set(muted)` → `threads.spawn{providerId:"hermes", projectId, environment, sessionOptions:{profile}, title:"New <Profile> chat", input:[init]}` → return `threadId`; the app navigates (`useBbNavigate`).
      - Personal: `{type:"host", hostId:<$HERMES_HOST>, workspace:{type:"personal"}}` (S1-S3 §S3b).
      - Project: `{type:"provider", environmentProviderId:"project-checkout", inputs:{}, machine:{type:"existing", hostId:<$HERMES_HOST>}}`; `inputs:null` fails (S7 §5).
   3. Bridge: `thread/start` → placeholder identity; init turn → chip + catalog, empty turn. Server on idle: `markRead`, restore the notification level.
   4. First visible `turn/start` → model checked (unoffered → default) → `session.create{cwd: project root or omitted}` (idempotent by `request_id`) → `prompt.submit` → stream → `turn.boundary` → `thread/identity`.
   5. Worker re-list sees the new id → matches the binding → `state=live`. Never imported.
   6. Threads made outside our UI (`bb thread spawn --provider hermes`, bb's own handoff): the server inserts the binding on `thread.created` (`providerId:"hermes"`, no binding yet), then steps 3–5 apply.
2. **Turn with approval, clarify, interrupt, steer**
   1. `turn/start` → `input.accepted` + `turn.open` → `prompt.submit`.
   2. `approval.request` → bb card with deadline → answer → `approval.respond`. `approval.settled` without our answer → close "Answered elsewhere / timed out".
   3. `clarify.request` → user question → `clarify.respond` (`""` = skip).
   4. Stop → `session.interrupt` → `turn.boundary interrupted` before responding (protocol rule).
   5. Steer → `session.steer`, falling back to a queued `prompt.submit`.
3. **Import** (first run and new sessions)
   1. Server: `listSessions` (window) → filter (§invariants) → ascending `last_activity_at` → for the first run, `importPreview` counts and user OK.
   2. Per session, serially:
      1. `readTurns(after 0)`;
      2. placement: cwd at or under a $HERMES_HOST project root → that project, `project-checkout` environment; else personal;
      3. insert binding `replaying`;
      4. `threads.spawn{visibility:"hidden", title, input:["[Src] "+user0, bind]}`, no `sendAt`;
      5. `threads.send(queue-if-active, ["[Src] "+user_i, replay i])` for i ≥ 1 (S1-S3 §S1b).
   3. Bridge: `session.resume{omit_messages:false}` → render each turn from the transcript (ASSUMED A8: root → tip segments). Identity after the first boundary.
   4. Server: wait idle → `update{visibility:"visible"}` → `markRead` → notification level → `threads.stop` (release the process) → `state=live`, `mirrored_row_id`.
   5. A session with no user line spawns with `bind` only.
4. **Wake + mirror** (idle and hosted take the same path)
   1. Hermes write → `sessions.changed` or a WAL stat → worker signal `changed{profile_homes}` → server debounced re-list.
   2. Bound sessions with new rows → `readTurns(after mirrored_row_id)`. Drop bb-originated rows (`author_id` prefix `bb:`; ASSUMED A4).
   3. Per outside user line: `threads.send{queue-if-active, ["[<Source>] <text>", mirror{after_row_id, user_row_id}]}`. It renders as the user's bubble, in order (S7 §8). No user line → marker only.
   4. bb hosts the thread if needed (`thread/resume`). The bridge renders rows after `user_row_id`; if the turn is still running it attaches live (dedupe by `(replay_epoch, seq)`) until `message.complete` → boundary.
   5. Server advances `mirrored_row_id` once `readTurns` reports `final_row_id`.
   - Bridge-opened turns (S1-S3 §S2b) are not used: they can't show the tagged user bubble.
5. **User input during a mirror turn**
   - `turn/steer` → `prompt.submit` queued → `input.accepted` into the open turn ("Steer" label). The turn stays open until that admission completes.
   - `--mode queue` → a later `turn/start` → a normal turn (S1-S3 §S2c).
6. **Discord reply + echo**
   1. bb send on a thread bound to a Discord session → `prompt.submit{turn_author:{id:"bb:…"}}` (fallback: write `echo.json` first).
   2. Hermes drains on the Discord route → `pre_llm_call` in `bb_tools` → `ctx.post_message("$OWNER_NAME (via bb): …")` blocks ≤ 30 s → the reply streams to Discord and to viewers (11 §4, 08 §4).
   3. Detached (rolled over) → viewers only. The bridge emits `provider.warning` "Not posted to Discord…" (Q3). Detection: the route's current session (`gateway_routing`) is no longer this one (ASSUMED A10).
7. **Profile handoff**
   1. bb saves the pick as `bb/session-option-selections`. The server reads it via `experimental_thread.events` + `threads.events.list` (≤ 100 per page) and checks `threads.promptHistory` (S7 finding 2).
   2. Has messages → `newChat{profile:B, projectId, handoffFrom}` → `threads.update({sessionOptions:{profile:null}})` on the old chat → realtime `handoff{from, to}`. The app overlay navigates if the current route is `from` (ASSUMED A17); otherwise `threads.open`.
   3. The new thread's first visible `turn/start` → `session.create{profile:B, cwd}` → worker `export` of the old session (≤ ~25 kB, last turns) → `prompt.submit{text:"<handoff from @A, session <id>>…</handoff>\n\n"+message, title_preview:message}`. Never `api_text` or `display_kind:"hidden"` (11 §7).
   4. Empty chat: the server sends an `init{profile}` turn (muted, then `markRead`); the bridge republishes chip and catalog (~250 ms, S7 §1c). No Hermes call.
8. **State sync bb → Hermes**
   1. `sdk.subscribe("thread:changed")` diff plus `thread.archived/unarchived/deleted` events (01 §4), for Hermes threads only.
   2. Skip if equal to `synced` (our own echo), or a bot rename/archive (Q2), or an ACP thread.
   3. Worker `mutate`: `sidebar{pinned}`, `archive{archived}`, `rename{title}` with `"[bb] "` stripped (S1-S3 §S3c), `sidebar{unread:false}`, using `expected_revision`.
   4. `revision_conflict` → retry with the returned revision (S0-S4 §S4g). Worker unreachable → outbox.
9. **State sync Hermes → bb**
   1. Re-list differs from `synced` → `pin/unpin`, `archive/unarchive`, `update{title}`, `markRead/markUnread` → record in `synced`.
   2. Row gone → `upstream_deleted`: archive, banner, the bridge refuses turns (Q1).
10. **Bot Chat rotation**
    - On each `changed`, the worker re-runs the `Bot Chat` title lookup per profile (11 §3).
    - Same root, new `resolved_id` → update `session_id` only.
    - New root → `rebind` marker turn → identity re-announced after the boundary.
11. **Compression continuation**
    - Hermes compresses → new physical segment, same logical id (11 §3). The bridge follows `session.info.stored_session_id`; the worker reports `resolved_id`; `providerThreadId` is unchanged.
12. **Reconnect** (gateway restart)
    1. Socket closes (`1013` or a drop) → rediscover + new ticket, backoff 1/2/5/10 s.
    2. Bridge: `events.since(last_sequence, replay_epoch)`. On `snapshot_required`, an epoch change or `truncated` (512-event ring, 06 §2) → `session.resume` and render rows after the last rendered row.
    3. A turn killed by the restart → `turn.boundary failed` + "Hermes restarted". Open `prompts` in the snapshot → re-raise any interaction not already open.
    4. Worker: full reconcile re-list.
13. **bb or daemon restart**
    - Bridges die. The next turn → `thread/resume{providerThreadId}` (S1-S3 §S1c).
    - A turn retried after restart reuses its `submission_id` (ASSUMED A4: Hermes runs it once).
    - The worker restarts → server `ensureWatch` reconnects (~1.9 s after a bb restart, S7 §6) → reconcile. The server outbox survives server restarts.
14. **$HERMES_HOST asleep**
    - Hermes, the worker and bridges are all down; the bb server is up.
    - The form and nav show "$HERMES_HOST offline" (`watch disconnected`). bb sends to Hermes threads: ASSUMED A9.
    - bb-side state changes go to the outbox.
    - On wake: `watch connected` → reconcile → flush outbox → mirror missed turns as finished turns.
15. **Hermes tool → bb CLI**
    1. The model calls `bb_thread_spawn{…}`. The handler reads `HERMES_SESSION_CHAT_ID` or `HERMES_SESSION_KEY` (11 §5) → looks up `bindings.json`.
    2. `subprocess.run(["bb","thread","spawn",…,"--json"], env={PATH, BB_SERVER_URL, BB_HOST_DAEMON_PORT, BB_THREAD_ID, BB_PROJECT_ID, BB_ENVIRONMENT_ID}, timeout<420)`, values from `bindings.json`. Minimal env: never `os.environ` (gateway secrets).
    3. Result → JSON string. Unbound session → act without a thread context (ASSUMED A12). Errors → `tool_error`.
16. **Redeploy of the per-thread bridge** (S7 §7)
    1. Install the new tag (or `bb plugin reload`). Server, app and host worker switch at once; the worker reconnects in ~90 ms. Hosted bridges keep the old artifact.
    2. RPC `stopHosted`: `threads.stop` each idle Hermes thread (28 in 0.16 s). Busy ones are stopped on their next `thread.idle`, never interrupted.
    3. The next turn → `thread/resume`, same `providerThreadId`, new build. Mirrored threads re-host on their next wake.
    4. Verify: the bridge's build id in `initialize` logs.

## Invariants and dedupe rules

- One bb thread per `(profile_home, lineage_root)`. Check before every spawn (bb accepts duplicate handles, then orphans one: S1-S3 fact 4). Imports and handoffs run through one serial queue.
- Never import:
  - empty sessions;
  - `source=acp` / `created_source=acp` (09 M6);
  - bb-created ids;
  - tombstones;
  - Bot Chats, except as bots;
  - subagents, except under their parent;
  - cron and one-shot unless toggled on.
- A turn carrying a marker never calls `prompt.submit`. `model/list` never creates a session. No Hermes session exists before the first visible message.
- Identity is announced only at a turn boundary.
- Events: drop when `replay_epoch == cursor.epoch && seq <= cursor.last`. Dedupe before the `session.resume` answer lands (S0-S4 §S4e).
- Mirror: each Hermes user row is rendered once (`mirrored_row_id` is monotonic). bb-originated rows are never mirrored.
- State sync:
  - the server part is the only writer of bb → Hermes state;
  - an inbound value equal to `synced` is ignored;
  - titles are stripped of `"[bb] "`;
  - Hermes titles are unique per DB, so a duplicate-title refusal retries with `" (2)"` (03 §1).
- Never auto-approve; never widen Hermes' choices.
- The bot `Bot Chat` title is never changed by bb.

## Security

- **No network credentials:** same-UID unix-socket tickets only (S0-S4 §S0). Nothing Hermes-related is stored on the bb server. No values via `experimental_contributeEnv` (01 G11).
- **Private transcripts:**
  - transcript text reaches bb only as thread content, like any bb thread;
  - the mapping db and plugin logs hold ids and metadata, never text;
  - never forward `system_prompt`, `model_config` or `origin_json` (03 §6).
- **CLI env in Hermes:**
  - `bb_tools` gets `BB_*` per call from a 0600 file and passes a minimal env;
  - Hermes sessions in enabled profiles, Discord included, can drive bb. See Q5: approval for spawn and tell in Discord-origin sessions via `pre_tool_call` (10 Q5 table);
  - the tool set is fixed: no generic `bb` passthrough.
- **Never auto-approve:**
  - the bridge only relays the user's choice;
  - bb permission modes must not answer (ASSUMED A2);
  - tests use quoted throwaway paths (the S0-S4 §S4c incident).
- **Live safety:**
  - no gateway or dashboard restarts from the plugin;
  - `reload-plugins` reloads every plugin in that profile, Conduit included (11 §5), so it's a delivery step, not runtime behaviour.

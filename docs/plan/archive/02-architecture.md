# 02 — Architecture

## Components

| Component | Runs on | Entry | Owns |
|---|---|---|---|
| Server part | bb server ($BB_SERVER_HOST, remote) | `server.ts` | Provider registration (hidden, `models.scope:"workspace"`); mapping db; sync (import, wakes, state push, bots, handoff); settings; RPC incl. `diagnostics` (with bb-started Hermes messages per week, the D34 metric) and the daily `audit`; `message.dispatch` hook (D15, D39); realtime events for navigation |
| Host worker | Hermes host daemon ($HERMES_HOST today), worker process | `host.ts` default export (`experimental_defineHostEntry`) | One host-scoped canonical connection; change watch; history reads (from P2); mutations; model prewarm; drift check; signals |
| Bridge | Hermes host daemon, one process per hosted thread (S1-S3 fact 2) | `host.ts` export `experimental_providerBridge` | Own canonical connection; turns; deltas; interactions; replay and mirror rendering; the sensitive-tool filter on every tool item (D36, `src/shared/sensitive-tools.ts`) |
| History reader (P2) | library in worker and bridge | `src/hermes/history.ts` | Read-only Hermes session history: Hermes' REST projection first, `state.db` fallback (rules below) |
| Canonical client | library in worker and bridge | `src/hermes/client.ts` | Discovery, ticket, dial, RPC, replay cursors (from `spike-hermes/src/hermes/`) |
| App | bb UI | `app.tsx` | Rail panel, home send-menu rows, ⇧⌘H (`experimental_appOverlay`, S7 §3), row metadata, thread banner, settings; `useBbNavigate` |

```
bb server ($BB_SERVER_HOST)                     Hermes host ($HERMES_HOST)
┌────────────────────┐  host RPC   ┌─────────────────────────────────────────────┐
│ server part        │────────────▶│ host worker ─┬─ gateway.sock → /api/ws        │
│  mapping db, sync, │◀─ signals ──│              │   (hermes-gateway-v1, writes   │
│  settings, RPC     │── turns ───▶│ bridge × N ──┘    + live events)              │
└────────────────────┘             │  └ both, from P2: history reader → REST       │
                                   └─────────────────────────────────────────────┘
```

No plugin code runs inside Hermes. Hermes reaches bb only through the `bb` CLI from its terminal, guided by skills (D37, 01 F11).

Placement rules:
- The server can't reach the Hermes host's files or `gateway.sock`. All Hermes I/O goes through the worker (host RPC, 30 s timeout; r01 §1) or a bridge.
- **Hermes host** (a bb host id) and **Hermes root** are required server settings (D30): $HERMES_HOST and `~/.hermes` on live, the fake's root in e2e.
  - Logic never names $HERMES_HOST. Placement, `ensureWatch` and error texts use the setting; moving Hermes means changing it.
  - The root reaches the worker in `ensureWatch{root}` and the bridges via `deriveProviderOptions`.
  - Unset → health `unconfigured`, no Hermes I/O (R3 M3).
- Canonical connection:
  - `identify` → `session-ticket{scope:"host"}` → `/api/ws` with subprotocols `["hermes-gateway-v1","hermes-gateway-ticket.<t>"]` (S0-S4 cheat-sheet 1);
  - rediscover on every connect; add the `gateway.sock.path` fallback;
  - never call anything that can start a gateway (r09 M5).
- **Reads come from Hermes history (P2 on), writes and live events from canonical.**
  - `session.resume` adopts pre-migration rows irreversibly (R1 M7) and carries no `message_uid` (R1 M2).
  - So lists, transcripts and origins are history reads. P0–P1 read no history at all: the P1 handoff block comes from bb's own timeline (flow 6, R6 C4).
  - `session.resume` runs only for a bb send, or to watch a turn that is running in the gateway (D16).

History reader rules (R4 M3, R6 C3):
- **Which reader:** T2.0b spikes Hermes' own REST projection first and records the pick in `docs/operations.md`.
  - REST (first choice): `GET /api/sessions` and `GET /api/sessions/{id}/messages` on the gateway's own listener (`api_origin` from `identify`). Auth: a `native-http` ticket minted on `gateway.sock` per request, as Hermes Desktop does (`apps/desktop/electron/local-gateway.ts:487`). The route reads `read_only=True`, includes compression ancestors and applies Hermes' display projection (`hermes_cli/web_routers/sessions.py:671-787`). No credential, config change or port: D1's trust model. Unavailable while the gateway restarts; reads then wait.
  - Fallback: TypeScript on `node:sqlite` with `readOnly` (A36). It must re-implement the projection, so it is used only if REST lacks a field we need.
  - Not a candidate: `<hermesRoot>/hermes-agent/venv` is webui's Python 3.11 environment, not Hermes' runtime (R6 C3).
- **Oracle:** golden files and audit anchors always come from Hermes' REST projection, never from our reader.
- **Change detection:**
  - REST → a key check of the list and messages responses (fields we read present, types unchanged).
  - TS fallback → `schema_version` (32 at `c314285f07`) plus a per-profile table check (`delivery_obligations` exists only in default and david, R6).
  - Unknown shape: pass → continue, health warns; fail → pause import and mirror (no partial guesses). Pushes and bb-started chats don't read history, so they keep working; health red.
- **TS fallback only:** exclude `_compressed_summary=1`, `display_metadata.compaction_inflight_task_restatement` and hidden `display_kind` rows; honour `absorbed_message_uids`. Hermes' projection has more rules (`[System: …]` scaffold rows, steers, withheld prompts, R6 C3), checked against the oracle.
- **Author:** bb rows carry `bb:` in `display_metadata.submission_id` (REST, A4); the TS fallback joins `session_admissions` → `cli_turn_v1.turn_author`.

## Mapping db (`bb.storage.database()`, SQLite on the server)

`bindings`: one row per Hermes-backed thread. `UNIQUE(profile_home, lineage_root)`.

| Column | Note |
|---|---|
| `thread_id` PK | bb thread |
| `profile_home` | Hermes `profile_id` (home path), not the name: david's DB holds `todoist` rows (r03 §4) |
| `lineage_root` | Hermes logical id (`chat_id` owner), stable across compaction (r11 §3) |
| `session_id` | current physical tip |
| `kind` | `chat` · `import` · `bot` · `subagent` · `handoff` |
| `source`, `origin` | raw `source`/`created_source`, and the tag shown (`CLI`, `Discord`, …) |
| `parent_thread_id`, `project_id` | |
| `state` | `pending` (no Hermes session yet) · `replaying` · `live` |
| `legacy` | pre-migration row, not adopted yet (D16) |
| `pushed` | `{pinned, archived, title}` Hermes holds from bb, or read once at import (D38) |

`source = discord` makes a binding read-only (D39).

`turns`: one row per Hermes turn bb has shown or queued. PK `(thread_id, anchor_uid)`.
- The anchor is the Hermes `message_uid` of the turn's user message, or of its first assistant message if there is none.
- uids survive compaction clones and `/retry` rewrites; row ids don't (R1 M2).
- Columns: `kind` (`replay` · `mirror` · `bb`), `state` (`queued` · `done` · `partial`), `reply_uids`, `at`.
- **Wake atomicity** (R1 M1, R4 S7): `INSERT OR IGNORE`, then send only if the row was inserted; a send error deletes the row.
  - On boot, `queued` rows with no bb turn are re-sent or deleted.
- **`/retry`** (R4 S1): the same anchor gets a new reply uid → `mirror{anchor_uid, rest:true}`, rendered as "Retried in <source>".
- **bb's own turns:** recorded as kind `bb` from the bridge's `hermes/persisted-turn` extension state at each boundary (A37). This is a second dedupe, beside the author join.

Also:
- `tombstones(profile_home, lineage_root, reason, at)`: never import. Written on bb delete (Q1).
- `kv`: `worker_boot_id`, `last_reconcile_at`, `first_import_done`, worker identity `{uid, instance_id}`.
- No outbox. On reconnect the server pushes bb values that differ from `pushed` (R1 S14).
- Migrations run in one transaction at load and are additive. `VACUUM INTO` a copy before the first live import and before any plugin remove (R3 S3, M2).

Identity rules:
- bb-created id: `"local-" + sha256(json([profile_home, "uid:<uid>", "bb:<threadId>"]))` (S0-S4 §S4b).
  - Computed right after `threads.spawn` returns; the thread id doesn't exist before (R1 M3).
  - Provisioning takes seconds (S7 §2), so the binding lands before the first turn reaches the bridge.
- Every spawn carries `pluginMetadata.hermes.origin`. The `thread.created` handler skips those and binds only threads made elsewhere (`bb thread spawn`, bb's own handoff).
- `providerThreadId` = `<profile_home>#<lineage_root>`, announced only at a turn boundary (S1-S3 fact 1).
- No transcript text is stored on the server.

## Contracts

### Markers (agent-only `<hermes-bb>{json}</hermes-bb>`, `src/shared/marker.ts`)

| `op` | Fields | Sent on | Bridge action |
|---|---|---|---|
| `init` | `profile, handoffFrom?{thread_id, title, block}` | empty-chat spawn; profile pick on an empty chat | Refused unless identity is `pending:` (R1 M9). Saves profile + handoff block to `threads.json`; publishes chip + catalog |
| `bind` | `profile_home, lineage_root, legacy, readOnly, anchor_uid` | first import or subagent turn | Bind; render that turn from history. `readOnly` (Discord) → chip shows the `discord` value |
| `replay` | `anchor_uid` | later import turns | Render that turn from history |
| `mirror` | `anchor_uid, rest?` | wake | Render or watch the outside turn (flow 4) |

Input parsing (R1 M6): bb may merge queued sends into one turn.
- The bridge splits the input into ordered segments: each marker plus the visible text before it.
- Visible text with no marker is a bb prompt → `prompt.submit`.
- Several markers render in order within the one turn.

### Server ↔ host worker (`src/shared/host-contract.ts`)

| Call | Input → output |
|---|---|
| `ensureWatch` | `{root}`, called on the Hermes host → `{worker_boot_id, connected, instance_id, version}`. Every 60 s, mandatory: an idle worker dies at 300 s with no exit event (S7 §6). A new boot id → full reconcile (R1 S8) |
| `describe` | → `{uid, profiles[{name, home, handle, terminal_cwd}]}` |
| `models` | `{profile}` → `model.options` rows. All visible profiles are prewarmed on connect (R2 S9) |
| `listSessions` | `{profile_home?, since?}` → history rows `{session_id, lineage_root, title, source, created_source, origin_platform, cwd, parent_session_id, message_count, started_at, last_activity_at, pinned, archived, legacy}`. No `running`: it means "mounted" (R1 S15) |
| `readTurns` | `{profile_home, lineage_root, after_uid?}` → `[{anchor_uid, user_text, origin, author_id, submission_id, reply_uids, ts, complete}]`, `active=1` turn rows from root to tip |
| `mutate` | `{profile_home, session_id, op, payload}` → `{revision}`. The worker adds `request_id`, `expected_revision` and `expected_generation` |
| `diagnostics` | → worker pid, uptime, boot id, watch state, drift result, bridge build registry |

Signals (worker → server, 0–4 ms, S7 §6):
- `changed{profile_homes[]}`, debounced. A new worker treats its first WAL stat as changed.
- `watch{state}`.

Change watch: `sessions.changed` is only a hint; siblings may be unwatched (r11 §8). The worker also stats each profile's `state.db-wal` every 2 s.

Drift check (D20), run by the worker on connect whenever the version or `instance_id` changes:
- diff the used surface (`contract/used-surface.json`) against `<hermesRoot>/hermes-agent/apps/shared/src/gateway-contract.openrpc.json` (P0);
- from P2, the history check above (REST keys, or schema + tables + `is_compaction_scaffolding`/`_display_dedupe_key` source hashes for the TS fallback);
- every `provides_tools` entry in `<hermesRoot>/plugins/conduit_push/plugin.yaml` matches a D36 prefix.
- Results go to `diagnostics`, health and `bb.log`.
- No human steps (D20): the worker also runs `contract:check --incoming` daily, and from P2 the semantic canary on each version change if it can drive isolated Hermes; otherwise health shows "canary due" (03 §8).

Audit (D20; daily, server `bb.background.schedule`):
- per live binding, compare Hermes anchors (from the REST projection, R6 C3) with the `turns` rows and the markers rendered in the bb thread;
- report duplicates (one anchor rendered twice) and gaps (an anchor never rendered) in health and `diagnostics`;
- it changes nothing itself. It feeds the soak gates (03) and the silent-drift kill criterion (05).

### Bridge state (`<bridge dataDir>/`)

- `threads.json`: `{threadId: {profile, handoffFrom?, handoffBlock?}}`. Needed before the Hermes session exists. `sessionOptions` arrives only when it changes (S7 §1a).
- `bridges/<pid>.json`: `{build, threadId, startedAt}`, read by the worker for `diagnostics` (A22).
- `models/<profile>.json`: last-known model list; validation never waits on a refresh.

## Protocol mapping

bb runtime → bridge → Hermes:

| bb method / input | Hermes call | Notes |
|---|---|---|
| `initialize` | — | `sessionRestore`, `threadArchive`, `threadRename`, `approvalEnforcedBy:"provider"`, grammar v3. `permissionModes:["auto"]`, the closest to Hermes' smart approvals (A2, D17); Hermes reasoning levels, `supportsNativeUserQuestion:true`, `supportsManualCompaction:true` (A33), `fork:"checkpoint"` or `"tip"` (A34) |
| `provider/health` | — | `not_installed`, always (hides Hermes, S1-S3 §S3a) |
| any turn on a host other than the Hermes host | — | `provider.error` "Hermes runs on <Hermes host>: add `--machine <Hermes host>`" (R2 S4) |
| `model/list` | `model.options{profile}`, 2 s timeout | Falls back to the last-known list. Never creates a session (r09 M6) |
| `thread/start` | — | Placeholder identity `pending:<threadId>`; publish `bb/session-options` (all visible profiles, plus the current value `discord` "Discord · read-only" on read-only threads, A41) and `bb/provider-model-catalog` (per-model reasoning from `capabilities`, r11 §1) |
| `thread/resume` | — | Records the identity only (R4 M4). `session.resume{omit_messages:true}` runs lazily, on the first bb send or a live watch |
| `turn/start`, visible text | `pending` → `session.create{profile, request_id:"bb:<threadId>", source:"cli", cwd, model, provider, reasoning?, title?}` (`title` for bots, D35); legacy → `session.resume` (adopt, D16); then `prompt.submit{session_id, text, attachments?, submission_id:"bb:<threadId>:<clientRequestId>", turn_author}` | `turn_author` = `{id:"bb:<threadId>", name:"bb"}`, for dedupe (A4). Handoff text = handoff block + message (r11 §7) |
| attachments: `image`, `localImage`, `localFile` | `prompt.submit.attachments` (shape from the T1.0 fixture) | Model without image input → `provider.warning`; the text is still sent (R2 M2) |
| reasoning pick | create param; later `session.mutate{operation:"reasoning", payload:{effort}}` while idle | `default` → omitted (profile level) |
| model pick mid-chat | `session.mutate{operation:"model", payload:{model, provider}}` while idle | Plus `request_id`, `expected_revision`, `expected_generation` (R1 S6) |
| `turn/start.model` not offered | — | Profile default + `provider.warning` (S7 finding 6) |
| profile changed in `sessionOptions`, thread not `pending` | — | Refuse the turn; the server hands off (S7 §1d) |
| marker segment | none, or `session.resume` for a live watch | Never `prompt.submit` |
| `turn/steer` | Ours is running (events carry our `admission_id`) → `session.steer{execution_generation, text}`. Ours still queued, or during a mirror → queued `prompt.submit` | Never steers another client's turn (R1 M4) |
| `thread/stop{interrupt}` | Ours running → `session.interrupt{execution_generation}`. Ours queued → `prompt.cancel{session_id, admission_id}`. Mirror turn → interrupt the mirrored turn, fenced by its `admission_id`/generation (D27) | A turn with no canonical events: stop watching only |
| `thread/stop{release}` | `session.detach{session_id, subscription_id, end_reason:null}` | No `profile` key (closed params, R1 S6); A24 |
| `thread/archive`, `thread/unarchive`, `thread/name/set` | — | The server pushes state (flow 7) |
| send to a read-only (Discord) thread | — | Refused by the server's dispatch hook before a turn starts (D39); the bridge refuses too, as a fallback |
| Hermes answers `not_found` | — | `provider.error` "Deleted in Hermes"; the turn fails (Q1) |
| interaction answer | `approval.respond{session_id, execution_generation, prompt_id, choice}` / `clarify.respond{session_id, execution_generation, prompt_id, answer}` | `already_resolved` → close silently |
| `commands/list` | legacy `commands.catalog` (A31) | Published as `bb/provider-commands` per profile |
| slash command turn | legacy `slash.exec` (A31) | Output renders as the turn's items |
| `/compact` (manual compaction) | `session.mutate{operation:"compress"}` while idle (A33) | `context.compacted`; same lineage |
| `thread/fork{tip\|checkpoint}` | `session.mutate{operation:"branch", payload:{through_message_id?}}` (A34) | Returns the branch's identity; the server binds the fork thread on `thread.created` (`originKind:"fork"`), same profile and project |

Hermes events → bb deltas:
- **Text and tool events:** only those of our own admission, or of the mirrored admission.
- **Approval and clarify requests:** session-scoped. They are raised whichever admission they belong to (R1 S1), and every attach re-raises the snapshot's `prompts[]`.

| Hermes event | bb delta |
|---|---|
| `message.start` / `message.delta{text}` / `{text:null}` | `item.open` / `item.textDelta` / `item.textClose` (agentMessage) |
| `reasoning.delta` | `item.textDelta` reasoningText |
| `thinking.delta`, `agent.step` | ignored (spinner text) |
| `tool.start` / `.progress` / `.complete` | `item.open` / `item.progress` / `item.close`, id `tool_call_id`. Kind: terminal → command; write/patch → fileChange; read → fileRead; web search → webSearch; else tool |
| `approval.request` / `clarify.request` | `interaction/request` approval (command, file_change) / userQuestion; choices never widened |
| `*.settled`, `approval.cancelled` | close the interaction (A3) |
| `subagent.*` | delegation item linked to the sub-thread (A6) |
| `todo.updated` / usage | planSteps item / `usage`, `contextWindow` |
| `session.info{stored_session_id}` change | follow the tip; `context.compacted` |
| `message.complete{status}` | `turn.boundary` completed / interrupted / failed |
| `error` | `provider.error` |

## Sequence flows

1. **New chat**
   - Type-first (home send-menu row, R2 S1) and empty chat (rail, ⇧⌘H) both call RPC `newChat{profile, projectId?, text?}`.
   - Server:
     1. `threads.spawn{providerId:"hermes", projectId, environment, sessionOptions:{profile}, title?, pluginMetadata:{hermes:{origin:"newChat"}}, input: text ? [text] : [init]}`.
        - Type-first: no `title`, so bb's own title generator names it (S1-S3 §S3b). Empty chat: "New <Profile> chat" (S7 §2).
        - Personal environment: `{type:"host", hostId:<Hermes host>, workspace:{type:"personal"}}`.
        - Project environment: `{type:"provider", environmentProviderId:"project-checkout", inputs:{}, machine:{type:"existing", hostId}}` (S7 §5).
     2. Then insert the binding (`pending`) and set the notification level (`muted` during an init).
     3. The app navigates with `useBbNavigate`.
   - Bridge:
     1. `thread/start` → placeholder identity, chip, catalog.
     2. Init turn: empty. The server then calls `markRead` and restores the level.
     3. First visible turn: model check → `session.create` with `cwd` = project root, else the profile's `terminal.cwd`, else `~` (david has none, R1 S10) → `prompt.submit` → stream → boundary → `thread/identity`.
   - Empty chat still titled "New <Profile> chat": after the first turn, the server sets the title to the first message cut to 60 characters (bb can't generate one for an init-first chat, S7 finding 4).
   - The worker's re-list sees the bb-created id → `state=live` → flow 7 pushes the title. Never imported.
2. **Turn with approval, clarify, stop, steer**
   - Track our `admission_id`s from `AdmissionStatus`.
   - Approvals and clarify follow the event table; the card shows the deadline.
   - Stop and steer follow the fenced rules above.
3. **Import** (first run, new sessions, a window raise, a source toggle)
   1. `listSessions` → deny-list filter (§Invariants) → oldest first.
      - First run, window raise or source toggle: the user confirms the `importPreview` counts (per profile, source, and legacy).
      - Circuit breaker: more than 5 new automatic imports in a day → pause import, health red (R6).
   2. Per session, serially:
      1. `readTurns` → placement: cwd at or under the root of a project on the Hermes host → that project (`project-checkout`); else personal.
      2. Insert the binding (`replaying`; `pushed` = Hermes' archived and title, `pinned:false`) and `turns` rows (`replay`).
      3. `threads.spawn{visibility:"hidden", title: Hermes title or first message cut to 60, input:["[<Src> · Oct 12] "+user0, bind]}`.
      4. `threads.send(queue-if-active, [tag+user_i, replay])` for each later turn (S1-S3 §S1b).
   3. Bridge: renders each turn from history, sensitive tools by name only (D36); identity after the first boundary. No canonical call (D16).
   4. Server on idle:
      1. `update{visibility:"visible"}`, Hermes' archived state (read once, D38; never its pin, R6 C6), `markRead`, notification level;
      2. `threads.stop` (release the process);
      3. `state=live`.
   - Interrupted import (restart or sleep): on start, a `replaying` binding's hidden thread is deleted with its binding and `turns`, and the session is re-queued (R3 S2). Deleting must free the `providerThreadId` (A38).
4. **Wake + mirror** (hosted and idle take the same path; Discord included)
   1. A Hermes write → hint or WAL stat → `changed` → debounced re-list → `readTurns` for each `live` binding. `replaying` bindings are skipped (R1 S4).
   2. Anchors not in `turns`, and not bb's (neither `author_id` nor `submission_id` starts with `bb:`, A4):
      - `INSERT OR IGNORE` as `queued`; only if inserted, `threads.send{queue-if-active, ["[<Source>] <text>", mirror{anchor_uid}]}`;
      - no user line → marker only. A done anchor with a new reply uid (`/retry`) → `mirror{rest:true}`;
      - user-started turns (D33: the user's own Discord id, bb, CLI, TUI, Desktop/Conduit) run at `input-only`, so approvals and clarify still push;
      - hidden-prompt turns (the user row has `display_kind` set, e.g. Pulse) run `muted` (R6 C6).
   3. Bridge, by turn state in history:
      - **Complete** → render rows; close (R1 S3).
      - **Running in the gateway** (snapshot has a matching admission) → `session.resume` + `events.since` from the turn's first seq (or the final `message.complete.text` if the ring dropped it; R1 S2).
        - Close on the `message.complete` whose `persisted_turn` user row maps to the anchor.
      - **No canonical admission** (a legacy writer) → render the persisted rows and close as `partial` (R1 M5). Later rows arrive by re-list as `mirror{rest:true}`, with no bubble. No store polling.
   4. Server on idle: `turns` → `done`. A user-started or hidden-prompt turn → restore the level and `markRead` (D26); other turns keep the dot.
5. **User input during a mirror** → a queued `prompt.submit` (S1-S3 §S2c); answered after the outside turn. Merged sends: input parsing above.
   - The server's `message.dispatch` hook rejects, before a turn starts:
     - a send whose visible text starts with a source tag (`[Discord] `, `[CLI · Oct 12] `, …) and carries no marker: an ↑-recalled line (D15). Our own wakes always carry a marker;
     - any visible send to a read-only (Discord) thread: "This Discord chat is read-only in bb. Pick a profile in the chip to continue it in a new bb chat." (D39).
6. **Profile handoff and Continue in bb**
   1. bb saves the pick (`bb/session-option-selections`). The server reads it via `experimental_thread.events` (S7 finding 2).
   2. Binding `pending` → `init{profile}` turn (muted, then `markRead`).
   3. Otherwise, including any pick on a read-only Discord thread (Continue in bb, D39; R1 M9):
      1. `newChat{profile:B, projectId}` with `init{profile, handoffFrom}`;
      2. clear the old choice (`threads.update({sessionOptions:{profile:null}})`);
      3. realtime `handoff{from,to}` → the overlay navigates the window showing `from` (A17), else `threads.open`.
   4. The handoff block comes from bb's own timeline (R6 C4): the server reads the old thread with `threads.events.list` (≤ 100 per page), keeps its rendered messages and tool names (≤ 25 kB, newest first; D36 prefixes re-applied) and passes it in `init.handoffFrom.block`. No Hermes history read, so it works in P1 and for legacy rows. The new bridge's first visible turn sends block + message (R1 M8, r11 §7).
7. **State push bb → Hermes** (D38)
   1. Triggers: `thread:changed` diff and archive events for Hermes threads; a binding turning `live`; worker reconnect or a new `worker_boot_id`.
   2. For each of pin, archive and title where bb's value ≠ `pushed`, the worker sends `mutate`: `sidebar{pinned}`, `archive{archived}`, `rename{title}` (strip `"[bb] "`). Then `pushed` = that value.
   3. Skip:
      - the placeholder title `New <Profile> chat`;
      - bot pins (D35);
      - legacy bindings until adopted: a mutation would claim the row (D16, A23);
      - read-only Discord threads (D39): no Hermes writes at all;
      - `pending` bindings; ACP threads.
   4. On `revision_conflict`, retry once with the returned revision (S0-S4 §S4g). Any other refusal (e.g. a duplicate title: titles are unique per profile DB) is logged in `diagnostics`; no retry.
   5. Hermes-side changes never come back. Read state isn't synced either way (D26 marks user-started outside turns read).
8. **Bots** (D35)
   - Setup: one `newChat{profile}` per visible bot profile (binding kind `bot`), titled by handle and pinned in bb. Idempotent by `(profile_home, kind:bot)`.
   - The first message creates the session with `title:<handle>` (P1 needs no push). A duplicate-title refusal → create without a title, logged. No Bot Chat lookup or Hermes pin.
9. **Compression continuation**
   - New physical segment, same logical id (r11 §3). Cloned tail rows keep their uids, and scaffolding rows are excluded, so nothing renders twice (A8).
   - The bridge follows `session.info.stored_session_id`; `providerThreadId` is unchanged.
10. **Reconnect** (gateway restart)
    1. Rediscover + new ticket, backoff 1/2/5/10 s.
    2. Bridge: `events.since`. On `snapshot_required`, an epoch change or `truncated` (512-event ring) → re-resume; render the missing tail from the resume snapshot (bb-created sessions) or history (imports, P2).
    3. A killed turn → `turn.boundary failed` + "Hermes restarted". Re-raise open `prompts`.
    4. Worker: full reconcile.
11. **bb or daemon restart**
    - Bridges die. The next turn → `thread/resume{providerThreadId}` (S1-S3 §S1c).
    - Retried turns reuse their `submission_id` (A4).
    - A new `worker_boot_id` → full reconcile (~1.9 s after a bb restart, S7 §6). Interrupted imports are redone (flow 3); orphaned `queued` turns are re-sent or deleted.
12. **Hermes host offline** (real outages only: keep-awake already stops idle sleep, D21)
    - `watch` disconnected → thread banner "<Hermes host> is offline: sends wait until it reconnects" (`ComposerCustomization{scopes:["thread"], banners}`; wait or refuse per A9).
    - On reconnect: reconcile; flow 7 pushes bb changes; missed outside turns mirror as finished turns.
13. **Redeploy** (S7 §7, R3 M2)
    1. `bb plugin update hermes`, tracking the `@^0` range. The server, app and worker switch (A26); the worker reconnects in ~90 ms. Hosted bridges keep the old build.
    2. RPC `stopHosted`: `threads.stop` each idle Hermes thread. Busy ones are stopped on their next `thread.idle`.
    3. `diagnostics` shows no bridges left on the old build.

## Invariants and dedupe rules

- **One thread per session** `(profile_home, lineage_root)`, checked before every spawn (bb accepts duplicates, then orphans one: S1-S3 fact 4). Imports, bots and handoffs share one serial queue.
- **Import is a deny-list** (R2 M3). Excluded:
  - every deny label matches `source` or `created_source`: Hermes relabels rows to `source=local` (R6). Labels: `acp` (r09 M6), `a2a` and `tool` (D32), cron and one-shot (unless toggled on), Discord when its toggle is off;
  - empty sessions;
  - bb-created ids; tombstones;
  - Bot Chats (never, D35); subagents (under their parent only).
  - `api_server` imports as `[API]`; unknown origins are tagged `[Hermes]`.
  - The circuit breaker (flow 3) catches a label that slips through.
- **Reading never writes Hermes:**
  - marker segments never `prompt.submit`;
  - history reads and `thread/resume` never `session.resume`;
  - `model/list` never creates a session;
  - no Hermes session exists before the first visible message.
- **Identity** only at a turn boundary; `init` refused unless the identity is `pending:`.
- **Events:**
  - drop when `replay_epoch == cursor.epoch && seq <= cursor.last`, deduped before the resume answer (S0-S4 §S4e);
  - steer and Stop act only on our own admission or the mirrored one.
- **Turns:** one wake per anchor uid (`INSERT OR IGNORE` first); bb rows are never mirrored (author join + `persisted_turn`); approvals and clarify are never filtered by admission.
- **State:** bb → Hermes only (D38); no writes for legacy bindings until adopted (D16); Discord threads never send to Hermes (D39).
- **Approvals:** never auto-approve; never widen Hermes' choices.

## Security

- **No network credentials:** same-UID unix-socket tickets only; nothing Hermes-related on the bb server; no `experimental_contributeEnv` (r01 G11).
- **Private transcripts:**
  - text reaches bb only as thread content; history is read-only (REST `read_only=True`, or `mode=ro`);
  - the mapping db, `diagnostics` and logs carry ids only;
  - `system_prompt`, `model_config` and `origin_json` are never forwarded (r03 §6);
  - sensitive tool results (`conduit_*`, `mcp__Home_Assistant__*`) stay in Hermes in every Hermes thread (D36). The model's own reply can still mention them.
- **Hermes → bb** (D37): outside the plugin. Hermes runs the bb CLI through skills; the work rule is guidance only, and smart approvals flag no `bb` command (R6 C2). Guard pending Q19. Accepted risk: 05 R20.
- **Never auto-approve:** the bridge relays only the user's choice; the one declared mode, `auto`, must never answer for the user (A2, tested in T1.2); tests use quoted throwaway paths (S0-S4 §S4c incident).
- **Live safety:** no gateway or dashboard restarts from the plugin.

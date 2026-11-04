## Review

## Verdict
- **Ship-ready?** No. P0 and most of P1 are sound and backed by evidence. The mirror, import and handoff designs (P1.6 and P2) have correctness holes that would show up as duplicate or lost messages in live use.
- **Biggest problem:** the mirror and dedupe model is keyed on Hermes row ids and assumes one marker per bb turn. Hermes re-inserts rows under new ids on compaction and on `/retry`. bb can merge queued sends into a single turn. The plan also has no record that a wake was already sent.
- **Confidence:** high on findings marked VERIFIED (I read the Hermes source, the SDK types or the spike reports). Medium on SUSPECTED ones; each comes with a verify step.

## Must fix

- **M1 Duplicate wakes. VERIFIED (plan text plus 11 §8)**
  - Where: 02 §Sequence flows 4.3/4.5; mapping db `bindings`.
  - Fails if: a re-list happens while an outside turn is still running. It does: `sessions.changed` fires again every ≤2 s while a turn streams (`message_count` changes, 11 §8). `mirrored_row_id` only moves once `final_row_id` exists, so each re-list sees the same user row and sends another `threads.send` → duplicate `[CLI] …` bubbles.
  - Fix: add a `woken_through` column (a uid or row id). Advance it in the same transaction that queues the wake. Keep `mirrored_*` for "rendered". Add a unit test: 3 re-lists during one outside turn → 1 wake.

- **M2 Row ids are not stable message identities. VERIFIED (Hermes code)**
  - Where: 02 §Mapping db (`mirrored_row_id`), §Invariants "`mirrored_row_id` is monotonic", flow 3.3 (ASSUMED A8), flow 11.
  - Evidence:
    - Compaction publishes a child holding a handoff plus "column-cloned" tail rows (`hermes_state_compression.py:381-388`).
    - `/retry` and `/compress` call `rewrite_transcript`, which DELETEs and re-inserts rows (`gateway/session_transcript.py:540-548`).
    - Every insert mints a new `lastrowid`. The durable identity is `message_uid`, "minted ONCE per logical message… every later insert… writes the same uid" (`agent/message_metadata.py:164-174`, `hermes_state_messages.py:660-686`).
  - Fails when: a CLI `/retry` or an auto-compaction in a bound session. The whole tail, or the whole transcript, comes back with higher ids and is mirrored again. A root→tip replay renders the cloned tail twice.
  - Fix:
    - Key mirror and replay on `message_uid` (plus `active=1`), read through the planned read-only SQLite path. `message_uid` is not in the canonical contract: no match in `gateway-contract.openrpc.json`.
    - Store a per-binding set or high-water of rendered uids.
    - Extend A8 and the compression fixture to cover `/retry` and compaction with a cloned tail.

- **M3 The bb-created id can't be computed before spawn. VERIFIED (SDK)**
  - Where: 02 §Mapping db "computes it at spawn… before the bridge creates it"; flow 1.2 and 1.6.
  - Evidence: `createThreadRequestSchema` (`bb-plugin-sdk.d.ts:12503-12709`) takes no caller-supplied thread id. The id hashes `"bb:<threadId>"`, so it only exists after `spawn` returns.
  - Fails because:
    - flow 1.2 is circular;
    - `thread.created` (`d.ts:19535`) can fire before `newChat` inserts its row, so flow 1.6 inserts a default-profile binding for our own thread → PK conflict or the wrong lineage.
  - Fix:
    - Insert the binding right after `spawn` returns. The first visible message is 5–8 s away (S7 §2), so there is time.
    - Spawn with `pluginMetadata.hermes.origin:"newChat"` and have the `thread.created` handler skip those rows.

- **M4 Steer and Stop can hit someone else's turn. VERIFIED (contract); behaviour SUSPECTED**
  - Where: 02 §Protocol mapping (`turn/steer` during a bb turn, `thread/stop{interrupt}`); flow 2.4–2.5.
  - Evidence:
    - canonical `prompt.submit` always admits with intent `queue` (08 §1);
    - `session.steer` and `session.interrupt` are fenced only by the session-wide `execution_generation` (08 §1 table);
    - the generation first arrives on `message.start` of whichever turn is running (S0-S4 cheat-sheet 3).
  - Fails when: the user sends in bb while a CLI or Discord turn is running, then presses Stop or steers. The bridge interrupts the outside turn, or injects bb text into the Discord turn.
  - Fix:
    - Track our own `admission_id` from `AdmissionStatus`.
    - Call steer or interrupt only when the running events carry that id.
    - Otherwise use `prompt.steer_queued` / `prompt.cancel{session_id, admission_id}` (08 §1).
    - Add fake-Hermes tests for both cases.

- **M5 A mirror of a turn with no canonical events never closes. VERIFIED (evidence); hang SUSPECTED**
  - Where: flow 4.4 "attach live… until `message.complete`"; F4 "Conduit turns… appear as a finished turn".
  - Evidence:
    - Conduit uses the legacy dashboard `/api/ws`, and bb sees those turns only once they finish (08 §4);
    - standalone `hermes serve` "keeps its own agent and writes the store" (06, #106742).
  - Fails when: the user row lands (and the wake fires) while the legacy turn is still running. No `message.complete` ever reaches the bridge → the turn stays `active`, and later wakes queue behind it forever.
  - Fix:
    - Attach live only if the `session.resume` snapshot has a matching `pending` or running admission.
    - Otherwise render persisted rows and close at the last one.
    - If no events arrive, poll rows; close when a final assistant row follows the user row.
    - Add a Conduit fixture test (T3.3) where the wake fires mid-turn.

- **M6 bb can merge queued rows into one turn. VERIFIED (SDK); default behaviour SUSPECTED**
  - Where: §Invariants "A turn carrying a marker never calls `prompt.submit`"; flows 4.3 and 5.
  - Evidence: the dispatch hook payload says "`queuedMessages`: all queued rows… `input` contains their combined input" (`d.ts:19893-19898`), plus `setGroupBoundary`. S7 §8 only tested one queued row.
  - Fails when: a user's queued message and a wake are grouped. The marker suppresses the submit, so the user's text never reaches Hermes. Two wakes in one turn also break the one-`user_row_id`-per-turn logic.
  - Fix:
    - The bridge parses input as ordered (tagged text, marker) pairs. Visible text without a marker is sent with `prompt.submit`. Several mirror markers are rendered in order.
    - Verify the default grouping on isolated bb in T2.4.

- **M7 Import "reads" adopt legacy Hermes rows. VERIFIED (code path); impact SUSPECTED**
  - Where: flow 3.3 (bridge `session.resume{omit_messages:false}` for `bind`); A1/A16; the "approvals needed" list.
  - Evidence: `session.resume` of a local row → `resolve_local_target` (`gateway/session_controls.py:635-642`). For unbound rows without a `local-` id that leads to `adopt_legacy_session` → `commit_local_session` (`gateway/session_local_migration.py:52-73,257-278`).
  - Fails because:
    - every pre-migration session in the 30-day window gets an irreversible write to its policy and ownership just by being imported;
    - rows behind Conduit's legacy writer lease refuse with `runtime_coordination_required` (08 §4), so their import fails.
  - Fix:
    - Render `bind` and `replay` from the worker's read-only data. The server passes rows in markers, or the bridge reads SQLite with `mode=ro`.
    - Call `session.resume` only on the first bb send.
    - Show a "legacy" count in `importPreview`.
    - Add an isolated-Hermes fixture with a legacy row.

- **M8 The handoff context isn't reachable from the bridge. VERIFIED (plan text plus contract)**
  - Where: flow 7.3 "worker `export`" inside the bridge's turn; §Bridge state `threads.json: {profile}`.
  - Problems:
    - the bridge can't call host-worker RPC; only the server can;
    - `handoffFrom` exists only in the `init` marker, so it is lost if the bridge is released between init and the first message.
  - Fix:
    - The bridge calls canonical `session.export` on its own socket. It is in `x-canonical-methods` (`gateway-contract.openrpc.json:48460`).
    - Persist `{profile, handoffFrom}` in `threads.json`.

- **M9 "Has messages" is wrong for imported and spawned threads. VERIFIED (S1-S3 §S1b)**
  - Where: flow 7.1–7.2 (`threads.promptHistory` decides empty vs handoff).
  - Evidence: "The spawn input (turn 1) is not recorded."
  - Fails for: single-turn imports, single-turn bots, and `bb thread spawn --provider hermes "…"`. Their history is empty, so a profile pick sends `init{profile:B}` to a thread already bound to profile A.
  - Fix:
    - Decide by binding `state != pending`.
    - The bridge refuses `init` when its identity isn't `pending:`.

- **M10 The bb tools security gate doesn't protect. VERIFIED (08 §4, 04 §2, 11 §5)**
  - Where: README Q5; 02 §Security "CLI env in Hermes"; F11.
  - Evidence:
    - on Discord turns, approvals go to Discord buttons *and* viewers, and the first answer wins (08 §4). So the allowed Discord user who triggered `bb_thread_spawn` can approve it.
    - alex runs 2 unattended cron jobs every 2 h (04 §2), and F11 enables bb tools there.
    - `bb_thread_spawn` and `bb_thread_tell` can start or steer Codex/Claude threads, which run code. That skips Hermes' terminal approval.
  - Fix:
    - `hermes -p <p> tools disable bb --platform discord` (11 §5), plus the same for cron.
    - Allow spawn and tell only from bb-bound sessions.
    - Accept no permission-mode or provider arguments beyond an allowlist.
    - Restrict `tell` to the bound thread's descendants; refuse `tell` to its own thread (loop).

## Should fix

- **S1 Outside approvals stay hidden while a bb turn waits. VERIFIED (plan text)**
  - Where: 02 §Protocol mapping event filter ("only events of this turn's `admission_id`"); F6 "Approvals… raised by an outside turn show in bb too".
  - Problem: a bb turn queued behind an outside turn drops that turn's `approval.request`. The wake is queued behind the bb turn, so bb never shows the request.
  - Fix:
    - Surface session-scoped approval and clarify requests whatever the admission.
    - On every mirror attach, re-raise the snapshot's `prompts[]`. Today flow 4.4 doesn't; only flow 12.3 does.

- **S2 Attaching to a mirror mid-turn loses text already streamed. SUSPECTED**
  - Where: flow 4.4.
  - Problem: persisted rows plus live deltas miss the in-flight segment.
  - Fix:
    - Use `session.events.since` from the turn's start sequence while it is still in the 512-event ring.
    - Otherwise render `message.complete.text` as the final message.
    - Test: streamed text == complete text.

- **S3 Matching a mirror turn to its admission is unspecified**
  - Where: flow 4.4. The marker has no admission id, and `message.start` is `{}` (S0-S4 cheat-sheet 8).
  - Fix:
    - Close on the `message.complete` whose `persisted_turn.user_row_id` (or uid) matches the marker.
    - If that turn has already finished, render from rows and don't attach. Otherwise, with back-to-back outside turns, turn 2 gets rendered inside turn 1.

- **S4 Import overlapping live activity**
  - Where: flow 3.4 sets `mirrored_row_id` but doesn't say to what; mirror doesn't skip `replaying`.
  - Fix:
    - Set the watermark from the last turn actually replayed.
    - Mirror ignores `replaying` bindings, then catches up on `live`.

- **S5 Bot titles get overwritten. VERIFIED (plan text)**
  - Where: flow 9 has no bot exemption, so all four bots get retitled "Bot Chat" (F4 says "title = capitalised handle").
  - Fix: exempt bot titles in both directions.

- **S6 Protocol params are missing**
  - `session.mutate model` needs `expected_generation` (11 §1), plus `request_id` and `expected_revision` (08 §1).
  - `clarify.respond` needs `prompt_id` and `execution_generation` (08 §1).
  - `SessionDetachParams` is a closed set with no `profile` (`openrpc:36992-37021`).
  - Fix: correct the mapping table; add these to `used-surface.json`.

- **S7 Detach can end Hermes rows. VERIFIED (contract text); effect SUSPECTED**
  - Evidence: "the last viewer leaving an idle local session ends its row" (`openrpc:48425`); T3 saw `acp_disconnect`.
  - Risk: bridge release and worker resumes end rows → Desktop status changes and extra `sessions.changed`.
  - Fix:
    - Detach with `end_reason:null` and check on isolated Hermes that rows don't end.
    - The worker reads with read-only SQLite, not resume.

- **S8 The server can't tell when the worker restarts**
  - Where: `ensureWatch` returns only Hermes identity. R5 relies on "a new pid" that the contract doesn't return.
  - Fix:
    - Return a `worker_boot_id`; the server does a full reconcile when it changes.
    - A new worker treats its first WAL stat as "changed".

- **S9 ASSUMED items with no verify step**
  - "A viewer gets live events of another client's turn": the core of F6. Only inferred (08 §4 "I"); S4f sent no prompts. Add an A19 tied to the Desktop-viewer fixture.
  - "bb steers and queued prompts carry the `bb:` author": steers become rows (`hermes_state_messages.py:680-682`). Without the author they would be mirrored back as outside lines. Add this to A4.
  - `source:"cli"` sessions may be picked up by `hermes chat -c` (a "latest" search by created family, `gateway/session_local_title.py:58-64`). SUSPECTED; verify on isolated Hermes.

- **S10 david works in the Hermes home. VERIFIED (11 §6)**
  - Evidence: david has no `terminal.cwd`, so personal chats run in `~/.hermes`. F2 lists only default, alex and neo.
  - Fix: pass `cwd:~` when the profile has none; add an F2 acceptance check.

- **S11 `bindings.json` handling**
  - Write atomically (temp file + rename). Make the directory 0700.
  - A Discord route key survives the daily reset (04 §2), so it must point to the newest session's thread.
  - The minimal env has no `HOME`; check it in A12.

- **S12 Child notifications could leak to Discord. SUSPECTED**
  - A child spawned from a Discord-bound thread sends its parent notification as a bb turn → it posts to Discord, echoed as "$OWNER_NAME (via bb)".
  - Fix: `parentNotifications:"off"` for messaging-bound parents.

- **S13 A bot's Bot Chat may deliver to Discord. SUSPECTED**
  - Evidence: `gateway/session_bot.py:203`: "A Bot Chat handed off to a messaging lane… delivery follows it".
  - Risk: bb sends to that bot then post to Discord.
  - Fix: check `handed_off_ref` in P3 and show a notice.

- **S14 Simpler: drop the `outbox` table**
  - On reconnect, diff the current bb state against `synced` and push the differences.
  - That is less code, and it collapses repeated toggles into one write.
  - Also store `synced.title` per side; otherwise the `" (2)"` duplicate-title retry makes the bb title flip.

- **S15 `running` doesn't mean executing**
  - Where: `listSessions` field list.
  - Evidence: `running` means "mounted" (S0-S4 §S4a).
  - Fix: rename it in the contract, or drop it from the field list.

## Questions for the user
- **Bb tools in Discord and cron sessions.**
  - Recommended: turn the `bb` toolset off on the Discord and cron platforms; tools only in bb-bound and interactive sessions.
  - Alternative: Q5-style approvals. Weak, because the Discord user can approve their own request (M10).
- **Pressing Stop during a mirrored outside turn.**
  - Recommended: end bb's view only. Never interrupt a CLI or Discord user's turn.
  - Alternative: interrupt it in Hermes.
- **Pre-migration sessions at import (M7).**
  - Recommended: show them read-only; Hermes adopts a session only when the user first sends from bb.
  - Alternative: adopt all of them at import (irreversible Hermes writes).

## Checked and fine
- Transport:
  - the `gateway.sock` ticket with the subprotocol form;
  - the host-scope socket;
  - rediscovery on every connect;
  - never starting a gateway.
  - Evidence: S0-S4 cheat-sheet 1 and 08 §2.
- Replay dedupe rule, and deduping before the resume answer (S4e).
- The deterministic `local-` id formula (S4b), lazy create, and never calling `prompt.submit` on marker turns.
- The S1b import recipe: no `sendAt`, hidden during replay, identity after the first boundary (S1-S3 facts 1 and 3).
- Keep-alive is mandatory (S7 §6). Project chats need `project-checkout` with `inputs:{}` (S7 §5).
- Chip and catalog with `models.scope:"workspace"` (S7 §1c). The redeploy step `stopHosted` (S7 §7).
- `admission_id`, `tool_id` and `tool_call_id` are on events (fixture `s0e-webapp-turn.json:1344-1352`).
- Both private symbols exist: `gateway/session_ingress.py:17` and `gateway/session_context.py:188`.
- `session.export` is a canonical method. No auto-approve anywhere. The CLI env is minimal and never `os.environ`.
# R4 — Final check of the revised plan

## Verdict
- **Not ready for approval yet.** The R1–R3 Must-fixes are in the plan text, not just listed in the README table, and they are mostly sound. Four new Must-fixes remain. Each is a few lines of plan text.
- **Biggest remaining issue:** the user's work/personal boundary (D28) is not enforced.
  - It only gates spawn's `project` argument. `tell`, `read`, `wait` and `list` can reach $WORK_HOST threads from Discord or CLI.
  - "bb-bound session" has no definition. Every imported CLI or Discord session has a binding, so the allow-rule matches almost every session.
- **Confidence:** high on items marked VERIFIED (Hermes source at `~/.hermes/hermes-agent`, plan text). Medium on items marked SUSPECTED.

## Review resolution (verified in plan text)
- **R1 M1–M10: all present in the body.**
  - M1: 02 §Mapping db "A wake is queued in the **same transaction** that inserts its `turns` row".
  - M2: `turns` PK `(thread_id, anchor_uid)`.
  - M3: 02 §Identity "Computed right after `threads.spawn` returns" + `pluginMetadata.hermes.origin`.
  - M4: 02 mapping, `turn/steer` and `thread/stop` rows fenced on `admission_id`.
  - M5: flow 4.3, three modes and the 10 min `partial`.
  - M6: 02 §Input parsing.
  - M7: D16; flow 3.3 "No canonical call".
  - M8: flow 7.4, handoff block "from the store".
  - M9: F3 "binding not `pending`" + `init` refused unless `pending:`.
  - M10: as narrowed by D24 and D28.
- **R2 M1–M4: present.**
  - M1: F2 Reasoning + T1.5b + AC "High pick reaches Hermes".
  - M2: mapping row for attachments + T1.12 + F6 "text only in v1".
  - M3: 02 §Invariants "Import is a deny-list".
  - M4: D22 + T1.4/A28.
- **R3 M1–M6: present.**
  - M1: D29, T0.11. M2: 04 Release step 4 `@^0`, §Rollback. M3: 02 `hermesRoot` "Unset → … no Hermes I/O".
  - M4: D20. M5: 04 step 5 `--ref … --no-enable`. M6: 03 §7–8 `.venv`.
- **Soundness gaps in three fixes:**
  - R1 M1: "same transaction" can't cover `threads.send`, which is an async bb call. See S7.
  - R1 M2: anchoring on the user uid drops `/retry` replies. See S1.
  - R3 M3: the `bb_tools` dir is still hard-coded to `~/.hermes`. See M2.
- **Should-fix spot-checks (10), all landed:**
  - R1: S5 (flow 9 "(not bots)"), S6 (mapping params; detach "No `profile` key"), S8 (`worker_boot_id`), S11 (atomic write, 0700/0600, route → newest), S12 (flow 15.3 `parentNotifications:"off"`), S14 (no outbox; `title_bb`/`title_hermes`).
  - R2: S2 (titles invariant), S9 (prewarm + last-known list).
  - R3: S2 (flow 3 delete + re-queue; see S8 below), S10 (T6.4 depends on T6.3; backup step).

## Must fix before approval
- **M1 D28 is enforced only on spawn's `project` argument; "bb-bound" is undefined.** (01 F11; 02 flow 15.2; README D28)
  - User intent (R2 U4: "spawn and read threads in $WORK_HOST work projects") covers reading too.
  - As written, a Discord or CLI session can `bb_thread_tell`, `read` or `wait` a $WORK_HOST thread by id, or `list` work threads.
  - Every imported session is in `bindings.json`, so "bb-bound" as a binding test is true for CLI and Discord sessions too.
  - Fix:
    - define bb-bound as "the current admission's author is `bb:`" (`admission_author`; the echo hook already uses it), not "has a binding";
    - apply the $WORK_HOST check to every tool's target: the target thread's project, and `list` filtered.
    - AC: "`bb_thread_read` of a $WORK_HOST thread from a Discord or CLI session is refused".
- **M2 `bb_tools` files are hard-coded to `~/.hermes/bb_tools/`.** (02 §Files on $HERMES_HOST)
  - The worker writes `bindings.json`, and the bridge writes `echo.json`, there even when `hermesRoot` points at the fake or isolated Hermes. So e2e writes to live Hermes, which re-opens R3 M3.
  - Research 11 §5 already says `<root>/bb_tools/`.
  - Fix: use `<hermesRoot>/bb_tools/`. Same for the drift check paths (`<hermesRoot>/hermes-agent/...`).
- **M3 The store reader (new primary read path) lacks its fail-safe and its row rules.** (02 Store reader; 05 R3; T0.4)
  - VERIFIED: `SCHEMA_VERSION = 32` (`hermes_state_common.py:289`); the reader is read-only, as webui does (research 05). Those parts are good. Missing:
  - **(a) Mismatch policy is undefined.** Pin it:
    - unknown version → run the drift-check queries;
    - pass → continue, health warns;
    - fail → pause import, mirror and sync (no partial guesses); bb-started chats keep working over canonical; health red.
    - Today the fail-safe ("a field that fails → no sync for that field") exists only in 05 R3.
  - **(b) Compaction scaffolding rows would mirror as fake turns.** VERIFIED:
    - the compaction summary is often `role:"user"` (`context_compressor.py:5343`), flagged `_compressed_summary`;
    - the restatement rows carry `display_metadata.compaction_inflight_task_restatement` (`message_metadata.py:180-200`);
    - these rows have fresh uids, so `readTurns` would mirror them as `[Hermes] <summary>` bubbles.
    - Fix: exclude `_compressed_summary=1`, restatement rows and `display_kind` hidden rows; honour `absorbed_message_uids`.
  - **(c) The author lives in the admission's `cli_turn_v1`, not in `messages`.** VERIFIED: no author column in `messages` (`hermes_state_common.py:531-562`; `session_cli_turn.py`).
    - Name the join in A4/A1.
    - Also record bb turns in `turns` (kind `bb`) from `persisted_turn` uids as a second dedupe. Otherwise a failed author join mirrors the user's own bb messages back as `[CLI]`.
  - **(d) No SQLite binding is proven inside the host worker or bridge runtime.** Repo-wide grep: no spike uses one.
    - Add A36: T0.4 proves it first. Fallback: `/usr/bin/sqlite3 -readonly -json`.
    - Also state: short read transactions only, never `immutable=1`.
  - **(e) Optional, cheap:** the drift check hashes Hermes' own display-dedupe functions (`is_compaction_scaffolding`, `_display_dedupe_key`), so a semantic change gets flagged even when the columns don't change.
- **M4 `thread/resume` contradicts the placement rule.**
  - 02 §Placement: "`session.resume` runs only for a bb send, or to watch a turn that is running in the gateway (D16)".
  - 02 mapping: `thread/resume` → `session.resume` for every non-pending, non-legacy thread. So every wake on a released import or bot thread resumes, then detaches.
  - Bot Chats behind Conduit's legacy writer lease can refuse with `runtime_coordination_required` (R1 M7 evidence). SUSPECTED effect: mirror turns on bot threads fail.
  - Fix: `thread/resume` only records the identity; resume lazily on the first bb send or a live watch.

## Should fix
- **S1 A CLI `/retry` reply never reaches bb.** The anchor is the user uid, which `/retry` keeps, so that anchor is already `done`. The new assistant row is skipped and bb keeps the stale answer.
  - Fix: track the rendered reply uids per anchor; a new reply on a done anchor → `mirror{rest:true}` or a "Retried in <src>" turn. Add to the T2.0 `/retry` fixture.
- **S2 Bot pin loop.** Bot setup pins in bb, and `synced` holds one shared `pinned` value.
  - If it records `true` while Hermes has `false`, flow 9 unpins the bot. If it records `false`, flow 8 pins the hidden Bot Chat in Hermes.
  - Define one direction (see Ambiguities).
  - Flow 9 also lacks the bot-archive exemption that F9 and flow 8 have.
- **S3 Approvals list (README).** Add:
  - **Discord toolset settings:** enabling `bb_tools` makes toolset `bb` live on Discord by default (11 §5 l.208). This is a decision item.
  - **D21 keep-awake on $HERMES_HOST:** a live power-setting change, decided by parent triage, not by the user.
  - **First live two-way state sync:** the first live Hermes writes (pin, archive, rename, read).
- **S4 Echo after rollover.** `pre_llm_call` posts through `bound_session_key()`. SUSPECTED: on a rolled-over session the echo still lands in Discord while the reply doesn't.
  - Fix: the echo hook checks `messaging_bound`, which is already in `bindings.json`.
- **S5 D24 approval vs "always".** `pre_tool_call` `{"action":"approve","rule_key"}` (`plugins.py:1912-1915`): an `[a]lways` answer allowlists that key, which silently ends the D24 prompt.
  - Fix: a per-call `rule_key`, or block when the rule is already allowlisted.
- **S6 User-decided features labelled droppable.** README "Possible gold-plating" lists subagent sub-threads and the Discord echo. The user decided both: nested subagents, and echo first.
  - Dropping either needs user OK. If T2.7 is dropped, subagent sessions vanish entirely, because the deny-list excludes them.
- **S7 Wake atomicity.** State it as: `INSERT OR IGNORE` first; send only if inserted; on a send error, delete the row.
  - Add boot recovery for `queued` rows that have no bb turn.
- **S8 Interrupted import "delete + re-queue".** Unverified that deleting a hidden thread frees its `providerThreadId` (S1-S3 fact 4: 409 orphan). Verify in the T2.9 e2e.
- **S9 Import scope vs "interactive".** The deny-list imports `a2a`, `api_server` and `tool` (research 04 §6). Confirm with the user or add them to the deny-list.
- **S10 Citation collision.** Plan files 01/03 vs research 01/03:
  - 02 "(01 §1)" = research 01 l.67; "(03 §6)" and "(03 §4)" = research 03.
  - Prefix research refs, e.g. `r03 §6`.
- **S11 Minor:**
  - README l.7 "Items pending a user decision…" contradicts l.114 "No user decisions are pending";
  - 05 order R24, R26, R25;
  - A21 is used in the P1 mapping but verified only in P5;
  - `tools disable bb --platform cron`: "cron" as a platform value is unverified. The handler's own cron refusal covers it; say so.

## Decisions check
- Transport Local / `gateway.sock`: OK (D1). "If Hermes moves" — MISMATCH-lite: the Hermes host id is hard-coded "$HERMES_HOST" (02 flow 1, F1 error text); there is no setting or discovery.
- Bots (4 pinned, Bot Chat, todoist hidden): OK (D5, F4). Pin sync gap: S2.
- Import (interactive + Discord, 30 d; subagents nested; one-shot and cron toggles): OK (D6, F5). Caveats: S6 (subagent nesting marked droppable), S9 (scope).
- Outside activity (live, progress, unread; no push for user-started; push for approvals, clarify, others): OK (D26, F6, F10).
- Outside user messages (source tag, prompt history): OK (F6, D15).
- Discord (replies post, echo first, rollover notice, thread per session): OK (D8, D23, Q4). Echo marked droppable: S6. Echo leak: S4.
- Two-way sync (bot title never, bot archive bb-only, no cross-delete): OK (F9, Q1, Q2). Flow 9 lacks the bot-archive exemption: S2.
- Profile picker (chip everywhere, models follow, handoff with context): OK (D3, F3).
- Optional project; cwd-matched imports: OK (D4, F5 Placement).
- Icon via row metadata; hidden from picker: OK (D22, F1).
- ACP retirement (parity = reasoning, slash, fork; no tier; 18 read-only): OK (D25, F13).
- bb tools (5 tools; Discord approval; cron off): OK. $WORK_HOST targeting: **MISMATCH**, 01 F11 / 02 flow 15 (M1).
- Stop interrupts the mirrored turn: OK (D27).
- `gh auth setup-git`: OK (D29, T0.11).
- Settings v1: OK (F12).
- Imported items show import time: OK (Q7).
- Project chats share a model list; unoffered → default: OK (Q9, F3).
- hermes-host: ask first: OK (Q8). No P0 task owns the ask.
- Approvals list: **MISMATCH**. Discord toolset settings missing (S3); the rest is present.

## Ambiguities for execution
- **T0.4:** which SQLite binding works in the host worker and the bridge (M3d)?
- **Hermes host:** how does the server get $HERMES_HOST's `hostId` for `bb.hosts.experimental_client` and personal environments (setting vs the worker reporting `gateway.sock`)? Needed in P0 T0.8/T0.9.
- **Q8 hermes-host question:** no task ID or owner in P0. Suggest the T0.1 lead asks it.
- **Schema mismatch behaviour** (M3a): T0.4 and T0.8 can't implement the check without it.
- **Bot pin direction** (S2). Recommended, per D9: push `pinned:true` to the Bot Chat at setup, then sync normally. Verify that a hidden session accepts the pin.
- **Import initial state:** does a Hermes-archived or pinned session import as archived or pinned? What does `synced` start as? Flow 3 is silent.
- **"User-started" for Discord turns from other allowed Discord users, and for `a2a` input:** push or not?
- **Who records approvals, and where** (e.g. a section in `docs/operations.md`), so gated tasks (T0.11, T4.3, T5.4, T6.3/T6.4) can check them.
- **D16–D21 were parent triage of questions the reviews addressed to the user** (R1 pre-migration, R2 U2/U3, R3 Q2). Present them to the user as decisions in this approval, especially D21 keep-awake.

---

- **Verdict:** not approvable yet. All R1–R3 Must-fixes are in the plan text, not just the README table. Four new Must-fixes remain, each a few lines of plan text.
- **Biggest issue:** the work/personal boundary (D28) only gates spawn's `project` argument. `tell`, `read`, `wait` and `list` can reach $WORK_HOST threads from Discord or CLI, and "bb-bound session" isn't defined. Every imported session has a binding, so the rule matches almost everything.
- **Reading `state.db` directly as the main read path** is reasonable (webui already does it read-only, and schema version 32 matches the Hermes source). But it has no policy for an unknown schema version, and no proof a SQLite library works in the host runtime. It would also show Hermes' compaction summary rows (stored as user messages with new ids) as fake outside turns.
- **Two more Must-fixes:**
  - `~/.hermes/bb_tools/` is hard-coded, so e2e writes to live Hermes;
  - 02's `thread/resume` row contradicts its own rule to resume only on a bb send.
- **Decisions:** two mismatches. $WORK_HOST targeting, and the approvals list has no Discord toolset item. Two of the user's decisions (subagent nesting, Discord echo) are labelled droppable without their OK.
- **Coverage:** 20 Must-fixes and 10 Should-fixes checked against the plan text; key claims checked against the Hermes source. Not checked: the bb SDK types (no local copy found); nothing was run.
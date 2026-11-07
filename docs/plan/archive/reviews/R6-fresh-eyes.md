# R6 — Fresh-eyes adversarial review

Read-only, 2026-11-04. Hermes `c314285f07`, bb 0.48.1, SDK 0.6.104. Drafted from the plan and evidence before reading R1–R5.

Labels: VERIFIED (checked by me; file:line or command), SUSPECTED (inferred), ASSUMED. Message counts: `sqlite3 -readonly` on all five `state.db`, `role='user'`, active rows, last 28 days. No secrets or message text copied.

## Verdict
- **Approve P0–P1 with changes; rethink the P2 gate.** P1 is what serves "do all AI chatting in bb". P2 serves "every session in bb": today that is about 5 human messages a week, mostly read-only Discord.
- **Single biggest risk: TS.1 / D37.**
  - The plan's only hard guard, smart approvals, never fires on `bb` commands.
  - Hermes reading work threads breaks your own rule "$WORK_MODEL_RULE".
  - Not prevented; detected only if you notice (C2).
- **Biggest plan flaw:** the go/no-go can't fail, and it measures the wrong thing (C1).
- **Biggest simplification:**
  - read through Hermes' own REST display projection (Hermes Desktop's path, same trust model as D1) instead of re-implementing it (C3);
  - build P1's handoff from bb's own timeline, so no store code exists before the go/no-go (C4).
- **Confidence:**
  - high on measurements and code reads;
  - medium on the REST path (code read, not exercised) and on post-P1 volumes (good bb chat may raise them).

## Top challenges

### C1. The go/no-go metric can't fail and doesn't inform P2 (README Goal; 04 Go/no-go; 05 kill criteria)
- **Claim:** bb-started Hermes messages ≥ ~10/week for the 3 weeks after P1 → go to P2.
- **Challenge:** it measures P1 activity, inflated by testing. It measures neither your goal (chatting moves into bb) nor P2's value (mirroring outside activity).
- **Evidence (VERIFIED):**
  - bb via ACP: 19 user messages (14 / 4 / 1 / 0 by week, newest first). The burst is recent ACP sessions titled "…plan review…".
  - Outside, typed by you:
    - Discord 15 (read-only under D39);
    - Conduit 4;
    - Bot Chats 2 (never imported);
    - CLI 8, all connectivity pings ("Reply with exactly: ok").
  - Not typed by you: Pulse 7 turns on Nov 4 alone (hidden user rows), alex cron 31, oneshot 16.
  - The P1 dogfood list (03 §9) sends about 25 bb messages by itself (my count of its items).
- **If right:**
  - "go" is near-certain and says nothing about P2;
  - P2's value shrinks as P1 succeeds, because less happens outside bb (SUSPECTED).
- **Recommendation: change (Q1).**
  - Metric: bb's share of your typed Hermes messages, from the DBs. Exclude hidden rows, cron, oneshot and threads tagged dogfood. Today about half. Target ≥ 80% in weeks 2–3.
  - P2 gate: your typed outside messages per week after P1.
    - Under ~5 → **P2-lite**: a "Hermes sessions" rail list plus Continue in bb through the P1 handoff. About 4 tasks; no wakes, mirror, audit, soak, adoption or push.
    - Over ~5 → full P2.

### C2. D37's guard doesn't exist, and D28 conflicts with your own rule (D37, D28; 01 F11 Guards; 05 R20)
- **Claim:** "Hermes' smart approvals apply" to Hermes using bb through skills + CLI.
- **Challenge:** smart approvals only run on commands the danger detector flags, and it flags no `bb` command.
- **Evidence (VERIFIED):**
  - `check_all_command_guards` approves when `_unapproved_findings` is None (`tools/approval.py:1184-1230`, `:669-683`).
  - `detect_dangerous_command` (`tools/approval_detection.py:1612`), loaded alone (stdlib-only), returns `(False, None, None)` for:
    - `bb thread spawn --machine $WORK_HOST …`;
    - `bb thread spawn --permission-mode full …`;
    - `bb thread tell …`;
    - `bb thread archive …`.
  - `bb-reply` approves or denies pending bb approvals (`profiles/neo/skills/bb-reply/SKILL.md:28`).
  - Your hard rule: "$WORK_MODEL_RULE" (`profiles/neo/skills/dev-setup/SKILL.md:63`). Every Hermes profile runs openai-codex or `mlx_main` (r04 §2). Projects on both hosts count as work (D28).
- **Worst plausible incident:**
  - injected content (web page, vault note, Home Assistant, email) gets Hermes to `tell`, steer or approve a $WORK_HOST thread;
  - even a legitimate "what did that work thread find?" sends work data to Hermes' models.
  - Prevented: no. Detected: only if you notice.
- **If right:** D37's "advisory" choice rests on a false premise, and TS.1 widens the exposure from 1 profile to 4.
- **Recommendation: ask (Q2).** Options, cheapest first:
  - hold TS.1 to Neo;
  - `approvals.deny` globs can hard-block `bb thread interactions *` today, config only (`tools/approval_floors.py:23-43`);
  - a ~20-line `pre_tool_call` hook can route `bb thread spawn|tell|interactions` through `request_tool_approval` (`tools/approval.py:1154`). It is a guard, not the dropped tool plugin.

### C3. The store reader re-implements Hermes' projection, and its safety nets check it against itself (02 store rules; 03 §8; T0.4, T0.13, T2.11)
- **Claim:** 4 excluded row kinds, plus schema and hash checks, the canary and the audit, make the private-store reader safe.
- **Challenge:**
  - Hermes' display projection has more rules than the plan lists.
  - The canary's golden files are our reader's own output.
  - The audit's anchors come from the same `readTurns`.
  - So a reader bug passes all three.
- **Evidence (VERIFIED, code):**
  - `_project_for_display` (`hermes_cli/web_routers/sessions.py:671-741`) also:
    - hides untyped `[System: …]` scaffold rows (role=user);
    - types failed-turn notices;
    - shows a steer's own words, not the model-facing marker;
    - shows withheld prompts (Conduit registers `pre_llm_call`);
    - projects history commentary.
    - 02 lists none of these. Live count of untyped `[System:` user rows today: 0, so it is latent.
  - Hermes' own rule: display projection is "never a re-implementation" (`gateway/session_controls.py:103-108`).
  - The same projection is served read-only: `GET /api/sessions/{id}/messages`, with `read_only=True` and ancestors included (`sessions.py:743-787`).
    - It runs on the gateway's own listener, behind a same-user `native-http` ticket minted on `gateway.sock`, which the gated middleware accepts (`dashboard_auth/native_http.py:1-15, 287-312`; `dashboard_auth/middleware.py:215-217`; `gateway/control_socket.py:375-393`; `gateway/runtime_bootstrap.py:9-12`).
    - Hermes Desktop uses this grant for every REST route (`apps/desktop/electron/local-gateway.ts:487-503`).
    - No credential, config change or port: D1's trust model.
  - T0.4's other candidate, "Hermes' own reader in `hermes-agent/venv`", runs webui's stale environment:
    - `pyvenv.cfg`: Python 3.11.15, `__editable__.hermes_agent-0.21.0.pth`;
    - live Hermes runs `~/.hermes/tools/python-3.14.9…/bin/python3` (`hermes-agent/.hermes/bin/hermes`).
- **If right:**
  - T0.4 becomes a REST client with recorded REST fixtures;
  - the schema-version, function-hash and Python-symbol checks give way to a REST key check;
  - R3 and R27 shrink;
  - the canary and audit get an oracle that isn't our code.
- **Recommendation: change (Q3).**
  - T0.4 spikes REST first: list and messages per profile; `message_uid`; `display_metadata.submission_id` for bb dedupe (SUSPECTED present: Pulse rows have it in the store).
  - Keep the TS reader as the fallback.
  - Whichever reader wins, golden files come from Hermes' projection, not from ours.

### C4. P0 builds P2's store machinery before the go/no-go (04 P0, critical path; 02 flow 6.4)
- **Claim:** P0 needs:
  - T0.4 (reader comparison);
  - T0.13 (snapshots, golden output, canary);
  - snapshot-backed fake state;
  - store schema drift checks.
- **Challenge:** in P1 only the handoff block reads the store. bb already holds that transcript, D36-filtered, in the thread's own timeline.
- **Evidence (VERIFIED, plan text):**
  - 02: "lists, transcripts, origins and handoff context are store reads";
  - every other P1 flow is canonical (02 protocol table).
- **If right:**
  - P0 loses about 3 tasks;
  - T0.13 → T0.4 leaves the critical path;
  - a no-go never builds a reader.
- **Recommendation: change.**
  - The server builds the handoff block from `threads.events.list` (≤ 100 per page, S7 gotchas) and passes it in `init`.
  - Store or REST reads start in P2.
  - Continue in bb from Discord can use the bb timeline too.

### C5. Conduit chats are a live legacy stream, not a pre-migration backlog (D16; glossary "legacy session"; 02 flow 4.3; R12)
- **Claim:** legacy = pre-migration rows; adopt them on the first bb send.
- **Challenge:** Conduit, through the standalone dashboard, keeps creating new legacy rows (2 on Nov 3, 1 on Oct 23).
- **Evidence (VERIFIED):** `$HERMES_SESSION_34` and `$HERMES_SESSION_37` (Nov 3):
  - `source=desktop`, no `chat_id`, 0 rows in `session_admissions`;
  - Hermes adopts `desktop` rows as `gui` (`hermes_state_local_migration.py:14-18`).
- **Consequences:**
  - Conduit's turns on its own rows never stream in bb: no canonical events, so the no-events `partial` path.
  - The first bb send adopts a row Conduit may still be writing. Refusals (`runtime_coordination_required`, r08 §4) have no plan behaviour.
  - SUSPECTED: adoption needs a native transport bound to that profile's authority (`gateway/session_local_migration.py:19-29, 257-262`). A host-scoped socket acting for alex or david may get `not_found`.
- **Recommendation: change (Q4).**
  - Treat legacy rows like Discord: read-only, with Continue in bb.
  - That drops adoption, A23 and the legacy push skip.
  - If adoption stays, add a T2.0 fixture: an alex legacy row adopted through the host-scoped socket.

### C6. Pulse: the plan contradicts itself, and your notifications lose (D26, D33; 01 F6, F10)
- **Claim:**
  - D26: turns the user didn't start, Pulse included, keep the dot and push.
  - D33: "user-started" is decided by source, and Desktop counts as user-started.
- **Challenge:** Pulse runs in a `desktop` session, so D33 says no push and D26 says push.
- **Evidence (VERIFIED):** session `$HERMES_SESSION_38`:
  - `source=desktop`, `pinned=1`;
  - 7 turns on Nov 4;
  - each turn is a hidden user row ("Pulse delivery check / report / morning brief") plus a 14–117-character reply.
  - Conduit already pushes Pulse itself.
- **If D26 wins:**
  - about 7 bb pushes a day, duplicating Conduit;
  - a pinned Pulse thread at the top of the sidebar (imports copy Hermes' pin, D33).
- **Recommendation: change (Q4).**
  - Turns with a hidden user row → muted and auto-read.
  - Import Pulse unpinned, or exclude it.

### C7. The privacy list misses most of Conduit's phone tools (D36; 01 F15; A40)
- **Claim:** "sensitive" = `conduit_health`, `conduit_location` and the Home Assistant tools.
- **Evidence (VERIFIED):**
  - `~/.hermes/plugins/conduit_push/plugin.yaml:25-41` lists 16 tools, including `conduit_contacts`, `conduit_calendar`, `conduit_phone`, `conduit_inbox` and `conduit_maps`.
  - The plugin updates itself (`~/.hermes/conduit-self-update.json`).
  - Live Home Assistant names are `mcp__Home_Assistant__*` (`messages.tool_name`).
- **If right:**
  - contacts, calendar and inbox results render in full in bb;
  - new Conduit tools appear unfiltered.
- **Recommendation: change.**
  - Match by prefix: `conduit_*` and `mcp__Home_Assistant__*`.
  - The test reads `provides_tools` from `plugin.yaml`, so new tools fail it.

## Decisions I'd challenge

| Decision | Steelman | Counter-argument | Recommendation |
|---|---|---|---|
| D34 full plan, go/no-go after P1 (user) | Data before P2 | The metric can't fail and doesn't measure P2 (C1) | Change the metric; add P2-lite as an outcome |
| D37 skills + CLI, guidance only (user) | Exists for Neo; no code | Its named guard never fires; conflicts with your work rule (C2) | Ask; hold TS.1 to Neo |
| D36 sensitive tools by name (user) | Explicit, testable | Hand list misses 5+ tools and rots (C7) | Prefix rule |
| D26 + D33 notifications (user + parent) | No double push for your own turns | They disagree on Pulse; D26 duplicates Conduit 7×/day (C6) | Hidden-user-row turns muted |
| D16 adopt legacy on first send (parent) | Continue any session in place | Conduit's rows are live; adoption writes rows another client writes (C5) | Read-only + Continue in bb |
| D38 one-way push (user) | Conduit/Desktop lists stay tidy | Of ~19 importable sessions in 30 days: 8 Discord (never pushed), 8 legacy (pushed only after adoption), Pulse. About 3 are pushable (VERIFIED counts). What remains is a Hermes write path, a live approval and revision handling, mostly for bb-created chats | Move F9 to P3 as droppable |
| D20 manual check before `hermes update` (parent) | Sees the incoming version | A human step: updates can start from Hermes' own UI (`POST /api/hermes/update`, r02 §3) and skip it; the canary after it is manual too | Worker runs `--incoming` daily and the canary on each version change |
| T3.7 webui retirement at P3, optional (from R2 S8) | Retire after parity | Webui doesn't depend on this plugin. Its store has been untouched since Sep 6 (`~/.hermes/webui/sessions/_index.json`), though pid 61135 still runs | Retire now (Q5) |

## Assumptions most likely to fail

| Assumption (where) | Status | Why it matters |
|---|---|---|
| Legacy = pre-migration backlog (D16, glossary) | VERIFIED false: Conduit keeps adding them | C5 |
| Smart approvals guard bb CLI use (D37, F11, R20) | VERIFIED false | C2 |
| Sensitive tools = health, location, Home Assistant (D36, A40) | VERIFIED incomplete | C7 |
| `venv/bin/python` is co-versioned with Hermes (02, T0.4; R3 M4) | VERIFIED false: webui's Python 3.11 env, `hermes_agent-0.21.0` metadata | C3; retiring webui could also remove it |
| Command approvals last 300 s (F8) | VERIFIED: live default `approvals.timeout: 60`; gateway waits use it (`tools/approval_context.py:305-313`) | Cards in `default` close after 60 s |
| Author comes from `cli_turn_v1.turn_author` (02, A4) | VERIFIED: Discord admissions carry `native_text_v1.source.user_id`; 0 of 8 in `default` have `cli_turn_v1` | D33's other-user branch is dead code (harmless under A39) |
| `schema_version` identifies the schema (02 schema check) | VERIFIED weak: all at 32, but `delivery_obligations` exists only in default and david | Same version ≠ same tables |
| Voice is client-side dictation (F2) | VERIFIED: bb voice = Codex service; titles = Local AI; bb cloud signed out (`bb settings ai-services show`, `bb ai status`) | Audio goes to OpenAI, as Hermes already does |
| ACP baseline ~10/week (README Goal) | VERIFIED: 19 in 28 days; 14 of them in the last week | C1 |
| P1 bot AC "session titled Alex" (F4) | VERIFIED from plan text: the title push is P2 (flow 7, T2.5a) | P1 gate fails as written; pass `title` on `session.create` |

## What the plan missed
- **The deny-list fails open.**
  - Hermes already relabelled `acp` and `cli` rows to `source=local` plus `created_source`.
  - 02 checks both columns only for `acp`. If cron follows, alex's ~130 cron runs a month auto-import, and D26 makes them push.
  - Fix:
    - every deny label checks both columns;
    - a circuit breaker: more than 5 new auto-imports in a day → pause and show health red.
- **"Trim the stack" needs no plugin.**
  - Webui is unused (store untouched since Sep 6).
  - Something still polls `/api/session/status` (r04 §4). Find it, then retire webui.
- **Upkeep budget: whose hours?** With delegated agents (D14), log your attention hours apart from agent runs. The kill criterion should use yours.
- **Updates are huge jumps.**
  - Oct 21 spanned 30,750 commits and Nov 3 spanned 3,963 (VERIFIED: reflog and `git rev-list --count`).
  - Stable tags ship almost daily too (`v0.22.6` Nov 2, `v0.22.7` Nov 3).
  - Budget upkeep per update, and expect the drift check to fire on most updates.
- **Golden files** need one human check against Hermes Desktop, or Hermes' projection as the oracle (C3). Otherwise the canary only detects change, not omission.
- **ACP probes keep landing** (~4 a day) until P3. The metric already requires "ACP unused", so you could disable ACP at the go/no-go.
- **Handoff source:**
  - R1 M8 suggested `session.export`, but it needs a live ref (`gateway/session_tui_ops.py` `_live_ref`), so it can adopt legacy rows.
  - bb's own timeline avoids that (C4).

## Overlap with R1–R5
- **Dropped as duplicates:**
  - R5 C1 demand numbers (re-measured; same picture);
  - R5 C2 churn and young APIs;
  - R5 C3 Neo bypass, child permission modes and Desktop "Approvals: off";
  - R5 C5 legacy claims;
  - R1 M5 no-events mirror;
  - R2 S3 double push;
  - R5 C7 dead read state;
  - R3 release and rollback;
  - R4 M3 compaction rows.
- **Earlier fixes I think are wrong:**
  - R5's kill-criterion metric (bb-started messages ≥ baseline): can't fail; doesn't inform P2 (C1).
  - R5 C4 / T0.4 / R3 M4 "Hermes' reader in its venv": wrong interpreter. Use REST, or the launcher's Python (C3).
  - R5 Q3 listed "Hermes approvals apply" as a pro of skills + terminal: they never fire for `bb` (C2).
  - R5 C2 daily audit: Hermes anchors and bb turns both come from our reader, so it can't see reader bugs (C3).
  - R4 M3b: the excluded-row list stops at compaction. Hermes' projection has at least 5 more rules (C3).
  - R1 M7 / D16 adopt on first send: right for pre-migration rows, wrong for Conduit's live rows (C5).
  - R2 U1 → D26 "Pulse pushes": contradicts D33 and duplicates Conduit (C6).
  - R2 S8 webui retirement at the end: it has no dependency on the plugin; do it now.

## Questions for the user
1. **Go/no-go measure and P2 shape**
   - **bb's share of your typed Hermes messages; P2-lite unless outside volume stays over ~5/week (recommended).** Pros: measures "do all chatting in bb"; testing can't game it; P2-lite is about 4 tasks. Cons: outside sessions become bb threads only when you continue them, which cuts "every session is a bb thread".
   - **As planned: bb-started ≥ ~10/week, then full P2.** Pros: no change. Cons: passes on dogfood alone; says nothing about P2.
   - **Share metric, then full P2 on go.** Pros: honest metric; full vision. Cons: P2's cost, for ~5 typed outside messages a week.
2. **Hermes reaching bb (TS.1), given "$WORK_MODEL_RULE"**
   - **Neo only, as today; no TS.1 until a guard exists (recommended).** Pros: no new exposure; no work. Cons: default, alex and david can't start bb work; Neo's existing exposure stays.
   - **TS.1 plus a small approval hook** for `bb thread spawn|tell|interactions`. Pros: a real prompt before acting. Cons: a Hermes plugin after all; prompts on phone and Discord; reads stay unguarded.
   - **TS.1 as planned (guidance only).** Pros: simplest. Cons: no guard; work data can reach OpenAI and local models.
3. **Read path for imports and mirror**
   - **Hermes' own REST projection over a `native-http` ticket, spiked first in T0.4 (recommended).** Pros: Desktop's maintained path; Hermes' display rules; no private schema. Cons: not yet exercised; a ticket per request; unavailable while the gateway restarts.
   - **TypeScript reader on `state.db`, as planned.** Pros: works with the gateway down; binding verified. Cons: re-implements the projection; its checks compare it with itself.
4. **Conduit chats and Pulse in bb**
   - **Read-only with Continue in bb; Pulse muted and unpinned (recommended).** Pros: no adoption of rows Conduit writes; no ~7 duplicate pushes a day. Cons: no in-place reply to a Conduit chat from bb.
   - **As planned (adopt on first send; Pulse pushes).** Pros: in-place reply. Cons: C5 and C6.
5. **Retire hermes-webui now** (a user-approved nix-config change)
   - **Yes, after finding what polls it (recommended).** Pros: the trim you asked for, today; frees `:8787` and `:8446`. Cons: an unknown poller may break.
   - **Keep it until P3.** Pros: nothing changes now. Cons: a free win waits behind the go/no-go.

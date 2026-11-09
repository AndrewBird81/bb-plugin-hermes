# Operations

How the plugin is run on a real setup. Personal values are written as variables (`docs/variables.md`).

## History reader (T0.5)

Pick: Hermes' REST projection over a `native-http` ticket (`src/hermes/history.ts`). No `node:sqlite` fallback: REST lacks no field bb needs (A36).

Evidence (isolated Hermes c314285f07, stub model; `npx tsx test/fixtures/rest/record.ts` regenerates `test/fixtures/rest/`; `fixtures.test.ts` asserts each point):
- A36 ✓: `GET /api/sessions?profile=<name>` and `…/{id}/messages` answer on the gateway's `api_origin` for every served profile, root included, with a ticket minted on the root's `gateway.sock` for that profile (no scope). A ticket for another profile → 403 `profile_scope_mismatch`. Live (read only): one list per served profile, all 5 answered; same row keys (`live-list-keys.json`).
- A1 ✓ with notes: rows carry `title`, `source` (`local`; surface in `created_source`), `chat_id` (= lineage root; null on a legacy row), `hidden` (0/1), `archived`, `cwd`, `message_count`, `last_activity_at`; messages carry `message_uid`, `display_kind`, `display_metadata`, `active`, `compacted`. The list never shows hidden rows (the Bot Chat): find it with `session.list`. A rotated chain lists its tip only; `…/messages` of any chain id answers for the tip, ancestors included.
- A4 partly: `bb:` `submission_id` persists on submits, queued and hidden prompts; a repeated one returns the same admission, no new row. Not on steers (a `display_kind: steer` user row, words in `display_content`) and not on `/retry` (a new user row, new uid, the first turn stays).
- A8 ✓ with rules: uids survive clones, but a rotated chain lists cloned user rows twice, and an in-place compaction's default view drops compacted rows, so turn 3's reply then sits under turn 2. Read with `include_compacted=true`, dedupe by `message_uid` (first wins), skip `hidden` reply rows and `steer` rows as anchors: the same turns before and after.
- A48 ✓: a chat the dashboard holds reads through REST; a canonical resume meanwhile → `runtime_coordination_required`; the row stays `source: desktop`, `chat_id: null`.
- Paging: list `limit` ≤ 100, messages ≤ 500 (default: the latest page; pass `order=oldest`).

## Surfaces (P2, Hermes c314285f07)

Which app a session's recorded surface (`source`, or `created_source` when `source=local`) names. Source read only; no value has a single writer, so no badge or label names an app (owner ruling).

| Value | Writers in Hermes |
|---|---|
| `cli` | `hermes chat` / `hermes` (`hermes_cli/gateway_chat.py:203`), `-c <title> --create-if-missing` (`hermes_cli/gateway_session_store.py:563`), Bot Chat delivery from other bots (`gateway/session_bot.py:370`), one-shot on a gateway without `oneshot` (`gateway_chat.py:199-203`); raw `source=cli`: older CLI rows and API-server `POST /api/sessions {source:"cli"}` (`gateway/platforms/api_server.py:1564, 2620-2623`, `created_source` null) |
| `tui` | the TUI (`ui-tui/src/canonicalGateway.ts:15-18`), the dashboard Chat tab (`hermes_cli/web_server_chat.py:491-520`), `hermes chat --source tui` (`hermes_cli/_parser.py:317`) |
| `gui` | a canonical policy label only: stored as `created_source=desktop` (`gateway/session_policy.py:88-107`); bb's own side chats are `local`/`desktop` too |
| `desktop` | Desktop, local and remote (`apps/desktop/src/api/canonical-protocol.ts:548`), bb (`gui`), `hermes chat --source desktop`, the dashboard's legacy socket (Conduit, `tui_gateway/methods_session.py:65-67`), legacy onboarding (`tui_gateway/methods_onboarding.py:197`), API-server rows, adopted phone-app rows (`hermes_state_local_migration.py:131-134`) |

- Kept out by the allow-list: `oneshot`, `tool`, `cron`, `kanban`, `subagent`, `acp` (`local`/`acp`), `a2a`, `bot_room`, `api_server`, chat apps. REST never lists hidden rows (`hermes_state_sessions.py:1329-1330`).
- Known gap: an API-server client that labels its session `cli` or `desktop` mirrors. Live (read-only count, 2026-11-09): every API-server row is `source=api_server`.
- Adoption keeps `source=desktop` and the row's own id as `chat_id` (`gateway/session_local_migration.py:257-330`): the binding's lineage root doesn't move.
- Activity: REST `last_active` = max(heartbeat, newest message, start) (`hermes_state_common.py:258-274`); the raw `last_activity_at` is heartbeats only, null on older rows and a rotated chain's root value (live: 11 visible rows with it null).
- Titles: Hermes titles a chat at its first turn (`derived`, then an LLM upgrade, `agent/title_generator.py:625-690`); a user rename wins (`hermes_state_titles.py:117-118`); a rotated chain lists the tip's title, else the root's (`hermes_state_session_list.py:28-38`).

## P0 live results (T0.11, 2026-11-08)

- Releases `v0.1.0` and `v0.1.1`; `main` on origin at `v0.1.1`. Live install `hermes@0.1.0`, health connected, Hermes 0.22.6 supported; one update to `0.1.1` (A26 verified).
- Live Hermes before and after (read-only snapshot): the plugin made 0 writes (no session created or changed, `config.yaml` and `.env` mtimes unchanged, no skill dir, same gateway pid). One empty `acp` session came from bb's provider-acp probe (04 §Rollout).

## P1 live dogfood (owner present)

Run in order on the P1 release; each step needing an approval checks §Approvals first. Live Hermes writes happen only through the owner's own actions in these steps. Before step 1 and after the last: `node scripts/live-audit.mjs --since <unix seconds>` (read-only): 0 `bb:` admissions or messages and no `skills/bb-plugin-hermes/` until step 3, then only what the steps caused.

1. **Release `v0.2.0`** [approval: push, tag, release]: 04 §Release steps 1–3.
2. **Live update** [approval: live bb change]: `bb plugin update hermes`, then `bb plugin rpc call hermes stopHosted`. `diagnostics`: the new build on the worker and every bridge, health connected and supported, no errors, no duplicate bindings. `bots`: every bot off (D43).
3. **Neo on** [approval: live bot switch-on; writes a skill into the profile and runs `refresh-prompts`]: skill + `.bb-plugin-hermes.json` in the profile's `skills/bb-plugin-hermes/`, the wrapper in the worker's `bin/`; one pinned "Neo" thread holding the Bot Chat's last 30 days, 0 unread, 0 pushes (01 §8).
4. **bb access** (A43, A44): in the bot thread, "list my bb threads" runs `bb-hermes thread list` against the remote bb server; the same from Conduit.
5. **Shared Bot Chat** (D19, A-S8a–c, A30, A13): on the phone, a bb message in the bot thread, then a Conduit message → one conversation, in order, in both apps; Conduit's own turn shows the message, then the reply; a bb send during a Conduit turn shows "Waiting for another Hermes process…"; a Conduit send during a bb turn streams tagged `[Outside bb]`; no bubble or banner names an app.
6. **Side chat with Neo** (01 §4, §5): reasoning High reaches Hermes (`session.info`); an image is described, a PDF warns; voice dictation; an approval (deny leaves the target untouched, once runs once, a timeout closes the card); a `clarify`; Stop (≤ 1 s); steer; a command Hermes' smart approvals escalate (R5 C6). Commands touch only `/private/tmp/bb-hermes-test/dogfood/`. An abandoned "New chat" leaves 0 Hermes sessions.
7. **CLI turn in the Bot Chat** (A19, A13): it streams in the bot thread within ~3 s; Stop on it → "Running outside bb" (01 §5), the reply still shows at the end.
8. **`/new` in the bot thread**: a compaction (`context.compacted`), same lineage root, 0 new sessions.
9. **`default` on** [approval: live bot switch-on] (`compression.in_place: false`, r12 §5): `/new` → the thread follows the tip.
10. **`bb thread spawn`** (A18): `--project proj_personal --provider hermes --option profile=neo` from `$HERMES_HOST` replies; from `$WORK_HOST` it fails "Hermes runs on `$HERMES_HOST`: add `--machine $HERMES_HOST`".
11. **Off, then on** [approval: switch-on again]: off archives Neo's threads and removes the skill (and the wrapper when no bot is on); on brings the same threads back (no duplicates) with the turns made while off.
12. **Offline** (A9): `$HERMES_HOST` off the network for 2 min → "… is offline: sends wait until it reconnects"; a CLI turn meanwhile mirrors after reconnect.
13. **Redeploy** (flow 12, A26): on the next update, `stopHosted`, then `diagnostics` shows no bridge on the old build.
14. **Other bots**, one at a time [approval: each switch-on].

Dogfood-only assumptions: A9, A13 (live latency), A16 (remote host RPC, ~15 s cold `model.options`), A18, A25, A30, A43/A44 on live Neo, A-S8a–c (the real Conduit app).

Results (2026-11-09, UTC). Steps 1–9, 11 and 14 passed; step 10 failed (BUG 4); step 12 and the phone are the owner's; step 13 comes with the next release.
- **Steps 1–2:** `v0.2.0` released (tag `2ef01570`). After the update and `stopHosted`, the worker and the bridge both run `0.2.0+d6c73a23c879`; health connected, Hermes 0.22.6, supported; every bot off; 0 Hermes writes.
- **Step 3:**
  - `setBot` on Neo wrote `SKILL.md` and `.bb-plugin-hermes.json` (version 0.2.0), and the wrapper in `host-data/bin/`;
  - Neo's `state_meta` gained `prompt_refresh.epoch`;
  - one pinned thread titled "Neo" holds 15 turns: the init and 14 imported user turns, tagged `[Outside bb · Nov 4]` and so on;
  - 0 pushes during the import;
  - `diagnostics`: bindings 1, duplicates 0, no errors;
  - 0 Hermes sessions created or changed, 0 `bb:` messages;
  - Neo's Bot Chat was already gateway-owned: no adoption pending.
- **Step 4:** Neo ran the `bb-plugin-hermes` skill through the `bb-hermes` wrapper against the remote bb server; 1 `bb:` admission, in the same session.
- **Step 6** (Neo side chat): reasoning high reached `session.create`; an image described; Deny ran nothing; Allow once ran once; `clarify` answered; Stop in 0.28 s; steer joined the turn; an empty `newChat` left 0 sessions.
- **Step 7** (on the side chat's session): the CLI turn showed 2.8 s after Hermes stored it, live, tagged `[Outside bb]`; Stop showed "Running outside bb", and the full reply came once.
- **Step 8** (david): a real in-place compaction, 54 → 46 messages, same id. A short Bot Chat's `/new` is Hermes' `noop` (BUG 2).
- **Step 9:** `default`'s rotation, on a side chat: 12 turns, then `/new`, gave a new tip; the next turn landed on it. `default`'s Bot Chat imported 0 turns (last active Aug 22).
- **Step 11** (alex): off archived 2 threads, deleted the skill, kept the wrapper; on brought back the same 2 threads and the turn made while off.
- **Step 14:** alex and david on, 0 pushes.
- **Owner, on the phone:** "Everything else looks great": the conversation shared with Conduit, voice dictation, the badges. No banner seen live: they show only when held, on Stop of an outside turn, and offline.
- **Live notes:** bb's send waited ~32 s behind the owner's own Conduit turn; a forwarded Conduit send streamed as `[Outside bb]`; the CLI can't run a turn on a Bot Chat Conduit holds ("This chat is open in another Hermes window/terminal"); during a Conduit turn of its own, bb's send shows Conduit's reply after bb's turn, though Hermes stored it first (P2: why, 01 §6).
- **Hermes writes:** only the tests' own (3 side-chat sessions and a rotation tip, 1 Neo Bot Chat turn, david's compaction, skills, markers, refresh epochs) and the owner's own activity; gateway pid, config and `.env` unchanged.
- **Now on:** Neo, `default`, alex, david; `todoist` off.
- **Found, fixed in P2:**
  - BUG 1: `default`'s catalog (93 models with their reasoning ladders) is 77 116 bytes, over bb's 64 KiB extension-state limit: refused.
  - BUG 2: `/new` on a short chat showed "Context compacted" for Hermes' `noop`.
  - BUG 3: every first import leaves its bot thread unread (Neo: `lastReadAt` 57 ms before `latestAttentionAt`; alex, david): the import's `markRead` ran in the gap before its last queued turn started.
  - BUG 4 (step 10): from `$WORK_HOST`, `bb thread spawn` without `--model` fails "HTTP 503: The hermes model catalog is empty…" with no thread; with `--model` it says "add `--machine the Hermes machine`" (provider options carry no machine name).
  - The bot thread's `titleFallback` is the raw init marker: bb derives it from every text part of the spawn input, agent-only included.

## P2 live dogfood (owner present)

Run in order on `v0.3.0`; each gated step checks §Approvals first. The import writes nothing to Hermes; live Hermes writes come only from the owner's own actions (steps 5–7). Every read below is read-only (`sqlite3 -readonly`, `diagnostics`, `bb thread get`).

0. **Baseline:** `S=$(date +%s)`; the gateway pid from `~/.hermes/gateway.pid`; `node scripts/live-audit.mjs --since $S`. Per bot already on (Neo, `default`, alex, david): `npx tsx e2e/eligibility.ts --folder ~/.hermes --profile <bot> --since <its switch-on, Unix s, − 2592000>` → `would_import` (P1 bound only bot threads and side chats, which it leaves out).
1. **Release `v0.3.0`** [approved 2026-11-09]: 04 §Release steps 1–3 (the stack's last commit is `release: v0.3.0`).
2. **Live update** [approved 2026-11-09]: `bb plugin update hermes`, then `bb plugin rpc call hermes stopHosted`. `diagnostics`: `0.3.0+…` on the worker and every bridge (P1 step 13), health connected and supported, duplicates 0, no errors.
3. **Upgrade import** (automatic, at the first full reconcile; part of the approved update): per bot, its new mirrored threads == step 0's `would_import`; every one `bb thread get <id> --json` → `lastReadAt ≥ latestAttentionAt`, `titleFallback` null, Hermes' title; 0 pushes. Also BUG 1: `default`'s composer lists its models (no `provider/unhandled`); BUG 2: `/new` in a short Bot Chat → "Nothing to compact yet…".
4. **P1 bot threads:** Neo's, `default`'s, alex's and david's keep the init marker as `titleFallback` (bb never changes it; a set title wins everywhere bb shows one) and may still be unread from the P1 import: mark them read. Optional [live bb change]: delete one; it comes back pinned at the next reconcile with no fallback, its Bot Chat imported again.
5. **New chat:** `hermes -p neo chat` → a thread, unread, no push, within ~5 s; a reply from bb → `hermes -p neo chat --resume <id>` has it.
6. **Conduit chat** on the phone: a reply from bb continues it in place (adoption; A-S8a–c).
7. **Title follow:** rename a chat in Hermes → bb follows; rename it in bb → it no longer does.
8. **D15:** `[Outside bb] hi` in a Hermes thread → "Remove the [Outside bb] tag to send."
9. **A49:** archive a mirrored thread, make a CLI turn in it, unarchive → the turn shows at once.
10. **BUG 4** (P1 step 10) from `$WORK_HOST`: `bb thread spawn --project proj_personal --provider hermes --option profile=neo --machine $WORK_HOST`, with and without `--model` → "Hermes runs on `$HERMES_HOST`: add `--machine $HERMES_HOST`".
11. **Outage** (A9, R3 S13): `$HERMES_HOST` off the network for 5 min → "… is offline: sends wait until it reconnects"; a CLI turn meanwhile mirrors after reconnect.
12. **todoist on** [approval: live bot switch-on]: before, `e2e/eligibility.ts --profile todoist` → `would_import` == the switch row's "Imports N chats"; after, N mirrored threads, 0 unread, 0 pushes.
13. **After:** gateway pid unchanged; `node scripts/live-audit.mjs --since $S`: only the steps' own writes.

Then T2.6 (`v1.0.0`, approved 2026-11-09) after the P2 gate. The live install tracks `@^0`, which never offers `1.0.0`: moving it to `@^1` takes `bb plugin remove` (keep a `VACUUM INTO` copy of `data.db`; settings and the connection must be saved again) and a fresh install.

## Approvals

Gated steps (pushes, tags, releases, the live install, each live bot switch-on) check this log first (04 §Rollout).

| Date | Item | Answer |
|---|---|---|
| 2026-11-08 | Push and release `v0.1.0` and `v0.1.1` | Approved ("Approve all") |
| 2026-11-08 | Live install from `@^0`, machine `$HERMES_HOST` | Approved ("Approve all") |
| 2026-11-08 | One live `bb plugin update` | Approved ("Approve all") |
| 2026-11-08 | Default: `/retry` shows as Hermes shows it | Accepted |
| 2026-11-08 | The stray empty `acp` session from bb's provider-acp probe stays | Accepted |
| 2026-11-09 | Release `v0.2.0` | Approved |
| 2026-11-09 | Live update to `v0.2.0` | Approved |
| 2026-11-09 | Neo's switch-on | Approved |
| 2026-11-09 | Proceed with the next phases | Approved |
| 2026-11-09 | "Proceed as proposed" | Approved |
| 2026-11-09 | "You can release 1.0": read as `v0.3.0` for the P2 live dogfood (its live update and 30-day import included), then `v1.0.0` (T2.6) | Approved |

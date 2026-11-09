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

## P2 e2e results (T2.5, 2026-11-09)

Isolated bb (`~/.bb-hermes-e2e`, bb-app 0.49.0) on the strict fake (`e2e/checks/p2-fake.mjs`: 60 of 62 checks pass, the 2 failures are one log-only finding below) and on an isolated Hermes c314285f07 with real rows (`e2e/hermes-ctl.ts`).
- **Import:** switch row "Imports 6 chats" = 6 mirrored threads = `e2e/eligibility` 6 = the REST rules 6 (isolated Hermes; fake: 7 = 7); every thread read (`lastReadAt ≥ latestAttentionAt`), Hermes' title, a Hermes-archived chat archived, none pinned, tags dated; `state.db` unchanged (revisions, generations, messages, admissions, `state_meta`); 0 pushes; off, then on, imports 0.
- **Out:** no thread for cron, `oneshot`, ACP, a chat app, hidden, empty, 40-day-old or bb-created chats; a chat titled `Bot Chat` binds only to the bot thread.
- **Long imports:** 25-turn chat, 30- and 45-turn Bot Chats (one with bb restarted mid-import), 25-turn Bot Chat and chat on real Hermes: every reply once; the next user send's reply pushes once.
- **Live:** a new `hermes chat` → a live, unread thread 4–5 s after the CLI exits; a bb reply continues that session (`hermes chat --resume` has it); a Conduit chat adopted in place (`legacy` cleared), its later turns mirror; title follow within 2 s, stopped by a bb rename; D15 refuses both tagged sends; D48 brings the same threads back with the turn made while off and imports a chat started while off; turns arriving during an import wake after it as `[Outside bb]`, unread; a user send queued behind an import runs once, not muted.
- **Mirror rules:** 3 re-lists → 1 bubble; a compaction adds 0 turns; `/retry` adds 1 (also on real Hermes).
- **A38:** bb stopped with a hidden import at 2 of 41 turns: after restart the thread is deleted and the chat imported once, no 409, 0 duplicates. **A49:** a wake into an archived thread is refused quietly; on unarchive the turn arrives in ~180 ms. **A53:** `titleFallback` null on all 15 Hermes threads.
- **P1 bugs:** a 120-model catalog arrives at 65 512 bytes with no `provider/unhandled`; `/new` on a short chat shows "Nothing to compact yet…"; a chat deleted in Hermes stays quiet (send: "Deleted in Hermes"; no errors across restarts).
- **Open (log only):** stopping bb mid-way through a bot thread's import logs ~100 errors (`job_failed`, `finalize_failed`) as the daemon disconnects; `diagnostics` after the restart is clean and the import completes once.
- Live Hermes untouched by every run: gateway pid unchanged; `live-audit` showed nothing from the runs; only `sqlite3 -readonly` counts touched it.

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

Results (2026-11-09, UTC). Steps 0–5, 7–10 and 13 passed. Step 6 is the owner's (the phone); step 11 was skipped (it cuts off the machine the agents run on); step 12 was skipped (`todoist` stays off, D5).
- **Steps 0–2:** `v0.3.0` released (tag `c5833240`). After the update and `stopHosted`: worker and bridges `0.3.0+70cf9d628fb3`; health connected, Hermes 0.22.6, supported; errors none.
- **Step 3, upgrade import:** bindings 8 → 20, duplicates 0. `default` imported 12 threads = `would_import` 12 (one archived, as in Hermes); Neo, alex and david 0 = 0. All 12 read, `titleFallback` null, Hermes' titles; 0 pushes. Hermes: no writes besides one empty `acp` session from bb's provider-acp probe on update.
- **Step 3, bugs:** BUG 1: `default`'s catalog stored at 65,372 bytes (93 models), no `provider/unhandled`. BUG 2: `/new` on a 4-message test chat warns "Nothing to compact yet"; no `thread/compacted`, Hermes unchanged.
- **Step 5:** a `cli` chat with Neo (`hermes -p neo chat -q … --source cli`) became a thread 2.7 s after Hermes started the session: unread, `titleFallback` null, no push. A bb reply landed in the same session (`bb:` row, 0 new sessions).
- **Step 7:** a Hermes rename (`hermes -p neo sessions rename`) reached bb in 1.6 s; after a bb rename, a second Hermes rename left bb's title alone.
- **Step 8:** `[Outside bb] hi` → "HTTP 409: Remove the [Outside bb] tag to send."; no turn.
- **Step 9:** a CLI turn into an archived thread: nothing for 12 s, still archived; unarchive → the turn showed 0.34 s later, unread.
- **Step 10:** from `$WORK_HOST`, with and without `--model`: "Hermes runs on `$HERMES_HOST`: add `--machine $HERMES_HOST`", no thread. Minor bug: each refused spawn adds 2 `thread_not_found` entries to `diagnostics.errors` (fixed in `v1.0.1`).
- **Step 13:** gateway pid unchanged; config, `.env` and skill dirs unchanged. Writes: the tests' own (1 Neo `cli` test chat) and one tester error: `/new` sent with `bb thread tell` from an agent thread carries bb's `[bb message from thread:…]` prefix, so it ran as a prompt in alex's Bot Chat (1 turn, 1 push); two retries compacted that Bot Chat in place (8 → 2 active rows). Testers send slash commands unlabeled (`env -u BB_THREAD_ID`), and only into their own chats.

Then T2.6 (`v1.0.0`, approved 2026-11-09) after the P2 gate.

## Moving to a new major (`@^0` → `@^1`)

A range never offers the next major, and bb refuses to reinstall a managed plugin. Tested on the isolated bb 0.49.0 (2026-11-09): `bb plugin remove hermes` deletes the registration, settings (the folder reverts to `~/.hermes`), secrets, schedules and the git checkout, and keeps all of `plugins/hermes/` (`data.db` with bindings, bots and the saved machine; `host-data`; `bridge-data`). Threads keep their ids, pins and read state; skills stay in the profiles. After a fresh install the plugin resumes: same bindings, 0 duplicates, no re-import, health connected without saving the connection again (when the folder is the default). During the gap a send to a Hermes thread fails at once (`HTTP 409: Provider "hermes" has no bridge to run on`); Hermes turns made meanwhile mirror after the install.

1. The new tag exists: `git ls-remote --tags https://github.com/AndrewBird81/bb-plugin-hermes | grep v1.0.0` (else the install fails and leaves the plugin removed).
2. `bb plugin rpc call hermes diagnostics --json`: note the bindings total.
3. `bb plugin remove hermes`.
4. Backup, optional: `bb file read --host <bb server machine> <server data dir>/plugins/hermes/data.db --json` (base64 and sha256; the database is closed and one file right after `remove`).
5. `bb plugin install 'git:github.com/AndrewBird81/bb-plugin-hermes@^1' --yes`. If it fails: `…@^0` restores the old version on the same `data.db`.
6. `bb plugin rpc call hermes health --json` → `connected` (`folder_changed`: save the connection again in Settings).
7. `bb plugin rpc call hermes stopHosted`; `diagnostics`: the same bindings, duplicates 0, `1.0.0+…` on the worker and bridges; `bb plugin source hermes`: range `^1`, tag `v1.0.0`.

Live (2026-11-09, UTC): `v1.0.0` released (tag `9f9a436c`); the steps above, in order. The plugin was gone for 12 s. Backup: 102,400 bytes, sha256 matched, 22 bindings and 5 bots. After: health connected with no re-save; bindings 22 = 22, duplicates 0, errors none; worker and bridges `1.0.0+2b1292dd32b0`; source `^1`, tag `v1.0.0`. Hermes threads: the same 15 open, 8 archived and 4 pinned, titles unchanged, none unread; bots unchanged (`todoist` off); 0 pushes; 0 Hermes writes.

## v1.0.1 live update (2026-11-09, UTC)

`v1.0.1` released (tag `6f0109ba`): a spawn bb refuses no longer leaves `thread_not_found` in `diagnostics.errors`, and a failed job records once (by its caller, not also by the queue).
- `bb plugin update hermes --yes` (without `--yes`, off a terminal, it refuses), then `stopHosted` (15 stopped).
- After: worker and bridges `1.0.1+fc0168a19b27`; health connected, supported; bindings 15, duplicates 0; errors none. 15, not 22: seven Hermes threads were deleted in bb since the move, and their bindings went with them, as designed.
- A refused spawn from `$WORK_HOST`: the 409, no thread, errors still none. 0 pushes; 0 Hermes writes; gateway pid unchanged.

## v1.1.0 live update (2026-11-09, UTC)

`v1.1.0` released (tag `59bdb0ae`): bb's New Thread starts Hermes chats, listed only on the Hermes machine (D51–D57).
- `bb plugin update hermes --yes`, then `stopHosted` (none failed).
- After: worker and bridges `1.1.0+c4ac6dd3af46`; health connected, supported; bindings 15, duplicates 0; errors none.
- `bb provider list --machine`: Hermes listed on `$HERMES_HOST` only, not on `$WORK_HOST` or the primary, so rows have no icon (D56). 0 pushes; 0 Hermes writes; gateway pid unchanged.
- provider-acp's `acp-hermes-agent` was listed beside ours on `$HERMES_HOST` with the same icon; disabled at the owner's request (`bb provider disable acp-hermes-agent`).
- Test chat: `bb thread spawn --provider hermes --machine $HERMES_HOST` with no profile, model or level ("hello"). Bound to `default` (the fallback bot), replied; one new `default` session on the bot's own model, no reasoning effort. 1 push (a finished turn at bb's default level `all`). Archived in bb; no Hermes write. The UI's New Thread wasn't clicked on live.

## v1.1.1 live update (2026-11-09, UTC)

`v1.1.1` released (tag `54c4f9c3`): the `list-here` marker (D58).
- `bb plugin update hermes --yes`, then `stopHosted` (16 stopped, none failed).
- An empty `list-here` written on the primary (`$BB_SERVER_HOST`) with `bb file write --create-parents`, then `bb plugin reload hermes`.
- After: worker and bridges `1.1.1+77ff80f085de`; health connected, supported; bindings 16, duplicates 0; errors none.
- `bb provider list`: Hermes on the primary and `$HERMES_HOST`, not on `$WORK_HOST`, so Hermes rows get the icon. 0 Hermes writes; gateway pid unchanged; no Hermes turn ran.
- Don't make Hermes the default in Settings → Providers while relying on `list-here` (guide).

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
| 2026-11-09 | P1 live dogfood steps 4–14, with the `default`, alex and david switch-ons | Approved ("The tests are approved, and you can proceed") |
| 2026-11-09 | "Proceed as proposed" | Approved |
| 2026-11-09 | "You can release 1.0": read as `v0.3.0` for the P2 live dogfood (its live update and 30-day import included), then `v1.0.0` (T2.6) | Approved |
| 2026-11-09 | Moving the live install to `@^1` (`bb plugin remove`, then a fresh install), after the isolated test | Done under "You can release 1.0"; no data lost |
| 2026-11-09 | Release `v1.0.1` and its live update | Approved ("Fix the bugs and release 1.0.1") |
| 2026-11-09 | Sidebar Hermes icon (needs Hermes in bb's provider list, reversing D2) | Deferred: "I'll fold it in to my next major initiative" |
| 2026-11-09 | New Thread listing: only where Hermes runs (B, D56) | Chosen ("Let's go with B for now") |
| 2026-11-09 | Remote mode (research 15) | Dropped (D57: "we can punt entirely") |
| 2026-11-09 | Release `v1.1.0`, its live update, one live test chat with `default` | Approved ("Approved") |
| 2026-11-09 | Disable provider-acp's `acp-hermes-agent` on live bb | Done at the owner's request |
| 2026-11-09 | Build `list-here` (D58), release `v1.1.1`, update live and write the marker on the primary | Approved ("Go for it (deploy and publish)") |

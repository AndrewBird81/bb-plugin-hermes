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

Results (2026-11-09, UTC). Steps 1–3 passed; steps 4–8 wait on the owner.
- **Steps 1–2:** `v0.2.0` released (tag `2ef01570`). After the update and `stopHosted`, the worker and the bridge both run `0.2.0+d6c73a23c879`; health connected, Hermes 0.22.6, supported; every bot off; 0 Hermes writes.
- **Step 3:**
  - `setBot` on Neo wrote `SKILL.md` and `.bb-plugin-hermes.json` (version 0.2.0), and the wrapper in `host-data/bin/`;
  - Neo's `state_meta` gained `prompt_refresh.epoch`;
  - one pinned thread titled "Neo" holds 15 turns: the init and 14 imported user turns, tagged `[Outside bb · Nov 4]` and so on;
  - 0 pushes during the import;
  - `diagnostics`: bindings 1, duplicates 0, no errors;
  - 0 Hermes sessions created or changed, 0 `bb:` messages;
  - Neo's Bot Chat was already gateway-owned: no adoption pending.
- Found (fixed in P2): the bot thread's `titleFallback` is the raw init marker (bb derives it from every text part of the spawn input, agent-only included); the thread is left unread (`lastReadAt` 57 ms before `latestAttentionAt`: the import's `markRead` ran in the gap before its last queued turn started).

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

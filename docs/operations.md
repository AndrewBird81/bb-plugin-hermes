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

## Approvals

Gated steps (pushes, tags, releases, the live install, each live bot switch-on) check this log first (04 §Rollout).

| Date | Item | Answer |
|---|---|---|

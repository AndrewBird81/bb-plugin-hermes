# 04 — Delivery

## Repo layout (this repo, public; D50)

```
package.json          bb manifest (server, app, host); engines bb >=0.49.0; bbPluginSdk 0.6.132 (live bb, 2026-11-08);
                      scripts pin the bb bundled in bb-app@0.49.0 for builds (scripts/bb.mjs)
server.ts host.ts app.tsx   entries only
assets/hermes.svg     provider, rail and row icon
assets/skill/         the bb skill template (SKILL.md) written into enabled profiles
src/shared/           marker.ts, host-contract.ts, rpc-contract.ts, sources.ts (allow-list)   (lead)
src/hermes/           client.ts (canonical), history.ts (REST reader)                        (client)
src/bridge/           turns, segmentation, mapper, interactions, Bot Chat rules, replay/mirror (bridge)
src/server/           mapping db, switches, import, wakes, dispatch hook, diagnostics        (server)
src/worker/           watch, history reads, Bot Chat lookup, models, skill files, version check (worker)
src/app/              settings page, rail panel, row badge, banners                          (app)
test/fake-hermes/     strict fake; vendored contract; recorded REST responses                 (client)
test/fixtures/        recorded frames and REST responses, redacted                            (e2e)
e2e/                  isolated-bb scripts, sbb, two-client harness, eligibility               (e2e)
contract/             used-surface.json (lead lands it; client keeps it current), contract:check (client)
docs/                 plan, diagrams, guide.md, operations.md (existing docs stay)            (lead)
scripts/              check-private.mjs (existing), bb.mjs (pinned bb CLI)
```

## Phases

Phases run in order; the owner can stop after any of them (D47). Each ends with its gate (03); its live dogfood runs on a `v0.x.y` release, and `v1.0.0` follows the P2 gate. Inside a phase, seams run in parallel.

| Phase | Usable result | Acceptance |
|---|---|---|
| P0 Foundations | Live bb shows Hermes health and version support | 01 §1 AC; 03 P0 gate |
| P1 Chats and Bot Chats | Switch a bot on; chat in its pinned Bot Chat, shared with Conduit; side chats; approvals; bound threads mirror | 01 §2 (without import), §3–§6, §8, §9 AC; 03 P1 gate |
| P2 Full mirroring | Every CLI, TUI, Desktop and Conduit chat of enabled bots in bb; 30-day import at switch-on; D48 catch-up | 01 §2 import AC, §7 AC; 03 P2 gate; v1.0.0 released |

## Work breakdown

Seams: `lead` (contracts, live steps with the owner, docs), `client`, `bridge`, `server`, `worker`, `app`, `e2e` (verifier; never gates its own code). One seam per task (D14); the lead lands cross-seam contracts first.

| ID | Task | Seam | Depends |
|---|---|---|---|
| T0.1 | Scaffold: manifest, SVG, vitest, `npm run check`, pinned build `bb` | lead | — |
| T0.2 | Contracts: markers, host contract, RPC, machine and folder settings, source allow-list | lead | T0.1 |
| T0.3 | Canonical client port; `gateway.sock.path` fallback; reconnect | client | T0.1 |
| T0.4 | Strict fake Hermes (vendored contract incl. legacy `methods`) | client | T0.3 |
| T0.5 | History reader: REST list + messages per profile over `native-http` on isolated Hermes; record fixtures; `node:sqlite` only if a field is missing; record the pick in `docs/operations.md` (A1, A4, A8, A36, A48) | client | T0.3 |
| T0.6 | Mapping db, migrations, dedupe | server | T0.2 |
| T0.7 | Provider registration (hidden); bridge skeleton; build registry | bridge | T0.2 |
| T0.8 | Worker: `ensureWatch{root}`, boot id, `describe` (served profiles), version check (A51), `diagnostics` | worker | T0.3 |
| T0.9 | Server: 60 s keep-alive, health, `diagnostics` RPC | server | T0.6, T0.8 |
| T0.10 | App: settings page (machine, folder, health) | app | T0.9 |
| T0.11 | Release `v0.1.0`; live install `@^0`; one update (A26) | lead | T0.1–T0.10 |
| T1.0 | Fixtures (03 §Recorded fixtures, T1.0 rows) | e2e | T0.4 |
| T1.1 | Bridge turns: start/resume/stop, lazy create, identity, segmentation, fencing, `not_found`, `/new` → compress | bridge | T0.4, T0.7 |
| T1.2 | Bridge interactions: approvals, `clarify`, deadlines, session-scoped | bridge | T1.1 |
| T1.3 | Bridge: chip, catalog, model validation, reasoning, attachments | bridge | T1.1 |
| T1.4 | Bridge: Bot Chat rules (flow 3): title binding, lazy create, wait-and-retry banner, legacy adoption | bridge | T1.1 |
| T1.5 | Bridge: reconnect and restart, `prompt.resolve_unknown` (flows 8–9) | bridge | T1.0, T1.1 |
| T1.6 | Bridge: replay and mirror modes; foreign admission rendering; tip follow (flows 5–7) | bridge | T1.1, T0.5 |
| T1.7 | Worker: models + prewarm; `findBotChat`; `listSessions`/`readTurns`; watch (hint + WAL) | worker | T0.5, T0.8 |
| T1.8 | Worker: `setBotAccess` (wrapper, skill, marker, `refresh-prompts`; A43–A45) | worker | T0.8 |
| T1.9 | Server: switches (flow 1, without P2 import), bot thread spawn, D48 archive/unarchive | server | T0.6, T1.7, T1.8 |
| T1.10 | Server: `newChat`, init dance, placeholder title, `thread.created` binding, `stopHosted` | server | T0.9 |
| T1.11 | Server: import engine for the Bot Chat; wakes for bound threads; notification levels | server | T1.7, T1.9 |
| T1.12 | App: switch rows (grant text, import-count slot), rail panel, row badge (A28), banners (A47), offline banner (A9) | app | T1.9, T1.10 |
| T1.13 | Two-client harness (03) | e2e | T1.4, T1.6 |
| T1.14 | P1 e2e + dogfood (phone, Conduit, two machines) | e2e | T1.1–T1.13 |
| T2.1 | Server: discovery of unbound chats (allow-list, tombstones, `expected_id`) | server | T1.11 |
| T2.2 | Server: 30-day import at switch-on; switch-row count; interrupted-import redo | server | T2.1 |
| T2.3 | Server: title follow (`title_set`); dispatch hook (D15) | server | T2.1 |
| T2.4 | Docs: `docs/guide.md` (install, switches, what bb access means, rollback), `docs/operations.md` | lead | T2.2 |
| T2.5 | P2 e2e, `e2e/eligibility`, dogfood | e2e | T2.1–T2.3 |
| T2.6 | Release `v1.0.0` after the P2 gate | lead | T2.5 |

Critical path: T0.1 → T0.3 → T0.4 → T1.1 → T1.4 → T1.6 → T1.13 → T1.14 → T2.1 → T2.2 → T2.5 → T2.6.

## Assumptions to verify

| ID | Assumption (ASSUMED unless marked) | Verify in |
|---|---|---|
| A1 | VERIFIED (T0.5, isolated + live list keys): REST list and messages carry `title`, `source`, `created_source`, `hidden`, `archived`, `cwd`, `chat_id`, `message_uid`, `display_metadata`, active rows, and mean what we read. The list omits hidden rows | T0.5 |
| A2 | VERIFIED by code read (T1.2, bb-app 0.49.0 `host-daemon/dist/daemon-bundle.mjs`): bb auto-answers only when `approvalEnforcedBy` is `runtime` with escalation `deny`, or when no handler exists; with `provider`, mode `auto` never answers. On a real bb: T1.14 | T1.2, T1.14 |
| A3 | FAILED as worded, FIXED (T1.14, bb 0.49.0): a bridge can't close a card it raised (`notifications/cancelled` covers only dynamic tool calls) and `threads.interactions.cancel` refuses provider cards, so a dead card blocked the thread. Now the bridge lists it in `status.dead_requests` and the server stops (releases) the idle thread: timed-out and answered-elsewhere cards close by themselves in side chats and bot threads (0–4 s), with no answer from bb | T1.2, T1.14 |
| A4 | PARTLY (T0.5): bb's `bb:` `submission_id` persists on submits, queued and hidden prompts and shows in REST `display_metadata.submission_id`; a repeated one runs once. Not on steers or `/retry` rows. T1.1: the bridge takes its turn's anchors from `message.complete.persisted_turn.row_ids` → REST `id`, else the `bb:` row | T0.5, T1.1 |
| A5 | VERIFIED no (R5): Conduit isn't distinguishable from other dashboard clients. Hermes records no per-turn source either, so bb never names an app: outside messages read `[Outside bb]` (owner ruling, 2026-11-08) | — |
| A8 | VERIFIED for compaction (T0.5) with the 02 §History reader rules (`include_compacted`, uid dedupe, steer and hidden rows skipped); T1.6: replay and mirror render each turn once across in-place and rotating compaction (bridge tests on the engine, two-client E7/E8). `/retry` adds a turn, shown as such (owner default) | T0.5, T1.6 |
| A9 | VERIFIED (T1.14, isolated bb, daemon paused): bb queues the send ("waiting for … to reconnect") and runs it after; health showed offline after ~1 min and recovered ~30 s after reconnect. The banner text on a real outage: dogfood | T1.14 |
| A13 | VERIFIED (T1.14, isolated bb): a Conduit-style turn's bubble in 1.4 s (fake) and 3.1 s (isolated Hermes); a real `hermes chat --resume` turn showed in 2.7 s and streamed. Live latency: dogfood | T1.14 |
| A15 | VERIFIED (T1.1): conformance passes every scenario with `pending:<threadId>` at start | T1.1 |
| A16 | PARTLY (T1.7): the host RPC output limit is 8 MiB, so `readTurns` keeps the newest turns under 4 MiB and sets `truncated`; prewarmed `models` answers in ~1 ms, isolated `model.options` 0.6–0.7 s cold, 32–36 ms warm (stub model). Live: a remote server and the ~15 s cold `model.options` are dogfood-only | T1.7, T1.14 |
| A18 | VERIFIED on the Hermes machine (T1.14): `bb thread spawn --project proj_personal --provider hermes --option profile=<bot>` replies; no profile → "Pick a bot: …". From another machine: dogfood | T1.14 |
| A19 | VERIFIED (T1.0, isolated): a second canonical viewer that resumed the session gets a `hermes chat --resume` turn live; streamed == final text | T1.0 |
| A20 | FAILED (T1.0, isolated): `hermes chat -c` continues bb's `source:"cli"` chat, from the same and from another cwd; a newer `gui` chat is never picked. bb creates with `source:"gui"` | T1.0 |
| A22 | FAILED (isolated bb 0.49.0): bridges get `bridge-data`, the worker `host-data`; the worker reads the sibling dir (02 §Bridge state) | T0.8 |
| A23 | VERIFIED (T1.0, isolated): resuming a gateway-owned row changes nothing; a `session.mutate` on a legacy row, with no resume, succeeds and writes a history claim (`state_meta gateway.history_control.v1.<id>`; `chat_id` stays null), so none before adoption | T1.0 |
| A24 | VERIFIED (T1.0, isolated): `end_reason:null` leaves the row open for later turns; `"user_closed"` ends it | T1.0 |
| A25 | VERIFIED (T1.14, isolated bb 0.49.0): queued sends run as one turn each, in order | T1.14 |
| A26 | VERIFIED (T0.11, live): `bb plugin update` swapped the worker (`0.1.0+…` → `0.1.1+…`, new pid) and the maintenance bridge to the new build; the machine setting was kept, no errors | T0.11 |
| A28 | VERIFIED (T1.14, isolated bb, DOM + screenshot): with the `threadRowMetadata` experiment and Rows → Metadata on, the pinned row shows the Hermes SVG and "Hermes · Alex · Bot Chat" | T1.12 |
| A30 | Plugin slots render on bb mobile. Dogfood only | T1.14 |
| A36 | VERIFIED (T0.5, isolated; live: 5 of 5 served profiles answered one read-only list) | T0.5 |
| A37 | VERIFIED (T1.14, isolated bb): `hermes/persisted-turn` reaches the server; it binds side chats from bb's stored turns | T1.1 |
| A38 | VERIFIED (T2.5, isolated bb 0.49.0, fake): bb stopped mid-import; after restart the hidden thread was deleted and the chat imported once, re-announcing the same `providerThreadId`: no 409, 0 duplicates | T2.5 |
| A-S8a | Conduit finds Bot Chats by exact title (S). Dogfood only: the two-client harness drives Hermes' own dashboard client, not the closed Conduit app | T1.14, real app |
| A-S8b | Conduit refreshes the open chat on `sessions.changed` (S). Dogfood only: the two-client harness drives Hermes' own dashboard client, not the closed Conduit app | T1.14, real app |
| A-S8c | Conduit looks up before minting a Bot Chat (S). Dogfood only: the two-client harness drives Hermes' own dashboard client, not the closed Conduit app | T1.14, real app |
| A-S8d | VERIFIED: compaction is in place by default (`config_defaults.py:668-672`) | — |
| A43 | VERIFIED (T1.8, isolated): a skill in `<profile>/skills/` is listed in new sessions with no restart (S8 E14), and in a continuing session only after `refresh-prompts` (`[before, written, refreshed, off]` → `[no, no, yes, no]`). Live Bot Chat: dogfood | T1.8, T1.14 |
| A44 | VERIFIED (T1.8 + T1.14, isolated): the wrapper takes `BB_CLI`, `BB_SERVER_URL` and `BB_HOST_DAEMON_PORT` from the daemon's per-call environment and puts the worker's node on `PATH`; on isolated Hermes the bot ran `bb-hermes thread list` through its terminal tool against the isolated bb. Remote server: dogfood | T1.8, T1.14 |
| A45 | VERIFIED (T1.8, isolated): `refresh-prompts` exits 0 with no gateway, writes `prompt_refresh.epoch`, starts no process; a running gateway's pid is unchanged | T1.8 |
| A46 | FAILED as worded (T1.0, isolated): `/new` and `/reset` as `prompt.submit` text reset nothing; the gateway answers a non-stored "⚠️ Confirm /new … /approve" text with no model call. The bridge still intercepts them (→ compress, 01 §4); other `/` text runs as Hermes handles it | T1.0 |
| A47 | VERIFIED (T1.14, isolated bb, DOM + screenshot): the thread banner shows the held text (now "Open in another Hermes app: sends when it's free") and clears once the send goes through | T1.12 |
| A48 | VERIFIED (T0.5, isolated): the held row reads and stays `source: desktop`, `chat_id: null` | T0.5 |
| A49 | VERIFIED (T2.5, bb-app 0.49.0 source + isolated bb): bb refuses any send into an archived thread (409 `thread_not_writable` "Thread is archived", `ensureThreadIsWritable`); it stays archived, its read state unchanged. So a wake waits for the unarchive (`thread.unarchived` reconciles); `guide.md` says so | T2.5 |
| A50 | PARTLY (T1.0, isolated): `prompt.submit.attachments` `{path, mime}` takes only `image/png\|jpeg\|gif\|webp`, and the file must be a direct child of `<profile home>/cache/images/` (else `invalid_params`). T1.14 (isolated bb): an image from bb is staged as `<profile>/cache/images/bb-<uuid>.png` and the turn completes; a PDF warns and the text still goes. A described image on a real model: dogfood | T1.0, T1.14 |
| A51 | VERIFIED for the installer's default layout (`scripts/install.sh:97` clones into `$HERMES_HOME/hermes-agent`; the file is tracked). Other layouts → "version unknown" (tested) | T0.8 |
| A52 | VERIFIED (T1.14, isolated bb): with `experimental_providerIcon` registered, the composer shows the Hermes icon next to the bot chip while the provider is hidden | T1.12 |
| A53 | VERIFIED (T2.5, isolated bb): a spawn whose only input is one empty agent-only text (`spawnStart`) runs as a turn the bridge ends with no Hermes call, and `titleFallback` stays null (15 of 15 Hermes threads; bb-app 0.49.0 `deriveTitleFallback` reads every text part, agent-only included) | T2.5 |
| A54 | VERIFIED (P1 live dogfood): bb can report a thread `idle` with nothing queued while it still dispatches a queued turn, whose idle then moves `latestAttentionAt` past an earlier `markRead`; an import's end is confirmed by a quiet re-read | P1 dogfood |
| A55 | VERIFIED (source c314285f07, live list keys): REST `last_active` is a chat's latest activity (heartbeat, newest message, start); the raw `last_activity_at` is heartbeats only, null on older rows, the root's on a rotated chain (`docs/operations.md` §Surfaces) | T2.1 |
| A56 | VERIFIED (source c314285f07, live counts): no recorded surface has a single writer, so no badge names an app; Hermes stores bb's side chats `local`/`desktop`, like Desktop's: bb-created chats are found by `expected_id` and a `bb:` first submission, never by surface | T2.1 |

## Dev loop

- One jj workspace per seam (`jj workspace add ../bb-plugin-hermes-wt/<seam>`); the lead merges. Every jj command runs with `TZ=UTC`.
- Inner loop: `npm test -- --watch` on the strict fake; conformance on every bridge change.
- Isolated bb (03): `sbb plugin dev <repo>`, then `sbb plugin rpc call hermes stopHosted`; running bridges keep old code (S1-S3 fact 2).
- Isolated Hermes for approvals, Conduit rules, legacy rows and skills. Never point a dev build at a live Hermes folder.
- Before every commit: `node scripts/check-private.mjs`. Claude-family subagents run in the background.

## Release, install, update

1. `npm run check` green; gate passed.
2. Bump to `v0.x.y` (never retag); `TZ=UTC jj commit -m "release: v0.x.y"`; `TZ=UTC jj bookmark move main --to @-`.
3. With the owner's OK: `TZ=UTC jj git push --bookmark main`; `gh release create v0.x.y --target <commit>`.
- **Install (any user):** `bb plugin install git:github.com/AndrewBird81/bb-plugin-hermes@^1 --yes`. A range, never an exact tag: tags pin, and a second install is refused (R3 M2). A new major version needs `bb plugin remove` and a fresh install; `remove` keeps `data.db` (operations §Moving to a new major). Public, so the bb server needs no git credential (D29 dropped).
- **Update:** `bb plugin update hermes` snapshots `data.db` and restores it if activation fails; then `bb plugin rpc call hermes stopHosted`; check `diagnostics`.
- `guide.md` states the requirements: a bb host on the Hermes machine, Hermes with a multiplexed gateway (its default, S8 §Per-profile reach), and what a bot switch grants.
- bb upgrade runbook (R3 S7): before upgrading live bb, run e2e and conformance on `npx bb-app@<new>`, then `bb plugin types --check`.

## Rollout on the owner's setup

Each approval is logged in `docs/operations.md` §Approvals (date, item, answer); gated steps check it first.

- Approvals needed: pushes, tags and releases; the live install; each live bot switch-on (it writes a skill into a live profile and runs `refresh-prompts`).
- P0: install on live bb; machine = `$HERMES_HOST`; folder default. ACP Hermes stays as it is (retirement Later). While bb's provider-acp is enabled, installing or updating the plugin can make it probe `acp-hermes-agent` and create one empty `acp` session in live Hermes (seen at the P0 install, 1 s after the maintenance bridge started; not our code, the owner accepted it).
- P1: one bot on first (e.g. Neo), then the others one at a time. Left as is: that bot's own bb skills (`~/src/hermes-config`), `compression.in_place: false` in `default` (D50), hermes-webui (D45).
- P2: on the upgrade, each bot already on imports, once and read, its chats active since 30 days before its switch-on (02 flow 1 step 6). No re-switching.
- No gateway restart on live. Restart behaviour is tested on isolated Hermes only.

## Rollback

- **Kill switch:** switch every bot off first (removes skills, archives threads), then `bb plugin disable hermes`. Disabling alone leaves the skills in place.
- **Manual skill removal** (worker gone): delete `<profile home>/skills/bb-plugin-hermes/` (only with `.bb-plugin-hermes.json`) and `<plugin data>/bin/bb-hermes`, then `hermes -p <profile> sessions refresh-prompts`.
- **No downgrade in place:** revert, tag a new patch, `bb plugin update` (R3 M2).
- **Never `remove`** without a `VACUUM INTO` copy of `data.db`. On bb 0.49.0 `remove` keeps `data.db` (bindings, the machine in `kv`) but deletes the settings, so a reinstall's folder is the default again; the server then refuses Hermes I/O until the connection is saved again (T1.14). Re-importing orphans threads (S1-S3 fact 4).
- Hermes keeps everything bb sent; adopted Conduit chats stay adopted (benign; Conduit keeps working, S8 E10).

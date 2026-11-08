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
| A2 | With `approvalEnforcedBy:"provider"`, mode `auto` never answers a Hermes approval. If it does, try `accept-edits`, then `full`; if all answer, stop and ask | T1.2 |
| A3 | The bridge can close a pending interaction | T1.2 |
| A4 | PARTLY (T0.5): bb's `bb:` `submission_id` persists on submits, queued and hidden prompts and shows in REST `display_metadata.submission_id`; a repeated one runs once. Not on steers or `/retry` rows | T0.5, T1.1 |
| A5 | VERIFIED no (R5): Conduit isn't distinguishable from other dashboard clients; tags come from real source values | — |
| A8 | VERIFIED for compaction (T0.5) with the 02 §History reader rules (`include_compacted`, uid dedupe, steer and hidden rows skipped). `/retry` adds a turn: T1.6 | T0.5, T1.6 |
| A9 | Sends while the Hermes machine is offline wait or fail (sets the banner text) | T1.14 |
| A13 | Outside start → visible in bb ≤ 3 s | T1.14 |
| A15 | Conformance accepts a placeholder identity | T1.1 |
| A16 | Host RPC limits fit `readTurns` pages; prewarmed `model.options` ≤ 2 s | T1.7 |
| A18 | `bb thread spawn --provider hermes` works on the Hermes machine and fails clearly elsewhere | T1.14 |
| A19 | A canonical viewer gets live events of another client's turn (CLI, TUI, Desktop) | T1.0 |
| A20 | `source:"cli"` bb sessions aren't picked by `hermes chat -c`; else use `gui` | T1.0 |
| A22 | FAILED (isolated bb 0.49.0): bridges get `bridge-data`, the worker `host-data`; the worker reads the sibling dir (02 §Bridge state) | T0.8 |
| A23 | Resuming a gateway-owned row doesn't migrate it; a `session.mutate` on a legacy row claims it (code read, `gateway/session_mutations.py:174-183`), so none before adoption | T1.0 |
| A24 | `session.detach{end_reason:null}` doesn't end the row | T1.0 |
| A25 | How bb groups queued sends (what segmentation must handle) | T1.14 |
| A26 | `bb plugin update` swaps the worker like `reload` | T0.11 |
| A28 | A row-metadata item renders the Hermes SVG + text | T1.12 |
| A30 | Plugin slots render on bb mobile | T1.14 |
| A36 | VERIFIED (T0.5, isolated; live: 5 of 5 served profiles answered one read-only list) | T0.5 |
| A37 | A custom `extension.state` (`hermes/persisted-turn`) reaches the server via `experimental_thread.events` | T1.1 |
| A38 | Deleting a hidden import thread frees its `providerThreadId` (no 409, R4 S8) | T2.5 |
| A-S8a | Conduit finds Bot Chats by exact title (S) | T1.14, real app |
| A-S8b | Conduit refreshes the open chat on `sessions.changed` (S) | T1.14, real app |
| A-S8c | Conduit looks up before minting a Bot Chat (S) | T1.14, real app |
| A-S8d | VERIFIED: compaction is in place by default (`config_defaults.py:668-672`) | — |
| A43 | A skill in `<profile>/skills/` is listed in new sessions with no restart (VERIFIED, S8 E14), and in continuing sessions after `refresh-prompts` | T1.8, T1.14 |
| A44 | The worker can locate `bb` and the bb server URL as seen from the Hermes machine; `bb` with only `BB_SERVER_URL` works there (true for the owner's Neo, r12 §4) | T1.8 |
| A45 | `hermes -p <profile> sessions refresh-prompts` is runnable from the worker and neither needs nor starts a gateway | T1.8 |
| A46 | `prompt.submit` text `/new` or `/reset` would reset the chat (the gateway parses commands, `gateway/session_ingress.py`), so the bridge must intercept them; other `/` text runs as Hermes handles it | T1.0 |
| A47 | A thread banner (`ComposerCustomization{scopes:["thread"], banners}`) can show "Open in Conduit…" and "Running in <app>" | T1.12 |
| A48 | VERIFIED (T0.5, isolated): the held row reads and stays `source: desktop`, `chat_id: null` | T0.5 |
| A49 | What bb does with a wake into an archived thread (stays archived or unarchives); document it in `guide.md` | T2.5 |
| A50 | Attachments go as `prompt.submit.attachments` `{path, mime}` with a file the gateway can read (`ui-tui/CANONICAL_GATEWAY.md:53-58`) | T1.0 |
| A51 | VERIFIED for the installer's default layout (`scripts/install.sh:97` clones into `$HERMES_HOME/hermes-agent`; the file is tracked). Other layouts → "version unknown" (tested) | T0.8 |
| A52 | The composer can show the Hermes SVG while the provider is hidden (`not_installed` hides the provider glyph, S7 §4): via the chip value or `experimental_providerIcon`. Else the chip text alone | T1.12 |

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
- **Install (any user):** `bb plugin install git:github.com/AndrewBird81/bb-plugin-hermes@^0 --yes`. A range, never an exact tag: tags pin, and a second install is refused (R3 M2). Public, so the bb server needs no git credential (D29 dropped).
- **Update:** `bb plugin update hermes` snapshots `data.db` and restores it if activation fails; then `bb plugin rpc call hermes stopHosted`; check `diagnostics`.
- `guide.md` states the requirements: a bb host on the Hermes machine, Hermes with a multiplexed gateway (its default, S8 §Per-profile reach), and what a bot switch grants.
- bb upgrade runbook (R3 S7): before upgrading live bb, run e2e and conformance on `npx bb-app@<new>`, then `bb plugin types --check`.

## Rollout on the owner's setup

Each approval is logged in `docs/operations.md` §Approvals (date, item, answer); gated steps check it first.

- Approvals needed: pushes, tags and releases; the live install; each live bot switch-on (it writes a skill into a live profile and runs `refresh-prompts`).
- P0: install on live bb; machine = `$HERMES_HOST`; folder default. ACP Hermes stays as it is (retirement Later).
- P1: one bot on first (e.g. Neo), then the others one at a time. Left as is: that bot's own bb skills (`~/src/hermes-config`), `compression.in_place: false` in `default` (D50), hermes-webui (D45).
- P2: on the upgrade, each bot already on imports its chats from the 30 days before the upgrade, once (02 flow 1 step 6). No re-switching.
- No gateway restart on live. Restart behaviour is tested on isolated Hermes only.

## Rollback

- **Kill switch:** switch every bot off first (removes skills, archives threads), then `bb plugin disable hermes`. Disabling alone leaves the skills in place.
- **Manual skill removal** (worker gone): delete `<profile home>/skills/bb-plugin-hermes/` (only with `.bb-plugin-hermes.json`) and `<plugin data>/bin/bb-hermes`, then `hermes -p <profile> sessions refresh-prompts`.
- **No downgrade in place:** revert, tag a new patch, `bb plugin update` (R3 M2).
- **Never `remove`** without a `VACUUM INTO` copy of `data.db`: removal deletes the bindings, and re-importing orphans threads (S1-S3 fact 4).
- Hermes keeps everything bb sent; adopted Conduit chats stay adopted (benign; Conduit keeps working, S8 E10).

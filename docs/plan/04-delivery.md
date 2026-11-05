# 04 — Delivery

## Repo layout

```
bb-plugin-hermes/
  package.json            bb manifest (server, app, host); engines bb >=0.48.1 (open-ended), bbPluginSdk 0.6.104;
                          scripts pin the bb bundled in bb-app@0.48.1 for builds
  server.ts host.ts app.tsx   entries only
  assets/hermes.svg       provider, rail and row icon
  src/shared/             marker.ts, host-contract.ts, rpc-contract.ts, filters.ts (deny-list),
                          sensitive-tools.ts (D36)                                              (lead)
  src/hermes/             client.ts (canonical), store.ts or store.py helper (T0.4 picks)       (client)
  src/bridge/             turns, segmentation, mapper, interactions, replay/mirror              (bridge)
  src/server/             mapping db, import, wakes, state push, bots, handoff, diagnostics, audit (server)
  src/worker/             watch, store reads, mutate, models, drift                             (worker)
  src/app/                rail, home send menu, ⇧⌘H, row metadata, banner, settings             (app)
  test/fake-hermes/       strict fake gateway + snapshot state.db copies; vendored contract     (client)
  test/fixtures/          recorded frames, store snapshots, golden reader output, redacted      (e2e)
  e2e/                    isolated-bb scripts, sbb, eligibility, canary                         (e2e)
  contract/               used-surface.json, contract:check                                     (client)
  docs/                   plan, guide.md, operations.md, PLUGIN_OVERVIEW.md                     (lead)
```

No Hermes plugin (D37).

## Phases

Each phase is usable on its own and ends with its gate (03). The gates serialise the phases; inside a phase, seams run in parallel.

Changes from the brief's order:
- The live install moves to P0 (R3 S8). Settings ship with the phase that reads them.
- Bots are in P1: plain pinned chats (D35), and D19's phone gate needs one.
- Discord is part of P2: a read-only import source (D39).
- bb access from Hermes is no phase: standalone task TS.1 (D37).
- ACP retirement is P3.

| Phase | Usable result | Exit (verify: 03 gates) |
|---|---|---|
| P0 Foundations | Live bb shows Hermes health and the drift result | Server reaches the private repo (D29); live install from `@^0` and one `bb plugin update` work; provider hidden; worker alive past 5 min |
| P1 New chats + bots | Chat with any profile and bot from bb: reasoning, attachments, approvals; phone works; ACP still available | F1–F4, F8, F15; settings for profiles and models. F14 is built here or later; it gates P3 |
| **Go/no-go** (D34) | — | Below |
| P2 Import, mirror, push | All recent Hermes chats in bb, live; Discord read-only with Continue in bb; bb state pushed to Hermes | F5–F7, F9, F10, F15; import settings; audit |
| P3 Polish + retirement | One Hermes integration; docs | Parity gate (D25) incl. F14; F12 complete, F13; older chats; cleanup |
| TS.1 (standalone) | Hermes in default, alex and david uses bb like Neo | F11; user-approved; not gated by D34 |

Go/no-go checkpoint (D34):
- When: P1 has run live for 3 weeks.
- Input:
  - `diagnostics` usage: bb-started Hermes messages per week, against the ~10/week ACP baseline;
  - the upkeep log (`docs/operations.md` §Upkeep);
  - the kill criteria (05).
- The user decides:
  - **go** → P2;
  - **no-go** → stop. The user may still ask for the retirement subset (F14 + F13) or keep ACP.
- No P2+ task starts before go.

## Work breakdown

- Seams: `lead` (contracts, live steps with the user, docs), `client`, `bridge`, `server`, `worker`, `app`, `e2e` (verifier; never gates its own code).
- One seam per task (D14). For changes that cross seams, the lead lands the contract first.
- 62 tasks (was 70): P0 14, P1 22, P2 17, P3 8, standalone 1.

| ID | Task | Seam | Depends |
|---|---|---|---|
| T0.1 | Scaffold: manifest, SVG, vitest, `npm run check`, pinned build `bb`. Asks the Q8 hermes-host question before anything touches hermes-host | lead | — |
| T0.2 | Contracts: markers, host contract, RPC, Hermes host + root settings (D30), deny-list constants | lead | T0.1 |
| T0.3 | Canonical client port; `gateway.sock.path` fallback; reconnect | client | T0.1 |
| T0.4 | Store reader: compare TS `node:sqlite` with Hermes' Python reader on the T0.13 snapshots, in the worker and bridge runtimes; record the pick (the one that fails loudly) in `docs/operations.md`; mismatch policy; turn-row rules (02) | client | T0.13 |
| T0.5 | Strict fake Hermes (vendored contract incl. legacy `methods`, snapshot `state.db` copies) | client | T0.3, T0.4 |
| T0.6 | Mapping db, transactional migrations, dedupe | server | T0.2 |
| T0.7 | Provider registration (hidden); bridge skeleton; build registry | bridge | T0.2 |
| T0.8 | Worker: `ensureWatch{root}`, boot id, `describe`, drift check, `diagnostics` | worker | T0.3, T0.4 |
| T0.9 | Server: 60 s keep-alive service, `diagnostics` RPC, health | server | T0.6, T0.8 |
| T0.10 | Settings section: Hermes host and root, health | app | T0.9 |
| T0.11 | `gh auth setup-git` + `git ls-remote` as the bb server's user; live install `@^0`; one update | lead | T0.1–T0.10 |
| T0.12 | Protocol check on isolated Hermes: `commands.catalog`, `slash.exec`, `compress`, `branch{through_message_id}` (A31, A33, A34) | client | T0.3 |
| T0.13 | Record store snapshots + golden reader output from scripted scenarios on isolated Hermes (03 §4); the script is `npm run canary` | e2e | T0.3 |
| T0.14 | `npm run contract:check [--incoming]` (fetch; `git show origin/main:` contract, schema, symbols) | client | T0.3 |
| T1.0 | Fixtures: gateway restart, attachments, second viewer, detach, `hermes chat -c` | e2e | T0.5 |
| T1.1 | Bridge turns: start/resume/stop, lazy create, identity, segmentation, fencing, `not_found` | bridge | T0.5, T0.7 |
| T1.2 | Bridge interactions: approvals, clarify, deadlines, session-scoped | bridge | T1.1 |
| T1.3 | Server `newChat` (type-first, empty), init dance, `thread.created` binding, `stopHosted` | server | T0.6, T0.9 |
| T1.4 | App: rail, home send-menu spike (A27) or message box, ⇧⌘H, row metadata spike (A28) | app | T1.3 |
| T1.5a | Worker `models` + prewarm | worker | T0.8 |
| T1.5b | Bridge: chip, catalog, model validation, reasoning | bridge | T1.1 |
| T1.6a | Server: pick detection by binding state, chip revert, realtime `handoff` | server | T1.3 |
| T1.6b | Bridge: `init`, handoff block from the store, late-pick refusal | bridge | T1.5b |
| T1.6c | App: overlay navigation on `handoff` (A17) | app | T1.6a |
| T1.7 | Server: project placement (`project-checkout`) | server | T1.3 |
| T1.8 | Bridge: reconnect and restart | bridge | T1.0, T1.1 |
| T1.9a | Server: default and hidden profiles, hidden models | server | T1.5a |
| T1.9b | App: those settings | app | T1.9a |
| T1.10 | Server: replace the "New <Profile> chat" placeholder with the first message cut to 60 | server | T1.3 |
| T1.12 | Bridge: attachments | bridge | T1.0, T1.1 |
| T1.13 | Bridge: slash commands (`commands.catalog` → `bb/provider-commands`, `slash.exec`) and `/compact` → `compress` (gate P3) | bridge | T0.12, T1.1 |
| T1.14a | Bridge: `thread/fork` → `branch`, tip or checkpoint (gate P3) | bridge | T0.12, T1.1 |
| T1.14b | Server: bind fork threads on `thread.created` (gate P3) | server | T1.3 |
| T1.15 | Server: bot setup (D35): one pinned `newChat` per visible bot profile, titled by handle; idempotent | server | T1.3 |
| T1.16 | Bridge: sensitive-tool filter (D36) on every tool item and the handoff block; list test; A40 | bridge | T1.6b |
| T1.11 | P1 e2e + dogfood (phone, two hosts) | e2e | T1.1–T1.12, T1.15, T1.16 |
| T2.0 | Fixtures: subagent, legacy row (claim, adoption), legacy-writer turn mid-turn, Discord snapshot | e2e | T0.5 |
| T2.1 | Worker: watch (hint + WAL), `listSessions`, `readTurns` (uids), source → tag table | worker | T0.8, T2.0 |
| T2.2 | Server: import (deny-list incl. Discord toggle, preview, serial queue, redo, backfill) | server | T2.1 |
| T2.3 | Bridge: bind/replay/mirror from the store; mirror modes; legacy without resume; read-only chip (A41) | bridge | T1.1, T2.0 |
| T2.4 | Server: wakes (`turns`, `INSERT OR IGNORE` then send), D26 levels and auto `markRead` | server | T2.1, T2.3 |
| T2.5a | Server: state push bb → Hermes (flow 7); skips for placeholder titles, bot pins, legacy, Discord | server | T2.1 |
| T2.5b | Worker: `mutate` | worker | T2.1 |
| T2.5c | App: offline thread banner | app | T0.9 |
| T2.6a | Server: import exclusions, window, notification level | server | T2.2 |
| T2.6b | App: those settings | app | T2.6a |
| T2.7a | Bridge: delegation item | bridge | T2.3 |
| T2.7b | Server: subagent sub-thread binding | server | T2.2 |
| T2.8a | Bridge: compression follow | bridge | T2.3 |
| T2.8b | Worker: tip tracking (`resolved_id`) | worker | T2.1 |
| T2.10 | Server: `message.dispatch` hook refuses source-tagged sends (D15) and sends to Discord threads (D39) | server | T2.4 |
| T2.11 | Server: daily `audit` (anchors vs `turns` and rendered markers) in health and `diagnostics` | server | T2.4 |
| T2.9 | P2 e2e, `e2e/eligibility`, dogfood, soak | e2e | T2.1–T2.8, T2.10, T2.11 |
| T3.1 | App: settings and health polish | app | P2 |
| T3.2 | Parity checklist; A7 on isolated bb | e2e | P2 |
| T3.3 | Disable `acp-hermes-agent` (user OK) | lead | T3.2 |
| T3.4 | Worker: cleanup script (backup, exclude ACP-bound ids, list → confirm → delete) | worker | T3.3 |
| T3.5a | Server: older-chats listing + on-demand import | server | T2.2 |
| T3.5b | App: "Older Hermes chats" in the rail | app | T3.5a |
| T3.6 | Docs: `guide.md`, `operations.md` (appended each phase), `PLUGIN_OVERVIEW.md` | lead | P2 |
| T3.7 | Optional stack trim: webui, hermes-host adapter (user OK) | lead | T3.3 |
| TS.1 | bb skills in default, alex and david (01 F11): symlink Neo's 5 skills; `BB_SERVER_URL` in `.env` + `terminal.env_passthrough`; work-rule guidance in `dev-setup`; A42 | lead | user OK |

- Critical path: T0.1 → T0.3 → T0.13 → T0.4 → T0.5 → T1.1 → T1.5b → T1.6b → T1.11 → go/no-go → T2.3 → T2.4 → T2.9 → P3 (R3 S4).

## Assumptions to verify

| ID | Assumption | Verify in |
|---|---|---|
| A1 | Store columns (`pinned`, `archived`, `title`, `cwd`, `source`, `created_source`, `parent_session_id`, `chat_id`, `message_uid`, `active`) mean what we read | T2.1, read-only on live |
| A2 | With `approvalEnforcedBy:"provider"`, the declared mode `auto` never answers a Hermes approval. If it does, try `accept-edits`, then `full`; if all answer, stop and ask | T1.2 |
| A3 | The bridge can close a pending interaction | T1.2 |
| A4 | `turn_author` `bb:` persists on submits, steers and queued prompts; a repeated `submission_id` runs once | T1.1, T2.1 |
| A5 | VERIFIED no (R5): no `conduit` source in any DB, so Conduit is Desktop everywhere. T2.1 builds the tag table from real values | T2.1 |
| A6 | A delegation item can link to a sub-thread | T2.7a |
| A7 | Disabled-provider threads stay viewable | T3.2 |
| A8 | `message_uid` + `active=1` renders compaction clones and `/retry` once. uids are backfilled (0 NULL; 227 of 998 recent `default` rows inactive, R5) | T2.3 |
| A9 | Sends while the Hermes host is offline wait or fail (sets the banner text) | P2 dogfood (Wi-Fi off) |
| A13 | Outside start → bb ≤ 3 s | T2.4 |
| A15 | Conformance accepts a placeholder identity | T1.1 |
| A16 | Host RPC limits fit `readTurns` pages; prewarmed `model.options` ≤ 2 s | T1.5a, T2.1 |
| A17 | Realtime + overlay navigates only the window showing the old chat | T1.6c |
| A18 | `bb thread spawn --provider hermes` works on the Hermes host and fails clearly elsewhere | T1.11 |
| A19 | A viewer gets live events of another client's turn | T1.0 |
| A20 | `source:"cli"` bb sessions aren't picked by `hermes chat -c` | T1.0 |
| A22 | Bridges and worker share a `dataDir` | T0.8 |
| A23 | Resuming a gateway-owned row doesn't migrate it; legacy rows are only adopted on first send. A `session.mutate` on an unrouted legacy row inserts a history claim (`gateway/session_mutations.py:174-183` → `hermes_state_mutation_binding.py:74-98`, `claim=True`; read in code), so we send none until adoption | T2.0 |
| A24 | `session.detach{end_reason:null}` doesn't end the row | T1.0 |
| A25 | bb's grouping of queued sends (what the segmentation must handle) | T2.4, isolated bb |
| A26 | `bb plugin update` swaps the worker like `reload` | T0.11 |
| A27 | Send-menu rows on bb's home composer can spawn with the message | T1.4 |
| A28 | A row-metadata item renders the SVG + profile | T1.4 |
| A30 | Plugin slots render on bb mobile | T1.11 |
| A31 | There is no canonical slash catalog (R5: only the legacy `commands.catalog` and `slash.exec`, `session_controls.py:219-221`). Assumed: both answer on our host-scoped socket, as `model.options` does, and bb sends a picked command as `turn/start` text | T0.12 |
| A33 | bb's manual compaction maps to `session.mutate compress` | T0.12, T1.13 |
| A34 | Verified in code (R5): `branch{through_message_id}` (`hermes_state_mutations.py:58-68`). Live check of tip and checkpoint forks | T0.12, T1.14a |
| A36 | `node:sqlite` `readOnly` works in the daemon's Node v24.21 (VERIFIED, R5). Open: does it work inside the worker and bridge processes, and does Hermes' Python reader beat it on loud failure | T0.4 |
| A37 | A custom `extension.state` (`hermes/persisted-turn`) reaches the server via `experimental_thread.events` | T1.1 |
| A38 | Deleting a hidden import thread frees its `providerThreadId` (no 409 orphan, R4 S8) | T2.9 |
| A39 | The user's own Discord id is the single id in the profile's `DISCORD_ALLOWED_USERS` (read by name only). If there are several, every Discord author pushes. Checked 2026-11-04: one id, the same in all five profiles; recheck in T2.9 | T2.9 |
| A40 | The live names of the sensitive tools: `conduit_health`, `conduit_location`, and the Home Assistant MCP tools (prefix from live `tool_names`, read-only) | T1.16 |
| A41 | A read-only thread's chip can show the non-profile current value `discord` ("Discord · read-only"), and a profile pick fires the selection event as in S7 §1d | T2.3, T2.9 |
| A42 | In default, alex and david: symlinked skills load, and `BB_SERVER_URL` in `.env` + `terminal.env_passthrough` reach the terminal in new sessions without a gateway restart (else a restart needs user OK). Editing alex's and david's hermes-config sources keeps them across a re-distribution | TS.1 |

## Dev loop

- One jj workspace per seam (`jj workspace add ../bb-plugin-hermes-wt/<seam>`); the lead merges.
- Inner loop: `npm test -- --watch` on the strict fake; conformance on every bridge change.
- Isolated bb (03 §6): `sbb plugin dev <repo>`, then `sbb plugin rpc call hermes stopHosted`. Running bridges keep old code (S1-S3 fact 2).
- Isolated Hermes for approvals, cwd and legacy rows. Never point a dev build at live `~/.hermes`.
- Claude-family subagents run in the background; the `e2e` seam runs every gate.

## Release, install, update

1. `npm run check` green; gate passed.
2. Bump to `v0.x.y` (never retag); `jj commit -m "release: v0.x.y"`; `jj bookmark move main --to @-`.
3. With user OK: `jj git push --bookmark main`, then `gh release create v0.x.y --target <commit>`.
4. **Live bb.** It clones over https as the server's own user and gets no thread credentials (R3 M1), so P0 checks `git ls-remote https://github.com/AndrewBird81/bb-plugin-hermes` as that user first, after `gh auth setup-git` (D29).
   - Once: `bb plugin install git:github.com/AndrewBird81/bb-plugin-hermes@^0 --yes`. A range, never an exact tag: tags are pinned, and a second install is refused (R3 M2).
   - Each release: `bb plugin update hermes`, which snapshots `data.db` and restores it if activation fails. Then `bb plugin rpc call hermes stopHosted`; check `diagnostics`.
- **bb upgrade runbook** (R3 S7): before upgrading live bb, run e2e + conformance on `npx bb-app@<new>`, then `bb plugin types --check`. Health shows bb and SDK versions.

## Rollout

Each user approval is logged in `docs/operations.md` §Approvals (date, item, answer). Gated steps (T0.11, T3.3, T3.4, TS.1, the first live import and push, the go/no-go) check it before they run.

- P0: live install; ACP stays enabled as the fallback until P3. Upkeep hours are logged in `docs/operations.md` §Upkeep from here on.
- P1: bot setup once (D35). Then 3 live weeks and the go/no-go (D34).
- P2: `VACUUM INTO` a `data.db` copy → `importPreview` → user confirms → import. From P2 on, 7 days of soak with a clean audit before the next phase.
- P3: parity week → the user confirms the ACP disable, then the cleanup.
- TS.1: whenever the user approves; independent of the phases.

## Rollback

- **No downgrade in place:** roll forward with a revert and a new patch tag, then `bb plugin update` (R3 M2).
- **Kill switch:** `bb plugin disable hermes`.
- **Never `remove`/`uninstall`** without a `VACUUM INTO` copy of `data.db`. Removal deletes the bindings, and a re-import would orphan threads (409, S1-S3 fact 4).
- **Import:** RPC `listImported` → user confirms → delete those threads and their bindings. Hermes is untouched.
- **bb skills (TS.1):** remove the symlinks, the `BB_SERVER_URL` line and the passthrough entry from that profile.
- **ACP:** `bb provider enable acp-hermes-agent`.

## Data cleanup (user-confirmed only, after T3.3; R3 S10)

1. Back up each affected DB: `sqlite3 "<home>/state.db" ".backup /private/tmp/hermes-backup-<date>.db"`.
2. List the empty ACP probe sessions (`source=acp`, `message_count=0`; 137 on 2026-11-04 and growing until ACP is disabled), plus `local-a6fec510…`. Exclude any id bound to the 18 ACP threads.
3. The user confirms → `session.mutate delete` with `expected_generation` (S0-S4 §S4g).
4. Spike and test dirs: `~/.bb-spike`, `~/.bb-spike-logs`, `/tmp/spikeprep-bb`, `/tmp/spikeprep-ea`, `~/.bb-hermes-e2e`, `/private/tmp/hermes-spike`.

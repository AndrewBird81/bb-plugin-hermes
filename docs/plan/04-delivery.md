# 04 — Delivery

## Repo layout

```
bb-plugin-hermes/
  package.json            bb manifest (server, app, host); engines bb >=0.48.1 (open-ended), bbPluginSdk 0.6.104;
                          scripts pin the bb bundled in bb-app@0.48.1 for builds
  server.ts host.ts app.tsx   entries only
  assets/hermes.svg       provider, rail and row icon
  src/shared/             marker.ts, host-contract.ts, rpc-contract.ts, filters.ts (deny-list)  (lead)
  src/hermes/             client.ts (canonical), store.ts (read-only state.db)                  (client)
  src/bridge/             turns, segmentation, mapper, interactions, replay/mirror              (bridge)
  src/server/             mapping db, import, wakes, state sync, bots, handoff, diagnostics     (server)
  src/worker/             watch, store reads, mutate, models, drift, bindings                   (worker)
  src/app/                rail, home send menu, ⇧⌘H, row metadata, banner, settings             (app)
  hermes-plugin/bb_tools/ plugin.yaml, __init__.py, tests/ (own .venv, stubs)                   (hermes-plugin)
  test/fake-hermes/       strict fake gateway + fake state.db; vendored contract                (client)
  test/fixtures/          recorded frames and store snapshots, redacted                         (e2e)
  e2e/                    isolated-bb scripts, sbb, eligibility                                 (e2e)
  contract/               used-surface.json, contract:check                                     (client)
  docs/                   plan, guide.md, operations.md, PLUGIN_OVERVIEW.md                     (lead)
```

## Phases

Each phase is usable on its own and ends with its gate (03). The gates serialise the phases; inside a phase, seams run in parallel.

Changes from the brief's order:
- bb tools (P4) come before Discord (P5): both need the same per-profile `bb_tools` install, so the user approves it once.
- The live install moves to P0 (R3 S8).
- Settings ship with the phase that reads them.

| Phase | Usable result | Exit (verify: 03 gates) |
|---|---|---|
| P0 Foundations | Live bb shows Hermes health and the drift result | Server reaches the private repo (D29); live install from `@^0` and one `bb plugin update` work; provider hidden; worker alive past 5 min |
| P1 New chats | Chat with any profile from bb: reasoning, attachments, approvals, slash commands, fork; phone works; ACP still available | F1–F3, F8, F14; settings for profiles and models |
| P2 Sync, import, mirror | All recent Hermes chats in bb, live, two-way state | F5 (no Discord), F6, F9, F10; import settings |
| P3 Bots | 4 pinned bot threads shared with Conduit and Desktop | F4 |
| P4 bb tools | Hermes spawns, tells, lists, reads and waits on bb threads | F11; plugin pinned and enabled in 4 profiles (user-approved) |
| P5 Discord | Discord conversations in bb; replies post with echo | F5 Discord, F7 |
| P6 Polish + retirement | One Hermes integration; docs | Parity gate (D25); F12 complete, F13; older chats; cleanup |

## Work breakdown

- Seams: `lead` (contracts, live steps with the user, docs), `client`, `bridge`, `server`, `worker`, `app`, `hermes-plugin`, `e2e` (verifier; never gates its own code).
- One seam per task (D14). For changes that cross seams, the lead lands the contract first.

| ID | Task | Seam | Depends |
|---|---|---|---|
| T0.1 | Scaffold: manifest, SVG, vitest, `npm run check`, pinned build `bb` | lead | — |
| T0.2 | Contracts: markers, host contract, RPC, `hermesRoot` setting, deny-list constants | lead | T0.1 |
| T0.3 | Canonical client port; `gateway.sock.path` fallback; reconnect | client | T0.1 |
| T0.4 | Store reader (`mode=ro`, `schema_version` check) | client | T0.1 |
| T0.5 | Strict fake Hermes (vendored contract, fake `state.db`) | client | T0.3, T0.4 |
| T0.6 | Mapping db, transactional migrations, dedupe | server | T0.2 |
| T0.7 | Provider registration (hidden); bridge skeleton; build registry | bridge | T0.2 |
| T0.8 | Worker: `ensureWatch{root}`, boot id, `describe`, drift check, `diagnostics` | worker | T0.3, T0.4 |
| T0.9 | Server: 60 s keep-alive service, `diagnostics` RPC, health | server | T0.6, T0.8 |
| T0.10 | Settings section: Hermes root, health | app | T0.9 |
| T0.11 | `git ls-remote` as the bb service user; live install `@^0`; one update | lead | T0.1–T0.10 |
| T0.12 | Protocol check on isolated Hermes: slash catalog and exec, `compress`, `branch` (A31–A34) | client | T0.3 |
| T1.0 | Fixtures: gateway restart, attachments, second viewer, detach, `hermes chat -c` | e2e | T0.5 |
| T1.1 | Bridge turns: start/resume/stop, lazy create, identity, segmentation, fencing | bridge | T0.5, T0.7 |
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
| T1.10 | Server: titles (Hermes → bb; server-set titles recorded in `synced`) | server | T1.3 |
| T1.12 | Bridge: attachments | bridge | T1.0, T1.1 |
| T1.13 | Bridge: slash commands (`commands/list` → `bb/provider-commands`, exec) and `/compact` → `compress` | bridge | T0.12, T1.1 |
| T1.14a | Bridge: `thread/fork` → `branch`, tip or checkpoint | bridge | T0.12, T1.1 |
| T1.14b | Server: bind fork threads on `thread.created` | server | T1.3 |
| T1.11 | P1 e2e + dogfood (phone, two hosts) | e2e | T1.1–T1.14 |
| T2.0 | Fixtures: compaction clone, `/retry`, subagent, legacy row, Conduit mid-turn | e2e | T0.5 |
| T2.1 | Worker: watch (hint + WAL), `listSessions`, `readTurns` (uids), source → tag table | worker | T0.8, T2.0 |
| T2.2 | Server: import (deny-list, preview, serial queue, redo, backfill) | server | T2.1 |
| T2.3 | Bridge: bind/replay/mirror from the store; mirror modes; legacy without resume | bridge | T1.1, T2.0 |
| T2.4 | Server: wakes (`turns`, one transaction), D26 levels, read race | server | T2.1, T2.3 |
| T2.5a | Server: state sync both ways, reconnect diff | server | T2.1 |
| T2.5b | Worker: `mutate` | worker | T2.1 |
| T2.5c | App: offline thread banner | app | T0.9 |
| T2.6a | Server: import exclusions, window, notification level | server | T2.2 |
| T2.6b | App: those settings | app | T2.6a |
| T2.7a | Bridge: delegation item (droppable) | bridge | T2.3 |
| T2.7b | Server: subagent sub-thread binding (droppable) | server | T2.2 |
| T2.8a | Bridge: compression follow | bridge | T2.3 |
| T2.8b | Worker: tip tracking (`resolved_id`) | worker | T2.1 |
| T2.9 | P2 e2e, `e2e/eligibility`, dogfood | e2e | T2.1–T2.8 |
| T3.1 | Server: bot setup (lookup, import, pin, idempotent) | server | T2.2 |
| T3.2a | Server: rotation, bot exemptions, `handed_off` banner | server | T3.1 |
| T3.2b | Bridge: `rebind` | bridge | T2.3 |
| T3.3 | Conduit co-use check | e2e | T3.1, T2.4 |
| T4.1 | `bb_tools`: tools, allowlist, cron refusal, Discord approval, env, `schema_version`, pytest | hermes-plugin | T0.2 (parallel from P0) |
| T4.2a | Worker: `setBindings` (atomic, 0700/0600) | worker | T2.1 |
| T4.2b | Server: push binding rows | server | T4.2a |
| T4.3 | Install pinned + enable in 4 profiles + cron disable (user approval) | lead | T4.1, T4.2b |
| T5.1 | Server: Discord import, tag | server | T2.2 |
| T5.2a | Worker: route lookup (`gateway_routing`) | worker | T2.1 |
| T5.2b | Bridge: rolled-over notice | bridge | T5.2a |
| T5.3 | `bb_tools`: echo hook, fallback, agent label | hermes-plugin | T4.3 |
| T5.4 | Supervised live Discord try | e2e | T5.1–T5.3 |
| T6.1 | App: settings and health polish | app | P5 |
| T6.2 | Parity checklist; A7 on isolated bb | e2e | P5 |
| T6.3 | Disable `acp-hermes-agent` (user OK) | lead | T6.2 |
| T6.4 | Worker: cleanup script (backup, exclude ACP-bound ids, list → confirm → delete) | worker | T6.3 |
| T6.5a | Server: older-chats listing + on-demand import | server | T2.2 |
| T6.5b | App: "Older Hermes chats" in the rail | app | T6.5a |
| T6.6 | Docs: `guide.md`, `operations.md` (appended each phase), `PLUGIN_OVERVIEW.md` | lead | P5 |
| T6.7 | Optional stack trim: webui, hermes-host adapter (user OK) | lead | T6.3 |

- Critical path: T0.1 → T0.3 → T0.5 → T1.1 → T1.5b → T1.6b → T1.11 → T2.3 → T2.4 → T2.9 → T3.1 → T3.3 → … (R3 S4).
- T4.1 runs alongside from P0.

## Assumptions to verify

| ID | Assumption | Verify in |
|---|---|---|
| A1 | Store columns (`pinned`, `archived`, `last_read_at`, `cwd`, `source`, `created_source`, `parent_session_id`, `chat_id`, `session_key`, `message_uid`, `active`) mean what we read | T2.1, read-only on live |
| A2 | The one declared permission mode never auto-answers | T1.2 |
| A3 | The bridge can close a pending interaction | T1.2 |
| A4 | `turn_author` `bb:` persists on submits, steers and queued prompts; a repeated `submission_id` runs once | T1.1, T2.1 |
| A5 | Per-row origin is readable (Conduit distinguishable or folded into Desktop) | T2.1 |
| A6 | A delegation item can link to a sub-thread | T2.7a |
| A7 | Disabled-provider threads stay viewable | T6.2 |
| A8 | `message_uid` + `active=1` renders compaction clones and `/retry` once | T2.3 |
| A9 | Sends while $HERMES_HOST is offline wait or fail (sets the banner text) | P2 dogfood (Wi-Fi off) |
| A10 | Viewer submit posts to Discord; rollover detected via `gateway_routing` | T5.2a, T5.4 |
| A11 | The bot ignores its own echo; `reply_to` = admission id is fine | T5.4 |
| A12 | `bb` CLI works from the gateway with per-call `BB_*` + `HOME` | T4.1, P4 dogfood |
| A13 | Outside start → bb ≤ 3 s | T2.4 |
| A14 | Hermes auto-titles bb-created sessions | T1.10 |
| A15 | Conformance accepts a placeholder identity | T1.1 |
| A16 | Host RPC limits fit `readTurns` pages; prewarmed `model.options` ≤ 2 s | T1.5a, T2.1 |
| A17 | Realtime + overlay navigates only the window showing the old chat | T1.6c |
| A18 | `bb thread spawn --provider hermes` works on $HERMES_HOST and fails clearly elsewhere | T1.11 |
| A19 | A viewer gets live events of another client's turn | T1.0 |
| A20 | `source:"cli"` bb sessions aren't picked by `hermes chat -c` | T1.0 |
| A21 | bb marks agent-originated input | T5.3 |
| A22 | Bridges and worker share a `dataDir` | T0.8 |
| A23 | Resuming a gateway-owned row doesn't migrate it; legacy rows are only adopted on first send | T2.0 |
| A24 | `session.detach{end_reason:null}` doesn't end the row | T1.0 |
| A25 | bb's grouping of queued sends (what the segmentation must handle) | T2.4, isolated bb |
| A26 | `bb plugin update` swaps the worker like `reload` | T0.11 |
| A27 | Send-menu rows on bb's home composer can spawn with the message | T1.4 |
| A28 | A row-metadata item renders the SVG + profile | T1.4 |
| A29 | $HERMES_HOST's SSH key can `git ls-remote` the private repo | T4.3 |
| A30 | Plugin slots render on bb mobile | T1.11 |
| A31 | The canonical socket lists Hermes slash commands (a canonical catalog, not only the legacy `commands.catalog`) | T0.12 |
| A32 | How a slash command runs: `prompt.submit` text vs a dedicated method (e.g. `slash_exec`, `command_dispatch`; R2 S7); bb sends a picked command as `turn/start` text | T0.12 |
| A33 | bb's manual compaction maps to `session.mutate compress` | T0.12, T1.13 |
| A34 | `session.mutate branch` forks at the tip, and at a given message for checkpoint fork | T0.12, T1.14a |
| A35 | `bb_tools` can tell a $WORK_HOST project (project machine via `bb project … --json`) and the session's platform (Conduit, Desktop, CLI, one-shot) | T4.1 |

## Dev loop

- One jj workspace per seam (`jj workspace add ../bb-plugin-hermes-wt/<seam>`); the lead merges.
- Inner loop: `npm test -- --watch` on the strict fake; conformance on every bridge change.
- Isolated bb (03 §6): `sbb plugin dev <repo>`, then `sbb plugin rpc call hermes stopHosted`. Running bridges keep old code (S1-S3 fact 2).
- Isolated Hermes for approvals, cwd, legacy rows and `bb_tools`. Never symlink a dev checkout into live `~/.hermes`.
- Claude-family subagents run in the background; the `e2e` seam runs every gate.

## Release, install, update

1. `npm run check` green; gate passed.
2. Bump to `v0.x.y` (never retag); `jj commit -m "release: v0.x.y"`; `jj bookmark move main --to @-`.
3. With user OK: `jj git push --bookmark main`, then `gh release create v0.x.y --target <commit>`.
4. **Live bb.** It clones over https as the server's own user and gets no thread credentials (R3 M1), so P0 checks `git ls-remote https://github.com/AndrewBird81/bb-plugin-hermes` as that user first, after `gh auth setup-git` (D29).
   - Once: `bb plugin install git:github.com/AndrewBird81/bb-plugin-hermes@^0 --yes`. A range, never an exact tag: tags are pinned, and a second install is refused (R3 M2).
   - Each release: `bb plugin update hermes`, which snapshots `data.db` and restores it if activation fails. Then `bb plugin rpc call hermes stopHosted`; check `diagnostics`.
5. **`bb_tools`, per profile** (default, alex, david, neo; R3 M5):
   - `hermes -p <p> plugins install git@github.com:AndrewBird81/bb-plugin-hermes.git#hermes-plugin/bb_tools --ref <release sha> --no-enable`
   - `hermes -p <p> plugins enable bb_tools`: sends `reload-plugins`; no restart; tools appear in new sessions (11 §5).
   - `hermes -p <p> tools disable bb --platform cron` (D18).
   - Update: the same install with `--force --ref <new sha>`. Never branch-following `plugins update`; `bindings.json` `schema_version` catches skew.
- **bb upgrade runbook** (R3 S7): before upgrading live bb, run e2e + conformance on `npx bb-app@<new>`, then `bb plugin types --check`. Health shows bb and SDK versions.

## Rollout

- P0: live install; ACP stays enabled as the fallback until P6.
- P2: `VACUUM INTO` a `data.db` copy → `importPreview` → user confirms → import.
- P3: bot setup once.
- P4: the user approves the 4-profile install, enable and cron disable.
- P5: the user approves the live Discord try.
- P6: parity week → the user confirms the ACP disable, then the cleanup.

## Rollback

- **No downgrade in place:** roll forward with a revert and a new patch tag, then `bb plugin update` (R3 M2).
- **Kill switch:** `bb plugin disable hermes`.
- **Never `remove`/`uninstall`** without a `VACUUM INTO` copy of `data.db`. Removal deletes the bindings, and a re-import would orphan threads (409, S1-S3 fact 4).
- **Import:** RPC `listImported` → user confirms → delete those threads and their bindings. Hermes is untouched.
- **Hermes plugin:** `hermes -p <p> plugins disable bb_tools`.
- **ACP:** `bb provider enable acp-hermes-agent`.

## Data cleanup (user-confirmed only, after T6.3; R3 S10)

1. Back up each affected DB: `sqlite3 "<home>/state.db" ".backup /private/tmp/hermes-backup-<date>.db"`.
2. List the empty ACP probe sessions (`source=acp`, `message_count=0`; 137 on 2026-11-04 and growing until ACP is disabled), plus `local-a6fec510…`. Exclude any id bound to the 18 ACP threads.
3. The user confirms → `session.mutate delete` with `expected_generation` (S0-S4 §S4g).
4. Spike and test dirs: `~/.bb-spike`, `~/.bb-spike-logs`, `/tmp/spikeprep-bb`, `/tmp/spikeprep-ea`, `~/.bb-hermes-e2e`, `/private/tmp/hermes-spike`.

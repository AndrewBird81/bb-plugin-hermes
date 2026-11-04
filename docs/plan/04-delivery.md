# 04 — Delivery

## Repo layout

```
bb-plugin-hermes/
  package.json            bb manifest (server, app, host); engines bb >=0.48.1, bbPluginSdk 0.6.104
  server.ts  host.ts  app.tsx   entries only; logic in src/
  src/shared/             marker.ts, host-contract.ts, rpc-contract.ts   (lead)
  src/hermes/             canonical client, from spike-hermes/src/hermes  (client)
  src/bridge/             provider bridge: turns, mapper, interactions     (bridge)
  src/server/             mapping db, import, mirror, state sync, bots, settings (server)
  src/worker/             host worker: watch, list, read, mutate, bindings (worker)
  src/app/                New Hermes chat, nav panel, settings section     (app)
  hermes-plugin/bb_tools/ plugin.yaml, __init__.py, tests/                 (hermes-plugin)
  test/fake-hermes/       fake canonical server                            (client)
  test/fixtures/          recorded frames, redacted                        (e2e)
  e2e/                    isolated-bb scripts, sbb wrapper                 (e2e)
  contract/               used-surface.json, check script                  (client)
  docs/
```

## Phases

Each phase is usable on its own and ends with its gate (03 §Phase gates).

Order change from the brief: bb tools (P4) come before Discord (P5). Both need the same `bb_tools` install and `plugins.enabled` change in default, alex, david and neo (11 §4–5). Tools first means one config approval; P5 then only adds a hook. Settings ship with the phase that reads them (01 F12).

| Phase | Usable result | Exit criteria | Verify |
|---|---|---|---|
| P0 Foundations | Settings shows live Hermes connection health | Provider hidden; worker connects via `gateway.sock`; mapping db migrates; drift check runs daily | `npm run check`; e2e `p0.sh`; dogfood P0 |
| P1 New chats from bb | Chat with any profile from bb, approvals included; ACP still available | F1–F3, F8, F12 (profile and model rows); redeploy procedure works | conformance + `e2e p1.sh`; dogfood P1 |
| P2 Sync, import, mirror | All recent interactive Hermes chats in bb, live, two-way state | F5 (no Discord), F6, F9, F10, F12 (import and notification rows) | `e2e p2.sh`; preview == SQL count; dogfood P2 |
| P3 Bots | 4 pinned bot threads shared with Conduit and Desktop | F4 | `e2e p3.sh`; dogfood P3 |
| P4 bb tools in Hermes | Hermes can spawn, tell, list, read and wait bb threads | F11; plugin installed and enabled in 4 profiles (user-approved) | pytest + isolated Hermes; dogfood P4 |
| P5 Discord | Discord conversations in bb; replies post with echo | F5 Discord source, F7 | supervised live try; dogfood P5 |
| P6 Polish + ACP retirement | One Hermes integration | F12 complete, F13; cleanup done | parity week; dogfood P6 |

## Work breakdown

Seams: `lead` (contracts, merges, live steps with the user), `client`, `bridge`, `server`, `worker`, `app`, `hermes-plugin`, `e2e` (verifier, never the writer of the code it gates).

| ID | Task | Seam | Depends | Notes |
|---|---|---|---|---|
| T0.1 | Scaffold: manifest, tsconfig, vitest, `npm run check`, SDK pinned 0.6.104 | lead | — | Resolve the `dependencies` vs devDependencies warning (S1-S3 gotchas) |
| T0.2 | Contracts: markers, host contract, RPC contract | lead | T0.1 | Unblocks all seams |
| T0.3 | Port canonical client; `gateway.sock.path` fallback; reconnect helper | client | T0.1 | from `spike-hermes/src/hermes/` |
| T0.4 | Fake canonical Hermes v1 | client | T0.3 | 03 §5 |
| T0.5 | Mapping db, migrations, dedupe functions | server | T0.2 | additive migrations only |
| T0.6 | Provider registration (hidden, SVG icon); bridge skeleton | bridge | T0.2 | |
| T0.7 | Host worker: connect, `ensureWatch`, `describe`; server 60 s keep-alive service | worker | T0.3 | keep-alive mandatory (S7 §6) |
| T0.8 | Settings health section | app | T0.7 | |
| T0.9 | Contract drift check + daily automation | client | T0.3 | 03 §9 |
| T1.1 | Bridge turns: start/resume/stop, submit/steer, mapper, lazy create, identity after boundary | bridge | T0.4, T0.6 | A4 (submit dedupe), A15 |
| T1.2 | Approvals, clarify, deadlines, settled-elsewhere | bridge | T1.1 | A2, A3 |
| T1.3 | `newChat`, `stopHosted`, notification level at bind | server | T0.5, T0.7 | |
| T1.4 | Entry points: rail panel (with project select), home row, ⇧⌘H via `experimental_appOverlay`; `useBbNavigate` | app | T1.3 | S7 §3; A18 |
| T1.5a | Worker `models` (`model.options`), cache, `custom:mlx-main` normalisation | worker | T0.7 | A16 (cold 15.5 s) |
| T1.5b | Bridge: profile chip (all profiles), `bb/provider-model-catalog`, model validation → default | bridge | T1.5a | `models.scope:"workspace"` (S7 §1c); Q9 |
| T1.6 | Profile pick: empty-chat init (server), handoff detection + chip revert + realtime navigate (server, app), `export` (worker), handoff prompt + late-pick refusal (bridge) | server → worker → bridge → app | T1.1, T1.5b | S7 §1d; A17; one writer per sub-task |
| T1.7 | Project chats: `project-checkout` environment, `cwd` | server | T1.3 | S7 §5 |
| T1.8 | Reconnect and restart handling | bridge | T1.1 | gateway-restart fixture |
| T1.9 | Settings: default profile, hidden profiles, hidden models (seeded from `bb-models.json`) | server + app | T1.5a | |
| T1.10 | Titles: Hermes title → bb; fallback first message cut to 60 characters (`experimental_regenerateTitle` fails on init-first chats, S7 finding 4) | server | T1.3 | A14 |
| T1.11 | P1 e2e + fixtures | e2e | T1.1–T1.10 | gate P1 |
| T2.1 | Worker watch (`sessions.changed` + WAL stat), `listSessions`, `readTurns`, `changed` signal | worker | T0.7 | A1, A4, A5; SQLite read-only fallback |
| T2.2 | Import engine: filter, `importPreview`, serial queue, hidden replay, release | server | T2.1, T0.5 | |
| T2.3 | Bridge bind/replay/mirror turns, live attach | bridge | T1.1 | A8 |
| T2.4 | Mirror wakes with source tags | server | T2.1, T2.3 | S7 §8; A13 |
| T2.5 | State sync both ways, outbox, `mutate` | server + worker | T2.1 | A9; Q1, Q2 |
| T2.6 | Notifications; settings for import sources, window, level | server + app | T2.2 | |
| T2.7 | Subagent nesting (droppable) | bridge + server | T2.3 | A6 |
| T2.8 | Compression follow | bridge + worker | T2.3 | compression fixture |
| T2.9 | P2 e2e + fixtures | e2e | T2.1–T2.8 | gate P2 |
| T3.1 | Bot setup: `Bot Chat` lookup, import, pin, idempotent | server | T2.2 | |
| T3.2 | Rotation/rebind; rename/archive exemption | server + bridge | T3.1 | Q2 |
| T3.3 | Conduit co-use check (finished-turn mirror) | e2e | T3.1, T2.4 | Conduit fixture |
| T4.1 | `bb_tools` plugin: 5 tools, minimal env, timeouts, pytest | hermes-plugin | T0.2 | parallel seam; may start in P1 |
| T4.2 | Worker `setBindings` → `bindings.json` | worker + server | T2.1 | A12 |
| T4.3 | Discord-origin approval hook (if Q5 = yes) | hermes-plugin | T4.1 | |
| T4.4 | Install and enable in 4 profiles (user approval) | lead | T4.1–T4.3 | `reload-plugins` reloads Conduit (11 §5): do it while Conduit is idle |
| T5.1 | Discord import source + `[Discord]` tag | server | T2.2 | |
| T5.2 | Detached detection + notice | worker + bridge | T2.3 | A10; Q3 |
| T5.3 | Echo hook + `echo.json` fallback | hermes-plugin | T4.4 | A11 |
| T5.4 | Supervised live Discord try | e2e + lead | T5.1–T5.3 | user approval |
| T6.1 | Settings polish, health detail | app | P5 | |
| T6.2 | Parity checklist; A7 on isolated bb | e2e | P5 | |
| T6.3 | Disable `acp-hermes-agent` | lead | T6.2 | user OK |
| T6.4 | Probe cleanup script (list → confirm → `session.mutate delete` with `expected_generation`) | worker | T2.5 | user OK |
| T6.5 | Retire hermes-host wrapper (Q8); tear down spike dirs | lead | T6.3 | user OK |

- Parallelism: after T0.2, the `client`, `bridge`, `server`, `worker`, `app` and `hermes-plugin` seams run in parallel.
- Critical path: T0.3 → T1.1 → T2.3 → T2.4 → T3.1.

## Assumptions to verify

| ID | Assumption | Verify in | How |
|---|---|---|---|
| A1 | Canonical `session.list`/`session.info` give pinned, archived, `last_read_at`, cwd, `created_source`, parent, logical id, `session_key`; else read-only SQLite (`mode=ro`, check `schema_version` 32) | T2.1 | compare both on live, read-only |
| A2 | No bb permission mode auto-answers our approvals | T1.2 | isolated bb, each declared mode |
| A3 | The bridge can close a pending bb interaction | T1.2 | settle on a second socket |
| A4 | bb rows are recognisable (`turn_author.id` `bb:` in the transcript), and a repeated `submission_id` runs once | T1.1, T2.1 | isolated Hermes |
| A5 | Per-row origin (CLI, Desktop, Conduit, Discord) is readable for tags | T2.1 | read-only live rows |
| A6 | A delegation item can link to a sub-thread | T2.7 | isolated bb |
| A7 | Disabled-provider threads stay viewable | T6.2 | isolated bb |
| A8 | Resume by logical id yields root → tip messages for replay | T2.3 | compression fixture |
| A9 | bb's behaviour when the $HERMES_HOST host is offline (send fails or queues) | T2.5 | stop the isolated daemon |
| A10 | A viewer submit on a live Discord route posts to Discord; detached detection via `gateway_routing` | T5.2 | supervised live try |
| A11 | The bot ignores its own echo; `reply_to` = admission id is accepted or dropped (11 §4) | T5.3 | supervised live try |
| A12 | `bb` CLI from the Hermes gateway works with per-call `BB_*` from the worker's values | T4.2 | live neo session |
| A13 | Outside start → bb ≤ 3 s | T2.4 | timestamps on live |
| A14 | Hermes auto-titles bb-created sessions | T1.10 | isolated Hermes |
| A15 | The conformance kit accepts a placeholder identity, then a re-announce after the boundary | T1.1 | conformance run |
| A16 | Host RPC limits fit `readTurns` pages and a cold `model.options` | T1.5a, T2.1 | live timing |
| A17 | A server realtime event + `experimental_appOverlay` can navigate only the window showing the old chat | T1.6 | isolated bb, two clients |
| A18 | `bb thread spawn --provider hermes [--option profile=<p>]` works without our form (default host and environment) | T1.4 | isolated bb |

## Dev loop

- Each seam works in its own jj workspace (`jj workspace add ../bb-plugin-hermes-wt/<seam>`). One writer per seam. The lead merges.
- Inner loop: `npm test -- --watch` against fake Hermes; conformance on every bridge change.
- Isolated bb (03 §6):
  - `sbb plugin dev <repo>` rebuilds;
  - then `sbb plugin rpc call hermes stopHosted`, because running bridges keep old code (S1-S3 fact 2).
- Isolated Hermes for approvals, cwd and `bb_tools`. Never symlink a dev checkout into live `~/.hermes`.
- Claude-family subagents run in the background; each phase gate is run by the `e2e` seam.

## Release and install

1. `npm run check` green; gate passed.
2. Bump `package.json` `version`; `jj commit -m "release: vX.Y.Z"`; `jj bookmark move main --to @-`.
3. With user OK: `jj git push --bookmark main`, then `gh release create vX.Y.Z --target <commit>` (creates the tag). Repo `github.com/AndrewBird81/bb-plugin-hermes`: ASSUMED; confirm at T0.1.
4. Live bb, which installs from git tags (01 §7):
   - `bb plugin install git:github.com/AndrewBird81/bb-plugin-hermes@vX.Y.Z --yes`; later releases reinstall at the new tag;
   - then `bb plugin rpc call hermes stopHosted` and check the build id. Server, app and worker switch at once (S7 §7).
5. Hermes plugin:
   - per profile `hermes -p <profile> plugins install <repo url>#hermes-plugin/bb_tools`, then `hermes -p <profile> plugins enable bb_tools` for default, alex, david and neo;
   - `enable` sends `reload-plugins`: no restart, but new tools appear only in new sessions (11 §5);
   - updates: `hermes plugins update` or reinstall with `--force`;
   - symlinks only on isolated Hermes.

## Rollout

- P1: install on live. ACP stays enabled as the fallback until P6.
- P2: run `importPreview` → the user confirms the counts → import. Watch the 18-slot host limit (07 §4).
- P3: run bot setup once.
- P4: the user approves the `plugins.enabled` change (and, if Q5 is yes, the approval hook).
- P5: the user approves the live Discord try (throwaway thread or test bot).
- P6: one parity week, then the user confirms the ACP disable and the cleanup.

## Rollback

- Plugin: reinstall the previous tag, then `stopHosted`. Migrations are additive, so an older build still reads the db.
- Import: RPC `listImported` → user confirms → `threads.delete` per thread and clear its bindings. Hermes is untouched; no tombstones, so re-import is possible.
- Hermes plugin: `hermes -p <profile> plugins disable bb_tools` (reload, no restart).
- ACP: `bb provider enable acp-hermes-agent`.
- Uninstall: `bb plugin uninstall hermes`. Hermes sessions are untouched; bb threads remain (render like A7).

## Data cleanup (only with user confirmation)

- 137 empty ACP probe sessions (root `state.db`, `source=acp`, `message_count=0`; 04 §5) plus spike leftover `local-a6fec510…` (S0-S4 cleanup):
  1. list the ids;
  2. the user confirms;
  3. `session.mutate delete` with `expected_generation` (S0-S4 §S4g).
- Spike and test dirs: `~/.bb-spike`, `~/.bb-spike-logs`, `/tmp/spikeprep-bb`, `/tmp/spikeprep-ea`, `~/.bb-hermes-e2e`, `/private/tmp/hermes-spike`.

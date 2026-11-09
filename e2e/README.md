# e2e

Isolated runs only: Hermes homes under `/private/tmp/bb-hermes-test/`, the isolated bb in `~/.bb-hermes-e2e` on ports 48886/48887.

| File | What |
|---|---|
| `sbb` | bb CLI against the isolated bb (`BB_*` unset, the bb bundled in bb-app@0.49.0) |
| `bb-e2e.sh` | `preflight`, `install <repo>` (server only, folder → test root), `start`, `fake <folder>`, `hermes <folder>`, `connect <folder>`, `check`, `dev <repo>`, `stop` |
| `isolated-hermes.ts` | isolated Hermes: stub model, gateway, dashboard (Conduit's client), canonical client; standalone for `bb-e2e.sh hermes` |
| `record-frames.ts` | T1.0 recordings → `test/fixtures/frames/` |
| `two-client.test.ts` | T1.13: `npx vitest run --config e2e/vitest.config.ts` |
| `fake-ctl.sh` | a knob on the running strict fake (`test/fake-hermes/run.ts` ops: `nextTurn`, `outsideTurn`, `conduitTurn`, `legacySession`, `hold`, `session`, …) |
| `fake-sessions.ts`, `fake-messages.ts` | the fake's chats and stored rows |
| `conduit-send.ts` | a Conduit-style (dashboard) send on the isolated Hermes |
| `tlog.mjs` | a thread's bb event log, one line per event |
| `screenshots/` | T1.14 UI evidence. Taken in UTC: `bb-e2e.sh` runs bb-app (and so the bridges, which print card deadlines) with `TZ=UTC`, and the browser is a headless Chrome for Testing started with `TZ=UTC` and `--remote-debugging-port`, driven through agent-browser `--cdp` (`Intl.DateTimeFormat().resolvedOptions().timeZone` must say `UTC`) |

T1.14 on the fake, in order: `stop`; `install <repo>`; `fake /private/tmp/bb-hermes-test/e2e-fake`; `start`; `connect /private/tmp/bb-hermes-test/e2e-fake`; `check` (abort unless the instance id is the fake's); then `sbb plugin rpc call hermes setBot|newChat|bots|diagnostics`, `sbb thread tell|stop|spawn|log|interactions`, `sbb push-notifications thread`, and `fake-ctl.sh` for outside, Conduit and scripted turns. Before running a bot's `bb-hermes` wrapper, check it sets `BB_SERVER_URL=http://127.0.0.1:48886`.

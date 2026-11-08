# 03 — Testing

Rules for every layer:
- Never auto-approve. Destructive test commands target quoted paths under `/private/tmp/bb-hermes-test/` (S0-S4 §S4c incident).
- Live Hermes is read-only: `sqlite3 -readonly`, logs, source. Never `connect_gateway()` without an endpoint. Experiments only on an isolated `HERMES_HOME` under `/tmp`. Never read or print `.env` values.
- Every gate runs `bb plugin rpc call hermes diagnostics`.

## Layers

| # | Layer | Covers | Tool | Phase |
|---|---|---|---|---|
| 1 | Unit | client; history reader on recorded REST responses; marker codec and segmentation; source filter; dedupe and wakes; switch on/off; skill rendering; model validation; migrations; dispatch hook | vitest, `@get-bb/plugin-sdk/testing` | P0+ |
| 2 | Bridge conformance | protocol compliance | `experimental_runBridgeConformance` (r07 §6) | P1+ |
| 3 | Own bridge tests | what the kit doesn't cover | `experimental_createDeltaAssembler` | P1+ |
| 4 | Recorded fixtures | real Hermes shapes | client `onFrame` tap + REST responses → `test/fixtures/` | T0.5, T1.0 |
| 5 | Strict fake Hermes | layers 1–3 and e2e | `test/fake-hermes/` | P0+ |
| 6 | Two-client harness | S8's rules | isolated Hermes + legacy dashboard client + canonical client + stub model | P1 |
| 7 | E2E, isolated bb | real bb runtime and UI | `npx bb-app` + `sbb` + agent-browser | P1+ |
| 8 | Live dogfood | the owner's setup | checklist below | each phase |

## Unit and bridge tests that guard known traps

- 3 re-lists during one outside turn → 1 wake. A failed send deletes the `turns` row; orphaned `queued` rows recover on boot (R1 M1).
- Compaction clone → 0 re-rendered turns (R1 M2); `/retry` → exactly 1 new turn, the retried message and its new reply, as Hermes' own view shows (T0.5; owner default, replaces R4 S1); bb's own `/retry` mirrors 0 times.
- bb's own turn never mirrors, even when the `submission_id` read fails (`persisted_turn` record, R4 M3c).
- A session created by a side chat, re-listed before its first boundary → no mirror thread (`expected_id`).
- Source filter: `source=local, created_source=cron` → out; unknown label → out; hidden non-Bot-Chat session → out; a session titled `Bot Chat` → the bot thread only.
- Switch off → on: 0 new threads; only `archived_by_switch` threads unarchive; the skill dir is deleted only when our marker is present.
- Legacy binding: 0 `session.resume` and 0 `session.mutate` before the first bb send (A23). Merged input `[text, mirror, text]` → 2 submits + 1 render, in order (R1 M6). Marker segments → 0 `prompt.submit`.
- Fencing: an outside turn running and ours queued → Stop sends `prompt.cancel` for ours, never `session.interrupt`; steer → a queued submit (R1 M4).
- Mirror modes: complete → render; canonical running → attach, streamed == final text (R1 S2); no admission → user row, `partial`, then `rest`; a foreign admission on our subscription → rendered live.
- Bot thread: `runtime_coordination_required` → retry schedule, 0 `session.create` beyond the first, banner shown; `not_found` → resolve by title again.
- `/new` → `session.mutate compress` with `expected_generation`; 0 new sessions.
- Reconnect: bb's own `unknown` admission → 1 `prompt.resolve_unknown`, turn failed; 0 duplicates, 0 gaps after `events.since` (S0-S4 §S4e).
- Approvals: choices never widened; settled elsewhere and timeouts close; `already_resolved` silent; an outside approval while ours waits is raised (R1 S1).
- Dispatch hook: a send starting with `[CLI] ` and no marker is refused; our wake passes (D15). Not on the Hermes machine → `provider.error` naming `--machine`; a switched-off bot → the switched-off error.
- Migrations: a db from each earlier release upgrades in one transaction (R3 S3).

Conformance scenarios: `handshake/initialize`, `session/start-identity`, `session/resume-identity`, `session/resume-id-uniqueness`, `turn/lifecycle`, `turn/settles-without-activity`, `stop/interrupt-settles-before-result`, `stop/release-not-interrupted`, `events/schema-valid`, `item/opens-before-delta`. Placeholder identity: A15.

## Recorded fixtures (isolated unless noted; redact tokens, `origin_json`, user ids)

| Fixture | Task |
|---|---|
| Existing: `spike/hermes` `src/hermes/fixtures/*.json` (create/stream, clarify, steer/interrupt, replay, viewer, mutate, approval) | — |
| REST list and messages per profile: create, compaction (cloned tail), `/retry`, steer, a hidden-prompt turn, a legacy row, a Conduit-held row (A1, A4, A8, A36, A48) | T0.5 |
| Gateway restart mid-turn with an `unknown` admission | T1.0 |
| Attachments on `prompt.submit` (A50) | T1.0 |
| A CLI turn seen by a second canonical viewer (A19) | T1.0 |
| Detach with `end_reason:null` (A24); `source:"cli"` vs `hermes chat -c` (A20); `/new` as `prompt.submit` text (A46) | T1.0 |
| Conduit: dashboard turn, forwarded admission, `runtime_coordination_required` (S8 E3, E6) | T1.0 |
| Live, read-only: REST list keys only, no message text | T0.5 |

## Strict fake Hermes (`test/fake-hermes/`)

- Grows from `spike/hermes` `src/hermes/test/fake-gateway.ts` and `spike/bb` `src/fake-hermes.ts`.
- Validates every request against a vendored `gateway-contract.openrpc.json`: `x-canonical-methods` plus the legacy `methods` we call (`model.options`), with `additionalProperties:false` as live (R3 S5, R5 C6).
- Serves: `gateway.sock` + `/api/ws` for several profiles; the recorded REST responses with `native-http` tickets; scripted turns, approvals and `clarify` with deadlines; `sessions.changed` and WAL touches; fences (`stale_generation`, `revision_conflict`, `already_resolved`), `not_found`, `runtime_coordination_required`; restart (new port and epoch); legacy turns with no events.
- REST shapes are always recorded, never hand-built (R5 C6): recorded answers are served as recorded; rows for sessions the fake's engine makes are built from a recorded row of the same kind, with its exact key set (asserted).
- Selected only through the machine and folder settings; no fallback to `~/.hermes`.

## Two-client harness (S8 §Plan changes)

- Isolated Hermes as in S8: `HERMES_HOME=/private/tmp/hermes-<task>`, its own `HERMES_GATEWAY_LOCK_DIR`, a dashboard on a free port, an ephemeral gateway port, a stub model on `127.0.0.1` that echoes what it was sent.
- Conduit = a legacy dashboard WebSocket client; bb = our canonical client.
- Scenarios: S8 E1–E3, E6–E8, E10, E11b, E14. Assertions: transcript order, model context, no second Bot Chat, Conduit still sends after every bb action.
- Never `pip install` into `<folder>/hermes-agent/venv` (R6 C3). Remove processes and the home afterwards; check that live locks and pids are unchanged.

## E2E on an isolated bb

1. Fresh shell: `unset` every `BB_*`; `PATH` without `hermes` (S1-S3 Safety). Not enough on its own: the host daemon re-derives the user's `PATH`, and on 2026-11-08 provider-acp's first model probe of `acp-hermes-agent` created an empty `acp` session in live Hermes within 5 s of the first start.
2. **Server only, first:** bb-app's server script alone (no host daemon) with `--data-dir ~/.bb-hermes-e2e --server-port 48886`, then `sbb plugin disable provider-acp keep-awake connect` (one per call) before any host daemon connects; stop it. Use `sbb` (`BB_*` unset, `BB_SERVER_URL=http://127.0.0.1:48886`).
3. `BB_SKIP_ONBOARDING=1 npx bb-app@<live version> --data-dir ~/.bb-hermes-e2e --server-port 48886 --host-daemon-port 48887 --no-in-app-updates` (R3 S9). Check `sbb plugin list` shows the three disabled.
4. `sbb plugin install <repo> --yes`; `sbb plugin dev <repo>`. Scripts pin the `bb` bundled in `bb-app@0.49.0` (S1-S3 gotchas; `scripts/bb.mjs` drops `BB_*`, since `BB_CLI` re-execs to the machine's `bb`).
5. Set the machine to the local daemon and the folder to the fake (or isolated Hermes).
6. **Before any check:** `diagnostics.instance_id` must equal the fake's; else abort (R3 M3).
7. Assert with `sbb thread log|history|options`, `sbb plugin rpc call hermes …`, `sbb push-notifications thread`; check the UI with agent-browser screenshots against the DOM.
8. Teardown: `kill -INT <bb-app pid>`; `rm -rf ~/.bb-hermes-e2e`.
- Dogfood-only: a remote bb server, host RPC limits (A16), worker lifetime, two-machine spawns (A18), the phone (A30), the real Conduit app (A-S8a–c).

## Live dogfood checklist (owner present)

- [P0] Live install from `@^0`; one `bb plugin update`; health shows version and "supported"; 0 Hermes sessions created; every switch off.
- [P1] One bot on (example: Neo):
  - skill + marker present; the Bot Chat's next turn lists it (A43); "list my bb threads" works from the bot thread and from Conduit (A44);
  - bot thread shows the Bot Chat's last 30 days; a bb message, then a Conduit message, in one conversation; the phone (D19);
  - a side chat: reasoning High, an image, voice dictation, an approval, a `clarify`, Stop, steer, in a throwaway folder; a command Hermes' smart approvals escalate (R5 C6);
  - a CLI turn in the Bot Chat streams; a Conduit turn arrives in two steps; Stop on each behaves per 01 §5;
  - `/new` in the bot thread compacts; in a profile with `compression.in_place: false` (the owner's `default`, r12 §5), the thread follows the tip;
  - off: threads archived, skill gone; on again: threads back, missed turns shown;
  - redeploy (`update`, `stopHosted`, new build in `diagnostics`).
- [P2] Every enabled bot:
  - the switch-row count == imported threads == `e2e/eligibility`; 0 unread, 0 pushes, 0 Hermes revisions changed;
  - a new CLI chat becomes a thread; a reply from bb continues it in the CLI's session; a Conduit chat replies in place after adoption;
  - outage: the Hermes machine off the network for 5 min → banner; a CLI turn meanwhile mirrors after reconnect (R3 S13).

## Phase gates

Each gate: `npm run check` (test, typecheck, `bb plugin types --check`, build) green; `diagnostics` clean (no duplicate bindings, no errors, version supported); its assumptions verified (04).

| Phase | Gate |
|---|---|
| P0 | Unit + client tests on the strict fake; T0.5 reader pick recorded; live install and one update (A26); health correct; no Hermes writes |
| P1 | Conformance + own bridge tests; two-client harness green; e2e for switches, bot thread, side chats, approvals, `clarify`, Stop/steer fencing, mirror modes on bound threads; dogfood P1 incl. phone and Conduit (D19) |
| P2 | e2e for import, discovery, title follow, D48 catch-up, dispatch hook; `e2e/eligibility` matches; dogfood P2 |

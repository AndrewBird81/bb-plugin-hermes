# 03 — Testing

Rules for every layer:
- Never auto-approve.
- Destructive test commands target quoted paths under `/private/tmp/bb-hermes-test/`.
- No live Discord without user approval.
- Live Hermes: read-only unless the gate says otherwise.
- Every gate runs `bb plugin rpc call hermes diagnostics` (R3 S1).

## Layers

| # | Layer | Covers | Tool | Phase |
|---|---|---|---|---|
| 1 | Unit | client; store reader; marker codec and input segmentation; deny-list; dedupe; wakes; titles and echo suppression; reconnect diff; model validation; migrations | vitest, `@get-bb/plugin-sdk/testing` | P0+ |
| 2 | Bridge conformance | protocol compliance | `experimental_runBridgeConformance` (07 §6) | P1+ |
| 3 | Own bridge tests | turns the kit doesn't cover | `experimental_createDeltaAssembler` | P1+ |
| 4 | Recorded fixtures | real Hermes shapes | client `onFrame` tap + store snapshots → `test/fixtures/` | T1.0, T2.0, P3, P5 |
| 5 | Fake canonical Hermes | all of the above, plus e2e | `test/fake-hermes/` | P0+ |
| 6 | E2E, isolated bb | real bb runtime and UI | `npx bb-app` + `sbb` + agent-browser | P1+ |
| 7 | Isolated Hermes | approvals, cwd, legacy adoption, detach, `bb_tools` load | 08 §5 recipe | P1, P2, P4 |
| 8 | Hermes plugin | tools, echo, env, bindings | pytest in `hermes-plugin/.venv` with stubs | P4, P5 |
| 9 | Contract drift | Hermes version changes | worker check + `npm run contract:check` | P0+ |
| 10 | Live dogfood | the user's setup | checklist below | each phase |

## 1. Unit tests that guard review findings

- 3 re-lists during one outside turn → 1 wake (R1 M1).
- Compaction clone and `/retry` rewrite → 0 re-rendered turns (`message_uid`, R1 M2).
- `thread.created` for our own spawn → no extra binding (R1 M3).
- Profile pick on a one-turn import → handoff, not init (R1 M9).
- Bot titles never sync in either direction (R1 S5). Server-set titles never reach Hermes (R2 S2).
- Reconnect diff: bb-only change pushed; Hermes-only change pulled; both changed → Hermes wins (R1 S14).
- Migrations: a db built by each earlier release's migrations upgrades cleanly, inside one transaction (R3 S3).
- Deny-list: the same constants drive the import, `importPreview` and `e2e/eligibility` (R3 S6).
- Server killed mid-import → the hidden thread and its binding are removed and the session re-imported (R3 S2).

## 2–3. Bridge tests

- Conformance scenarios:
  - `handshake/initialize`, `session/start-identity`, `session/resume-identity`, `session/resume-id-uniqueness`;
  - `turn/lifecycle`, `turn/settles-without-activity`, `stop/interrupt-settles-before-result`, `stop/release-not-interrupted`;
  - `events/schema-valid`, `item/opens-before-delta`.
  - Placeholder identity: A15.
- Own tests (the fake counts every RPC):
  - marker segments → 0 `prompt.submit`. Merged input `[text, mirror, text]` → 2 submits + 1 render, in order (R1 M6).
  - identity only after the first boundary; `init` refused unless `pending:`.
  - **Fencing** (R1 M4): with an outside turn running and ours queued:
    - Stop → `prompt.cancel` of ours, never `session.interrupt`;
    - steer → a queued submit.
  - **Mirror modes** (R1 M5, S2, S3):
    - complete → render from the store;
    - canonical running → attach, streamed == final text;
    - no events → poll and close on the final row, or `partial` after 10 min;
    - back-to-back turns → 2 turns.
  - An outside approval while our turn waits → raised (R1 S1).
  - Approval choices never widened; settled elsewhere and timeouts close; `already_resolved` is silent.
  - Reconnect mid-turn: 0 duplicates, 0 gaps (S0-S4 §S4e). `truncated`/`snapshot_required` → resume path.
  - Lazy create: an empty chat → 0 `session.create`.
  - Legacy thread: no `session.resume` before the first send.
  - Model: unoffered → default + warning. A `model.options` timeout → last-known list.
  - Reasoning pick → `session.create{reasoning}` / `session.mutate reasoning`.
  - Attachment → `prompt.submit.attachments`; a text-only model → warning.
  - Handoff first prompt = handoff block + message; no `api_text`.
  - `turn_author.id` starts with `bb:` on submits and steers (A4).
  - No `gateway.sock` → `provider.error` naming `--machine $HERMES_HOST`.
  - `commands/list` → `bb/provider-commands`; a command turn → the A32 method; `/compact` → `compress`; `thread/fork` → `branch` and a new identity.

## 4. Recorded fixtures

- Existing: `spike-hermes/src/hermes/fixtures/*.json` (create/stream, clarify, steer/interrupt, replay, viewer, mutate, approval).
- To record. Tasks T1.0/T2.0 run before the code that uses them (R3 S4). Isolated unless noted.

| Fixture | Task | Where |
|---|---|---|
| Slash catalog, slash exec, `compress`, `branch` (tip and at a message) (A31–A34) | T0.12 | isolated |
| Gateway restart mid-turn | T1.0 | isolated |
| Attachments on `prompt.submit` (image, file) | T1.0 | isolated |
| Desktop turn seen by a second viewer (A19) | T1.0 | isolated: two canonical clients |
| Detach with `end_reason:null` (A24) | T1.0 | isolated |
| `source:"cli"` vs `hermes chat -c` (A20) | T1.0 | isolated |
| Compaction with a cloned tail; `/retry` rewrite (A8) | T2.0 | isolated |
| Subagent turn | T2.0 | isolated |
| Legacy (pre-migration) row: store read, then adoption on first send (A23) | T2.0 | isolated, copied DB |
| Conduit Bot Chat turn, wake mid-turn | T2.0 | live, read-only store snapshot |
| Discord turn + echo | T5.3 | test bot, or a live throwaway thread with approval |

- Redact before commit: tokens, `origin_json`, user ids.

## 5. Fake canonical Hermes (`test/fake-hermes/`)

- Grows from `spike-hermes/src/hermes/test/fake-gateway.ts` and `spike-bb/src/fake-hermes.ts`.
- **Strict:** validates every request against a vendored copy of `gateway-contract.openrpc.json` (`additionalProperties:false`, like live; R3 S5). The drift check diffs the copy against the live checkout.
- Serves:
  - `gateway.sock` + `/api/ws` for several profiles;
  - a fake `state.db` per profile, using the real schema columns the store reader reads;
  - scripted turns, approvals and clarify with deadlines;
  - `sessions.changed` and WAL touches;
  - fences (`stale_generation`, `revision_conflict`, `already_resolved`) and the duplicate-title refusal;
  - restart (new port and epoch), `model.options`, legacy-writer turns with no events.
- Selected only through the `hermesRoot` setting. No env fallback to `~/.hermes` (R3 M3).

## 6. E2E on an isolated bb

1. Fresh shell: `unset` every `BB_*`; `PATH` without `hermes` (so `provider-acp` can't probe live Hermes; S1-S3 Safety).
2. `BB_SKIP_ONBOARDING=1 npx bb-app@<live version> --data-dir ~/.bb-hermes-e2e --server-port 48886 --host-daemon-port 48887 --no-in-app-updates` (R3 S9).
3. Disable `provider-acp`, `keep-awake` and `connect`.
4. Use `sbb` (unsets `BB_*`, sets `BB_SERVER_URL=http://127.0.0.1:48886`).
5. `sbb plugin install <repo> --yes`; `sbb plugin dev <repo>`. `package.json` scripts pin the `bb` bundled in `bb-app@0.48.1` (the live binary fails to build; S1-S3 gotchas).
6. Set `hermesRoot` to the fake (or to isolated Hermes for layer 7).
7. **Before any check:** `diagnostics.instance_id` must equal the fake's. Otherwise abort.
8. Assert with `sbb thread log|history|options`, `sbb plugin rpc call hermes …` and `sbb push-notifications thread`. Check the UI with agent-browser screenshots matched against the DOM.
9. Teardown: `kill -INT <bb-app pid>`; `rm -rf ~/.bb-hermes-e2e`.
- Limit: the server runs on $HERMES_HOST here. Remote-server latency, host RPC limits (A16), worker lifetime, two-host spawns (A18) and the phone (A30) are dogfood-only.

## 7–8. Isolated Hermes and the Hermes plugin

- Isolated Hermes, recipe 08 §5:
  - `/private/tmp/hermes-spike`, `HERMES_GATEWAY_LOCK_DIR`;
  - `approvals: {mode: manual}`; no Discord or `webapp`; never the hermes-host wrappers.
- `bb_tools` tests (R3 M6):
  - pytest in its own venv `hermes-plugin/.venv`, with stubs for `ctx`, `gateway.session_ingress` and `gateway.session_context`;
  - never `pip install` into `~/.hermes/hermes-agent/venv` (hermes-webui shares it).
- Covered:
  - tool schemas; argument allowlist; `tell` to its own thread refused;
  - cron refusal;
  - the Discord approval hook;
  - `bindings.json` lookup by chat id and by route key; `schema_version` mismatch → `tool_error`;
  - minimal env (has `HOME`, no inherited `HERMES_DASHBOARD_SESSION_TOKEN`);
  - timeout < 420 s;
  - echo: private author present → post; absent → `echo.json`; non-bb author → no post.
- Real symbols are checked only by the drift check and an isolated-Hermes load (symlink, enable, `reload-plugins`, tools in a new session).

## 9. Contract drift

- `contract/used-surface.json` lists everything we depend on:
  - methods and param keys, including `session.mutate` operations with `request_id`/`expected_revision`/`expected_generation`, `clarify.respond` with `prompt_id`/`execution_generation`, `session.detach` without `profile` (R1 S6);
  - event types;
  - control verbs;
  - store columns and `schema_version`;
  - the Python symbols `ctx.register_tool`, `ctx.register_hook`, `ctx.post_message`, `gateway.session_ingress.admission_author`, `gateway.session_context.get_session_env`.
- **Automatic:** the worker runs it whenever the Hermes version or `instance_id` changes. The result goes to health and `bb.log` (D20).
- **Manual:** run `npm run contract:check` on $HERMES_HOST before `hermes update`.

## 10. Live dogfood checklist

Live bb + live Hermes, user present:
- [P0] Live install from `@^0`; one `bb plugin update`; health shows instance, version and drift result; 0 Hermes sessions created.
- [P1] Chats:
  - one chat per profile, type-first and empty; one project chat;
  - reasoning High; an image; voice dictation;
  - an approval, a clarify and a Stop in a throwaway folder;
  - a handoff alex → neo;
  - a Hermes slash command, `/compact`, a fork (tip, and checkpoint if declared).
- [P1] Clients and recovery:
  - the phone: start a chat and chat with a bot (D19);
  - `bb thread spawn --provider hermes` from $WORK_HOST → a clear error, then OK with `--machine $HERMES_HOST`;
  - a gateway restart mid-turn recovers (user-approved: it drops every live Hermes session, Discord and Conduit included);
  - redeploy (`update`, `stopHosted`, new build id in `diagnostics`).
- [P2] Import and mirror:
  - `importPreview` == `e2e/eligibility`; import: 0 unread, 0 pushes, 0 Hermes revisions changed;
  - a CLI turn mirrors as `[CLI]`; a `/retry` in the CLI doesn't duplicate;
  - pin, archive, rename and read both ways.
- [P2] Outage: Wi-Fi off on $HERMES_HOST for 5 min → banner; make a CLI turn and a bb pin; Wi-Fi on → both sync (R3 S13).
- [P3] 4 bot threads; Conduit → bb (including mid-turn) and bb → Conduit; a bot rename leaves `Bot Chat` intact.
- [P4] neo spawns, waits on and reads a Codex thread; cron and non-enabled profiles lack the tools.
- [P5] Throwaway Discord thread: echo then reply; `[Discord]` mirror; rolled-over notice.
- [P6] Parity gate (D25: reasoning, slash commands, fork); parity week log; ACP disabled; the 18 threads render; confirmed cleanup after backup.

## Phase gates

Each gate also needs `npm run check` (test, typecheck, `bb plugin types --check`, build) and `diagnostics` clean: no duplicate bindings, no errors, drift OK.

| Phase | Gate |
|---|---|
| P0 | Unit + client tests on the strict fake; `git ls-remote` as the bb server's user after `gh auth setup-git` (D29); live install from `@^0` + one update (A26); health shows the drift result; A31–A34 protocol check done (T0.12): a gap is raised with the user before P1 |
| P1 | Conformance + own bridge tests; e2e for chats, chips, catalog, reasoning, attachments, approvals, clarify, Stop/steer fencing, handoff, slash commands, `/compact` and fork; A2–A4, A14, A15, A17–A20, A24, A27, A28, A33, A34 verified; dogfood P1 incl. phone |
| P2 | Import, mirror and sync e2e on the fake; A1, A5, A8, A9, A13, A16, A23, A25 verified; dogfood P2 |
| P3 | Bot setup idempotent; Conduit fixture (mid-turn wake) mirrored; dogfood P3 |
| P4 | pytest; isolated-Hermes load; A12, A29, A35 verified; user-approved install and enable in 4 profiles; dogfood P4 |
| P5 | Echo tests + fixture; A10, A11, A21 verified in a supervised live try; dogfood P5 |
| P6 | A7 on isolated bb; parity week clean; user confirms the ACP disable and the cleanup |

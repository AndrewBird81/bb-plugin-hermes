# 03 — Testing

Rules for every layer:
- Never auto-approve.
- Destructive test commands target quoted paths under `/private/tmp/bb-hermes-test/`.
- No live Discord without user approval.
- Live Hermes: read-only unless the gate says otherwise.
- Every gate runs `bb plugin rpc call hermes diagnostics` (R3 S1). Gated live steps first check `docs/operations.md` §Approvals.

## Layers

| # | Layer | Covers | Tool | Phase |
|---|---|---|---|---|
| 1 | Unit | client; store reader (on recorded snapshots); marker codec and input segmentation; deny-list; dedupe; wakes; titles and echo suppression; reconnect diff; model validation; migrations; sensitive-tool filter; dispatch hook | vitest, `@get-bb/plugin-sdk/testing` | P0+ |
| 2 | Bridge conformance | protocol compliance | `experimental_runBridgeConformance` (r07 §6) | P1+ |
| 3 | Own bridge tests | turns the kit doesn't cover | `experimental_createDeltaAssembler` | P1+ |
| 4 | Recorded fixtures | real Hermes shapes | client `onFrame` tap + store snapshots → `test/fixtures/` | T0.13, T1.0, T2.0, P5 |
| 5 | Fake canonical Hermes | all of the above, plus e2e | `test/fake-hermes/` | P0+ |
| 6 | E2E, isolated bb | real bb runtime and UI | `npx bb-app` + `sbb` + agent-browser | P1+ |
| 7 | Isolated Hermes | approvals, cwd, legacy adoption, detach, `bb_tools` load | r08 §5 recipe | P1, P2, P4 |
| 8 | Hermes plugin | tools, echo, env, bindings | pytest in `hermes-plugin/.venv` with stubs | P4, P5 |
| 9 | Contract drift + semantic canary | Hermes version changes | worker check; `npm run contract:check --incoming`; `npm run canary` | P0+ |
| 11 | Audit + soak | live duplicates and gaps | daily `audit` RPC; 7-day soak per gate | P2+ |
| 10 | Live dogfood | the user's setup | checklist below | each phase |

## 1. Unit tests that guard review findings

- 3 re-lists during one outside turn → 1 wake. A failed send deletes the row; a boot with orphaned `queued` rows recovers them (R1 M1, R4 S7).
- Compaction clone → 0 re-rendered turns; scaffolding rows (`_compressed_summary`, restatements) → 0 bubbles; `/retry` → 1 "Retried" turn with the new reply (R1 M2, R4 M3b, S1).
- Author join fails → the `persisted_turn` record still suppresses bb's own message (R4 M3c).
- Store schema mismatch: drift queries pass → warn and continue; fail → import, mirror and sync paused, bb chats still work (R4 M3a).
- `thread.created` for our own spawn → no extra binding (R1 M3).
- Profile pick on a one-turn import → handoff, not init (R1 M9).
- Server-set titles never reach Hermes (R2 S2). Bot pins never reach Hermes (D35).
- Legacy binding: a bb pin, archive or rename → 0 `mutate` calls until adopted (D16, R5 C5).
- Sensitive tools (D36): the list in `src/shared/sensitive-tools.ts` is non-empty and matches A40; a recorded `conduit_location` call renders "used conduit_location" in replay, mirror and the handoff block, and 0 bytes of its result reach bb.
- Dispatch hook (D15): a send starting with `[Discord] ` and no marker is refused; our wake with a marker passes.
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
    - no canonical admission → render persisted rows, close `partial`; later rows → `rest`;
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
  - Not on the Hermes host → `provider.error` naming `--machine <Hermes host>`.
  - `commands/list` → `commands.catalog`; a command turn → `slash.exec`; `/compact` → `compress`; `thread/fork` → `branch{through_message_id?}` and a new identity (P6 gate).

## 4. Recorded fixtures

- Existing: `spike-hermes/src/hermes/fixtures/*.json` (create/stream, clarify, steer/interrupt, replay, viewer, mutate, approval).
- To record. Tasks T0.13/T1.0/T2.0 run before the code that uses them (R3 S4). Isolated unless noted.

| Fixture | Task | Where |
|---|---|---|
| Slash catalog, slash exec, `compress`, `branch` (tip and `through_message_id`) (A31, A33, A34) | T0.12 | isolated |
| Store snapshots + golden reader output: create, compaction (cloned tail, scaffolding), `/retry` with a new reply, steer, stub tools named `conduit_location` and a Home Assistant tool (A8, D36). Doubles as the semantic canary | T0.13 | isolated |
| Gateway restart mid-turn | T1.0 | isolated |
| Attachments on `prompt.submit` (image, file) | T1.0 | isolated |
| Desktop turn seen by a second viewer (A19) | T1.0 | isolated: two canonical clients |
| Detach with `end_reason:null` (A24) | T1.0 | isolated |
| `source:"cli"` vs `hermes chat -c` (A20) | T1.0 | isolated |
| Subagent turn | T2.0 | isolated |
| Legacy (pre-migration) row: store read; a `mutate` claims it; adoption on first send (A23) | T2.0 | isolated, copied DB |
| Legacy-writer turn with no canonical events, wake mid-turn | T2.0 | isolated, legacy dashboard client |
| Discord turn + echo | T5.3 | test bot, or a live throwaway thread with approval |

- Redact before commit: tokens, `origin_json`, user ids.

## 5. Fake canonical Hermes (`test/fake-hermes/`)

- Grows from `spike-hermes/src/hermes/test/fake-gateway.ts` and `spike-bb/src/fake-hermes.ts`.
- **Strict:** validates every request against a vendored copy of `gateway-contract.openrpc.json`: `x-canonical-methods` and the legacy `methods` we call (`model.options`, `commands.catalog`, `slash.exec`), with `additionalProperties:false` like live (R3 S5, R5 C6). The drift check diffs the copy against the live checkout.
- Serves:
  - `gateway.sock` + `/api/ws` for several profiles;
  - a `state.db` per profile copied from a T0.13 snapshot, never hand-built: a fake built from the reader's own model would be circular (R5 C6);
  - scripted turns, approvals and clarify with deadlines;
  - `sessions.changed` and WAL touches;
  - fences (`stale_generation`, `revision_conflict`, `already_resolved`) and the duplicate-title refusal;
  - restart (new port and epoch), `model.options`, legacy-writer turns with no events.
- Selected only through the Hermes host and root settings, with no env fallback to `~/.hermes`. All `bb_tools` files land under `<hermesRoot>/bb_tools/` (R3 M3, R4 M2).

## 6. E2E on an isolated bb

1. Fresh shell: `unset` every `BB_*`; `PATH` without `hermes` (so `provider-acp` can't probe live Hermes; S1-S3 Safety).
2. `BB_SKIP_ONBOARDING=1 npx bb-app@<live version> --data-dir ~/.bb-hermes-e2e --server-port 48886 --host-daemon-port 48887 --no-in-app-updates` (R3 S9).
3. Disable `provider-acp`, `keep-awake` and `connect`.
4. Use `sbb` (unsets `BB_*`, sets `BB_SERVER_URL=http://127.0.0.1:48886`).
5. `sbb plugin install <repo> --yes`; `sbb plugin dev <repo>`. `package.json` scripts pin the `bb` bundled in `bb-app@0.48.1` (the live binary fails to build; S1-S3 gotchas).
6. Set Hermes host (the local daemon) and Hermes root to the fake (or to isolated Hermes for layer 7).
7. **Before any check:** `diagnostics.instance_id` must equal the fake's. Otherwise abort.
8. Assert with `sbb thread log|history|options`, `sbb plugin rpc call hermes …` and `sbb push-notifications thread`. Check the UI with agent-browser screenshots matched against the DOM.
9. Teardown: `kill -INT <bb-app pid>`; `rm -rf ~/.bb-hermes-e2e`.
- Limit: the server runs on $HERMES_HOST here. Remote-server latency, host RPC limits (A16), worker lifetime, two-host spawns (A18) and the phone (A30) are dogfood-only.

## 7–8. Isolated Hermes and the Hermes plugin

- Isolated Hermes, recipe r08 §5:
  - `/private/tmp/hermes-spike`, `HERMES_GATEWAY_LOCK_DIR`;
  - `approvals: {mode: manual}`; no Discord or `webapp`; never the hermes-host wrappers.
- `bb_tools` tests (R3 M6):
  - pytest in its own venv `hermes-plugin/.venv`, with stubs for `ctx`, `gateway.session_ingress` and `gateway.session_context`;
  - never `pip install` into `~/.hermes/hermes-agent/venv` (hermes-webui shares it).
- Covered:
  - tool schemas; argument allowlist; `tell` to its own thread refused; cron refused by the handler;
  - the Discord approval hook, with a fresh `rule_key` per call ("always" can't stick; R4 S5);
  - the work boundary on all 5 tools (author `bb:` or Desktop/Conduit source × Discord-origin or not; a dual-host project counts as work; `list` filtering; R4 M1);
  - `bindings.json` lookup by chat id and by route key; `schema_version` mismatch → `tool_error`;
  - minimal env (has `HOME`, no inherited `HERMES_DASHBOARD_SESSION_TOKEN`);
  - timeout < 420 s;
  - echo: private author present → post; absent → `echo.json`; non-bb author or `messaging_bound:false` → no post (R4 S4).
- Real symbols are checked only by the drift check and an isolated-Hermes load (symlink, enable, `reload-plugins`, tools in a new session).

## 9. Contract drift

- `contract/used-surface.json` lists everything we depend on:
  - methods and param keys, including `session.mutate` operations with `request_id`/`expected_revision`/`expected_generation`, `clarify.respond` with `prompt_id`/`execution_generation`, `session.detach` without `profile` (R1 S6);
  - event types;
  - control verbs;
  - store columns and `schema_version`; source hashes of `is_compaction_scaffolding` and `_display_dedupe_key` (R4 M3e);
  - the Python symbols `ctx.register_tool`, `ctx.register_hook`, `ctx.post_message`, `gateway.session_ingress.admission_author`, `gateway.session_context.get_session_env`, plus `SessionDB` and the display projection if T0.4 picks the Python reader.
- **Automatic:** the worker runs it whenever the Hermes version or `instance_id` changes. The result goes to health and `bb.log` (D20).
- **Before `hermes update`** (R5 C2): `npm run contract:check --incoming` on the Hermes host.
  - `git fetch` in `<hermesRoot>/hermes-agent` (remote refs only; the working tree is untouched);
  - then the same checks on `origin/main` through `git show`, so the incoming version is checked, not the installed one.
- **After `hermes update`:** `npm run canary`.
  - Replays the T0.13 scenarios (create, compact, `/retry`, steer) on isolated Hermes and diffs the reader output against the golden files.
  - It uses the shared `mlx_main` slot for a few turns.
  - Health shows "canary not run" for a new version until it passes.
- Structure checks see methods and columns, not meaning. The canary and the daily audit cover new row kinds, a moved author field and changed adoption rules.

## 10. Live dogfood checklist

Live bb + live Hermes, user present:
- [P0] Live install from `@^0`; one `bb plugin update`; health shows instance, version and drift result; 0 Hermes sessions created.
- [P1] Chats:
  - one chat per profile, type-first and empty; one project chat;
  - reasoning High; an image; voice dictation;
  - an approval, a clarify and a Stop in a throwaway folder; a command smart approvals escalate (e.g. `rm -rf '/private/tmp/bb-hermes-test/x'`), since live runs `approvals.mode: smart` (R5 C6);
  - a handoff alex → neo;
  - 4 bot threads (setup idempotent); a message in each.
- [P1] Clients and recovery:
  - the phone: start a chat and chat with a bot (D19);
  - `bb thread spawn --provider hermes` from $WORK_HOST → a clear error, then OK with `--machine <Hermes host>`;
  - a gateway restart mid-turn recovers (user-approved: it drops every live Hermes session, Discord and Conduit included);
  - redeploy (`update`, `stopHosted`, new build id in `diagnostics`).
- [P2] Import and mirror:
  - `importPreview` == `e2e/eligibility`; import: 0 unread, 0 pushes, 0 Hermes revisions changed;
  - a CLI turn mirrors as `[CLI]`; a `/retry` in the CLI doesn't duplicate;
  - pin, archive, rename and read both ways (the first live two-way sync is user-approved);
  - 7-day soak: the daily audit is clean.
- [P2] Outage: Wi-Fi off on the Hermes host ($HERMES_HOST) for 5 min → banner; make a CLI turn and a bb pin; Wi-Fi on → both sync (R3 S13).
- [P4] neo spawns, waits on and reads a Codex thread; cron and non-enabled profiles lack the tools.
- [P5] Throwaway Discord thread: echo then reply; `[Discord]` mirror; rolled-over notice.
- [P6] Parity gate (D25): a Hermes slash command, `/compact`, a fork (tip, and checkpoint if declared); parity week log; ACP disabled; the 18 threads render; confirmed cleanup after backup.

## Phase gates

Each gate also needs `npm run check` (test, typecheck, `bb plugin types --check`, build) and `diagnostics` clean: no duplicate bindings, no errors, drift OK. From P2 on, a gate also needs 7 days of soak with a clean daily audit before the next phase starts (R5 C6).

| Phase | Gate |
|---|---|
| P0 | T0.4 reader comparison recorded (A36); T0.13 snapshots and canary pass; unit + client tests on the strict fake; `git ls-remote` as the bb server's user after `gh auth setup-git` (D29); live install from `@^0` + one update (A26); health shows the drift result; A31, A33, A34 protocol check done (T0.12): a gap is raised with the user before P1 |
| P1 | Conformance + own bridge tests; e2e for chats, chips, catalog, reasoning, attachments, approvals, clarify, Stop/steer fencing, handoff, bots, the D36 filter in handoff; A2–A4, A14, A15, A17–A21, A24, A27, A28, A40 verified; dogfood P1 incl. phone. Then the go/no-go (D34, 04) |
| P2 | Import, mirror and sync e2e on the fake; A1, A8, A9, A13, A16, A23, A25, A37, A38 verified; dogfood P2; soak |
| P4 | pytest; isolated-Hermes load; A12, A29, A35 verified; user-approved install and enable in 4 profiles; dogfood P4; soak |
| P5 | Echo tests + fixture; A10, A11, A39 verified in a supervised live try; dogfood P5; soak |
| P6 | F14 e2e (slash commands, `/compact`, fork); A33, A34 live; A7 on isolated bb; parity week clean; user confirms the ACP disable and the cleanup |

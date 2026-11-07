# 03 — Testing

Rules for every layer:
- Never auto-approve.
- Destructive test commands target quoted paths under `/private/tmp/bb-hermes-test/`.
- Nothing posts to Discord: the plugin never writes there (D39).
- Live Hermes: read-only unless the gate says otherwise.
- Every gate runs `bb plugin rpc call hermes diagnostics` (R3 S1). Gated live steps first check `docs/operations.md` §Approvals.

## Layers

| # | Layer | Covers | Tool | Phase |
|---|---|---|---|---|
| 1 | Unit | client; history reader (P2, on recorded REST responses); marker codec and input segmentation; deny-list; dedupe; wakes; state push; model validation; migrations; sensitive-tool filter; dispatch hook | vitest, `@get-bb/plugin-sdk/testing` | P0+ |
| 2 | Bridge conformance | protocol compliance | `experimental_runBridgeConformance` (r07 §6) | P1+ |
| 3 | Own bridge tests | turns the kit doesn't cover | `experimental_createDeltaAssembler` | P1+ |
| 4 | Recorded fixtures | real Hermes shapes | client `onFrame` tap + REST responses → `test/fixtures/` | T1.0, T2.0a, T2.0 |
| 5 | Fake canonical Hermes | all of the above, plus e2e | `test/fake-hermes/` | P0+ |
| 6 | E2E, isolated bb | real bb runtime and UI | `npx bb-app` + `sbb` + agent-browser | P1+ |
| 7 | Isolated Hermes | approvals, cwd, legacy adoption, detach | r08 §5 recipe | P1, P2 |
| 8 | Contract drift + semantic canary | Hermes version changes | worker check and daily `contract:check --incoming` (P0); canary (P2) | P0+ |
| 9 | Audit + soak | live duplicates and gaps | daily `audit` RPC; 7-day soak per gate | P2+ |
| 10 | Live dogfood | the user's setup | checklist below | each phase, TS.1 |

## 1. Unit tests that guard review findings

- 3 re-lists during one outside turn → 1 wake. A failed send deletes the row; a boot with orphaned `queued` rows recovers them (R1 M1, R4 S7).
- Compaction clone → 0 re-rendered turns; scaffolding rows (`_compressed_summary`, restatements) → 0 bubbles; `/retry` → 1 "Retried" turn with the new reply (R1 M2, R4 M3b, S1).
- Author join fails → the `persisted_turn` record still suppresses bb's own message (R4 M3c).
- History shape change (REST keys, or schema + per-profile tables for the TS fallback): pass → warn and continue; fail → import and mirror paused, bb chats and pushes still work (R4 M3a).
- Hidden-prompt turn (Pulse) → muted, marked read, 0 pushes (R6 C6). An import never copies Hermes' pin.
- Deny-list: a cron row stored as `source=local, created_source=cron` is excluded; 6 new automatic imports in a day → import paused, health red (R6).
- Handoff block from a recorded bb timeline: ≤ 25 kB, newest turns kept, tool names only for D36 prefixes; 0 Hermes history calls (R6 C4).
- `thread.created` for our own spawn → no extra binding (R1 M3).
- Profile pick on a one-turn import → handoff, not init (R1 M9).
- State push (D38): a bb pin, archive or rename → 1 `mutate`; a Hermes-side change → 0 bb writes; the placeholder title and bot pins never reach Hermes (R2 S2, D35); a refused push is logged once, not retried.
- Legacy binding: a bb pin, archive or rename → 0 `mutate` calls until adopted (D16, R5 C5).
- Sensitive tools (D36): `conduit_*` and `mcp__Home_Assistant__*` match every recorded sensitive call and every name in a vendored `plugin.yaml` `provides_tools`; a recorded `conduit_location` call renders "used conduit_location" in a bb-started turn, replay, mirror and the handoff block, and 0 bytes of its result reach bb.
- Dispatch hook: a send starting with `[Discord] ` and no marker is refused; our wake with a marker passes (D15). Any visible send to a Discord thread is refused (D39).
- Reconnect: bb changes made while the worker was away are pushed once (R1 S14).
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
    - complete → render from history;
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
  - Not on the Hermes host → `provider.error` naming `--machine <Hermes host>`. Hermes `not_found` → "Deleted in Hermes".
  - Read-only bind (Discord) → chip current value `discord`; a visible turn is refused (fallback to the hook).
  - `commands/list` → `commands.catalog`; a command turn → `slash.exec`; `/compact` → `compress`; `thread/fork` → `branch{through_message_id?}` and a new identity (P3 gate).

## 4. Recorded fixtures

- Existing: `spike-hermes/src/hermes/fixtures/*.json` (create/stream, clarify, steer/interrupt, replay, viewer, mutate, approval).
- To record. Tasks T1.0/T2.0a/T2.0 run before the code that uses them (R3 S4). Isolated unless noted.

| Fixture | Task | Where |
|---|---|---|
| Slash catalog, slash exec, `compress`, `branch` (tip and `through_message_id`) (A31, A33, A34) | T0.12 | isolated |
| Golden files from Hermes' REST projection (the oracle, R6 C3), plus `state.db` snapshots for the TS fallback: create, compaction (cloned tail, scaffolding), `/retry` with a new reply, steer, a hidden-prompt turn, stub tools named `conduit_location` and `mcp__Home_Assistant__x` (A8, D36). One human check against Hermes Desktop. Doubles as the semantic canary | T2.0a | isolated |
| Gateway restart mid-turn | T1.0 | isolated |
| Attachments on `prompt.submit` (image, file) | T1.0 | isolated |
| Desktop turn seen by a second viewer (A19) | T1.0 | isolated: two canonical clients |
| Detach with `end_reason:null` (A24) | T1.0 | isolated |
| `source:"cli"` vs `hermes chat -c` (A20) | T1.0 | isolated |
| Subagent turn | T2.0 | isolated |
| Legacy (pre-migration) row: history read; a `mutate` claims it; adoption on first send (A23) | T2.0 | isolated, copied DB |
| Legacy-writer turn with no canonical events, wake mid-turn | T2.0 | isolated, legacy dashboard client |
| Discord turn, user's own message (A39 recheck) | T2.0 | live, read-only REST response |

- Redact before commit: tokens, `origin_json`, user ids.

## 5. Fake canonical Hermes (`test/fake-hermes/`)

- Grows from `spike-hermes/src/hermes/test/fake-gateway.ts` and `spike-bb/src/fake-hermes.ts`.
- **Strict:** validates every request against a vendored copy of `gateway-contract.openrpc.json`: `x-canonical-methods` and the legacy `methods` we call (`model.options`, `commands.catalog`, `slash.exec`), with `additionalProperties:false` like live (R3 S5, R5 C6). The drift check diffs the copy against the live checkout.
- Serves:
  - `gateway.sock` + `/api/ws` for several profiles;
  - from P2: recorded REST responses (T2.0a) per profile, and `state.db` snapshot copies only for the TS fallback; never hand-built, which would be circular (R5 C6);
  - scripted turns, approvals and clarify with deadlines;
  - `sessions.changed` and WAL touches;
  - fences (`stale_generation`, `revision_conflict`, `already_resolved`), a duplicate-title refusal and `not_found`;
  - restart (new port and epoch), `model.options`, legacy-writer turns with no events.
- Selected only through the Hermes host and root settings, with no env fallback to `~/.hermes` (R3 M3).

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

## 7. Isolated Hermes

- Recipe r08 §5: `/private/tmp/hermes-spike`, `HERMES_GATEWAY_LOCK_DIR`; `approvals: {mode: manual}`; no Discord or `webapp`; never the hermes-host wrappers.
- Never `pip install` into `~/.hermes/hermes-agent/venv`: it is hermes-webui's Python 3.11 environment, not Hermes' runtime (R6 C3).

## 8. Contract drift and canary

- `contract/used-surface.json` lists everything we depend on:
  - methods and param keys, including `session.mutate` operations with `request_id`/`expected_revision`/`expected_generation`, `clarify.respond` with `prompt_id`/`execution_generation`, `session.detach` without `profile` (R1 S6);
  - event types;
  - control verbs;
  - from P2: REST response keys, or (TS fallback) store columns, `schema_version`, per-profile tables and the source hashes of `is_compaction_scaffolding` and `_display_dedupe_key` (R4 M3e);
  - the Conduit `provides_tools` prefix check (D36).
- No human step (D20, R6). All three run from the worker; results go to health and `bb.log`.
- **On each version or `instance_id` change:** the checks above against the installed checkout.
- **Daily:** `contract:check --incoming`.
  - `git fetch` in `<hermesRoot>/hermes-agent` (remote refs only; the working tree is untouched);
  - then the file-level checks (contract; the TS fallback's schema and hashes) on `origin/main` through `git show`, so the incoming version shows before anyone updates, from the CLI or Hermes' own UI.
- **Canary (P2, T2.0a), on each version change:** replays the golden scenarios (create, compact, `/retry`, steer, hidden prompt) on isolated Hermes and diffs our reader's output against Hermes' REST projection.
  - It uses the shared `mlx_main` slot for a few turns.
  - If the worker can't drive isolated Hermes, health shows "canary due" until someone runs `npm run canary`.
- Structure checks see methods and keys, not meaning. The canary and the daily audit, both checked against Hermes' projection, cover new row kinds, a moved author field and changed adoption rules.

## 9. Live dogfood checklist

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
  - a CLI turn mirrors as `[CLI]`; a `/retry` in the CLI doesn't duplicate; a Pulse turn arrives muted and read; Pulse isn't pinned;
  - pin, archive and rename land in Hermes (the first live push is user-approved); a rename in Desktop leaves bb unchanged;
  - the user's own Discord message mirrors as `[Discord]` with no dot or push; a bb send there is refused; a profile pick continues it in bb;
  - 7-day soak: the daily audit is clean.
- [P2] Outage: Wi-Fi off on the Hermes host ($HERMES_HOST) for 5 min → banner; make a CLI turn and a bb pin; Wi-Fi on → the turn mirrors and the pin lands in Hermes (R3 S13).
- [TS.1] In default, alex and david: `bb thread list` from a bb chat; a Codex thread started and read back; Neo still works.
- [P3] Parity gate (D25): a Hermes slash command, `/compact`, a fork (tip, and checkpoint if declared); parity week log; ACP disabled; the 18 threads render; confirmed cleanup after backup.

## Phase gates

Each gate also needs `npm run check` (test, typecheck, `bb plugin types --check`, build) and `diagnostics` clean: no duplicate bindings, no errors, drift OK. From P2 on, a gate also needs 7 days of soak with a clean daily audit before the next phase starts (R5 C6).

| Phase | Gate |
|---|---|
| P0 | Unit + client tests on the strict fake (canonical only; no history reader yet, R6 C4); `git ls-remote` as the bb server's user after `gh auth setup-git` (D29); live install from `@^0` + one update (A26); health shows the drift result and a daily `--incoming` run; A31, A33, A34 protocol check done (T0.12): a gap is raised with the user before P1 |
| P1 | Conformance + own bridge tests; e2e for chats, chips, catalog, reasoning, attachments, approvals, clarify, Stop/steer fencing, handoff (from the bb timeline), bots titled on create, the D36 prefix filter; A2–A4, A15, A17–A20, A24, A27, A28 verified; dogfood P1 incl. phone. Then the go/no-go (D34, 04) |
| P2 | T2.0b reader pick recorded (A36); T2.0a golden files and canary pass; import, mirror and push e2e on the fake; A1, A8, A9, A13, A16, A23, A25, A37–A39, A41 verified; dogfood P2; soak |
| P3 | F14 e2e (slash commands, `/compact`, fork); A33, A34 live; A7 on isolated bb; parity week clean; user confirms the ACP disable and the cleanup |
| TS.1 | F11 AC; A42 verified; user-approved |

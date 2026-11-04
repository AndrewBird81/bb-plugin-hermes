# 03 — Testing

Rules for every layer:
- Never auto-approve.
- Destructive test commands target quoted paths under `/private/tmp/bb-hermes-test/`.
- No live Discord without user approval.
- Live Hermes: read-only unless the phase gate says otherwise.

## Layers

| # | Layer | Covers | Tool | Phase |
|---|---|---|---|---|
| 1 | Unit | canonical client; marker codec; import filter; dedupe; placement (cwd → project); title strip and conflict; echo suppression; outbox retry; model validation and `custom:mlx-main` normalisation | vitest, `@get-bb/plugin-sdk/testing` (`createFakePluginHost`) | P0+ |
| 2 | Bridge conformance | protocol compliance | `experimental_runBridgeConformance` (07 §6) against fake Hermes | P1+ |
| 3 | Own bridge tests | turns the kit doesn't cover | `experimental_createDeltaAssembler` | P1+ |
| 4 | Recorded fixtures | real Hermes event shapes | client `onFrame` tap → `test/fixtures/` | P1–P5 |
| 5 | Fake canonical Hermes | everything above, plus e2e | `test/fake-hermes/` | P0+ |
| 6 | E2E, isolated bb | real bb runtime and UI | `npx bb-app` + `sbb` + agent-browser | P1+ |
| 7 | Isolated Hermes | approvals, clarify, cwd, plugin load | 08 §5 recipe | P1, P4 |
| 8 | Hermes plugin | `bb_tools` tools and echo | pytest + isolated Hermes | P4, P5 |
| 9 | Contract drift | daily Hermes canary | `npm run contract:check` | P0+ |
| 10 | Live dogfood | the user's real setup | checklist below | each phase |

## 2–3. Bridge tests

- Conformance scenarios:
  - `handshake/initialize`, `session/start-identity`, `session/resume-identity`, `session/resume-id-uniqueness`;
  - `turn/lifecycle`, `turn/settles-without-activity`, `stop/interrupt-settles-before-result`, `stop/release-not-interrupted`;
  - `events/schema-valid`, `item/opens-before-delta`.
  - Placeholder identity at start: ASSUMED A15.
- Our own tests (fake Hermes counts every RPC it receives):
  - replay and mirror turns render as chat, and the fake receives **0** `prompt.submit`;
  - mirror with a visible tagged input renders no second user line;
  - `turn/steer` during a mirror → `prompt.submit`; during a bb turn → `session.steer`; `stale_generation` falls back;
  - identity arrives only after the first boundary, never mid-turn (S1-S3 fact 1);
  - approval choices are never widened; settled-elsewhere and timeout close the card; `already_resolved` is silent;
  - reconnect mid-turn: 0 duplicates, 0 gaps, streamed text == `message.complete` text (S0-S4 §S4e);
  - `snapshot_required` and `truncated` → resume path;
  - compression tip change keeps `providerThreadId`;
  - lazy create: an empty chat → 0 `session.create`;
  - handoff first prompt = handoff block + message, without `api_text`;
  - Discord-routed session: `turn_author.id` starts with `bb:`;
  - an unoffered `turn/start.model` → the profile default + warning; a late profile change → refused turn, no Hermes call;
  - the catalog is republished on start, resume, init and after each turn.

## 4. Recorded fixtures

- Existing: `spike-hermes/src/hermes/fixtures/*.json` (S4b create/stream, S4c clarify, S4d steer/interrupt, S4e replay, S4f viewer, S4g mutate, T1 approval).
- To record, read-only or on isolated Hermes unless noted:

| Fixture | Phase | Where |
|---|---|---|
| CLI outside turn | P2 | isolated |
| Desktop turn (viewer) | P2 | live, viewer only |
| Compression continuation | P2 | isolated (`session.mutate compress`) |
| Subagent turn | P2 | isolated |
| Gateway restart mid-turn | P1 | isolated |
| Conduit Bot Chat turn (transcript only) | P3 | live, read-only |
| Discord turn + echo | P5 | test bot, or a live throwaway thread with approval |

- Redact before commit: tokens, `origin_json`, user ids.

## 5. Fake canonical Hermes (`test/fake-hermes/`)

- Grows from `spike-hermes/src/hermes/test/fake-gateway.ts` and `spike-bb/src/fake-hermes.ts`.
- Serves:
  - `gateway.sock` (`identify`, `session-ticket`) and `/api/ws`;
  - multiple profiles with transcripts, lineage and `Bot Chat` rows;
  - scripted turns from fixtures; approvals and clarify with deadlines;
  - `sessions.changed`, plus a WAL-file touch per profile;
  - `stale_generation`, `revision_conflict`, `already_resolved`, duplicate-title refusal;
  - restart (new port, new `replay_epoch`); `model.options`; `session.export`.
- Selected by the test-only env `HERMES_BB_ROOT_HOME` (default `~/.hermes`).

## 6. E2E on an isolated bb

1. Fresh shell: `unset` every `BB_*` (07 §5). `PATH` must not contain `hermes`, so `provider-acp` can't probe live Hermes (S1-S3 Safety).
2. `npx bb-app@0.48.1 --data-dir ~/.bb-hermes-e2e --server-port 48886 --host-daemon-port 48887 --no-in-app-updates`. Pin the live bb version.
3. Disable `provider-acp`, `keep-awake` and `connect` before anything else.
4. Run every command through the wrapper `sbb` (unsets `BB_*`, sets `BB_SERVER_URL=http://127.0.0.1:48886`).
5. `sbb plugin install <repo> --yes`; `sbb plugin dev <repo>`. Build with the bundled `bb` (the live binary fails; S1-S3 gotchas).
6. Point at fake Hermes (`HERMES_BB_ROOT_HOME`), or at isolated Hermes for layer 7.
7. Assert with `sbb thread log|history|options`, `sbb plugin rpc call hermes …` and `sbb push-notifications thread`. Check the UI with agent-browser screenshots matched against the DOM (S1-S3 gotcha).
8. Teardown: `kill -INT <bb-app pid>`; `rm -rf ~/.bb-hermes-e2e`.
- Limit: the isolated server runs on $HERMES_HOST. Remote-server latency, host RPC limits (A16) and worker lifetime need dogfood on live.

## 7. Isolated Hermes

- Recipe 08 §5:
  - `/private/tmp/hermes-spike`, `HERMES_GATEWAY_LOCK_DIR`;
  - `approvals: {mode: manual}`;
  - no Discord or `webapp`;
  - never the hermes-host wrappers.
- Use for: approval and clarify AC (F8), cwd (F2), `bb_tools` load, compression and subagent fixtures.

## 8. Hermes plugin tests (`hermes-plugin/bb_tools/tests/`)

- pytest, with a stub `bb` on PATH that records argv and env.
  - Schema registration, handler output and `tool_error` paths.
  - `bindings.json` lookup by `HERMES_SESSION_CHAT_ID` and by session key.
  - Minimal env: no inherited `HERMES_DASHBOARD_SESSION_TOKEN`.
  - Subprocess timeout < 420 s.
- Echo hook:
  - private `admission_author` present → posts;
  - absent → `echo.json` fallback;
  - non-bb author → no post;
  - `platform` local → no post.
- Isolated Hermes: symlink into `/private/tmp/hermes-spike/plugins/bb_tools`, enable, `reload-plugins`. The tools appear in a new session (11 §5).

## 9. Contract drift check

- `contract/used-surface.json` lists what we use:
  - canonical methods and param keys: `session.create|resume|list|events.since|mutate|interrupt|steer|detach|export`, `prompt.submit`, `approval.respond`, `clarify.respond`, `profiles.list`, `model.options`, `runtime.describe`;
  - event types and payload keys;
  - control-socket verbs;
  - Python symbols used by `bb_tools`: `ctx.register_tool`, `ctx.register_hook`, `ctx.post_message`, `gateway.session_ingress.admission_author`, `gateway.session_context.get_session_env`.
- `npm run contract:check`:
  - diffs `used-surface.json` against `~/.hermes/hermes-agent/apps/shared/src/gateway-contract.openrpc.json`;
  - diffs it against live `runtime.describe` capabilities (read-only);
  - runs `inspect.signature` on the Python symbols.
  - `model.options` is not in `x-canonical-methods` (11 §1), so it is checked by a live read-only call.
- Daily on $HERMES_HOST, after the canary update (bb automation). A failure posts to a bb thread and shows in Settings health.

## 10. Live dogfood checklist

Live bb + live Hermes, user present. Run the phase's items:
- [P0] Settings health shows the live instance id and version; 0 Hermes sessions created (`session.list` counts before and after).
- [P1] One chat per profile; one project chat; an approval, a clarify and a Stop in a throwaway folder; a handoff alex → neo; a gateway restart mid-turn recovers (user OK'd restarts).
- [P1] Redeploy: install the next tag, `stopHosted`, the next turn shows the new build id.
- [P1] Handoff from the desktop app doesn't move the phone; an empty chat leaves no unread dot and no push.
- [P2] `importPreview` counts equal the read-only query:
  - `sqlite3 "file:<home>/state.db?mode=ro"`;
  - `message_count>0`, last activity ≥ now−30 d;
  - sources in the toggles, not acp, not `Bot Chat`.
- [P2] Then:
  - import: 0 unread, 0 pushes;
  - a CLI turn mirrors with `[CLI]`;
  - pin, archive, rename and read both ways;
  - sleep $HERMES_HOST 10 min, wake, catch up.
- [P3] 4 bot threads; Conduit → bb and bb → Conduit; a bot rename leaves `Bot Chat` intact.
- [P4] neo spawns, waits on and reads a Codex thread; a non-enabled profile lacks the tools.
- [P5] Throwaway Discord thread: echo then reply; `[Discord]` mirror; rolled-over notice.
- [P6] 1-week parity log; ACP disabled; the 18 threads render; confirmed probe cleanup.

## Phase gates

Every gate also needs `npm run check` (test, typecheck, `bb plugin types --check`, build) green.

| Phase | Gate |
|---|---|
| P0 | Unit + fake-Hermes client tests green; isolated bb: provider hidden (S1-S3 §S3a), health from fake and live; drift check runs |
| P1 | Conformance + own bridge tests green; e2e new chat / chip / catalog / approval / clarify / interrupt / steer / handoff on isolated bb + isolated Hermes; A2, A3, A4 (submit), A14, A15, A17, A18 verified; dogfood P1 |
| P2 | Import, mirror and sync e2e on fake Hermes; A1, A4, A5, A8, A9, A13, A16 verified; dogfood P2 |
| P3 | Bot setup idempotent on fake; Conduit fixture mirrored; dogfood P3 |
| P4 | pytest green; isolated-Hermes load; A12 verified; user-approved enable in 4 profiles; dogfood P4 |
| P5 | Echo unit + fixture; A10, A11 verified in a supervised live try; dogfood P5 |
| P6 | A7 verified on isolated bb; parity week clean; user confirms ACP disable and cleanup |

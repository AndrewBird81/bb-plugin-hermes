# Spike brief: Hermes canonical client (S4) and transports (S0)

## Objective

Build the TypeScript `hermes-gateway-v1` client the bb bridge will use. Prove it against live Hermes, then measure the three transports (E, A, B) end to end.

## Read first

- `docs/design/00-architecture-draft.md`
- `docs/research/08-hermes-spike-prep.md`: the cheat-sheet, auth, isolated-instance steps, and plugin install notes.
- `docs/research/03-hermes-runtime.md` and `docs/research/09-architecture-review.md` (M2, M4, M5).
- Ground truth: `~/.hermes/hermes-agent` @ c314285f07, in particular `apps/shared/src/gateway-contract.openrpc.json`, `gateway/session_controls.py`, `tui_gateway/owner_forward.py`, `hermes_cli/gateway_client.py`, `gateway/run_api.py`, `gateway/webapp_listener.py` and `webapp_sign_in.py`.
- Conduit's plugin `~/.hermes/plugins/conduit_push` is prior art (`bot_chat_adopt.py`, `upstream/contract.yml`).

## Where and how

- Work only in your jj workspace (cwd), under `src/hermes/`. Commit with `jj commit -m`. Never push.
- Node 22 and TypeScript, built for the bb host bundle. Keep it free of bb dependencies: a plain client plus types and vitest.
- **Live Hermes rules** (the user allowed live use, with limits):
  - Create sessions only in the `default` profile, titled `[bb-spike] …`. Use the cheapest model available for a session (prefer local `mlx_main` if `session.create` accepts it).
  - At most ~10 short prompts in total.
  - **Never `prompt.submit` into a session you didn't create.** Resuming real sessions as a viewer (`omit_messages:true`) is allowed.
  - Never approve anything destructive. Make the approval test target a throwaway path under `/private/tmp/bb-spike/`.
  - At the end, delete your spike sessions (`session.mutate` delete, or the dashboard), and list their IDs in the report.
  - Never restart, stop or `--replace` the live gateway or dashboard. Never run hermes-host wrappers, `hermes update` or `hermes gateway …`. Never touch Discord.
  - Option A test on the live dashboard:
    - Add `bb_bridge` to `plugins.enabled` and hot-mount it (an HTTP GET first). This is allowed.
    - A dashboard restart is allowed only if hot-mount can't pick up a code change (it drops Conduit's legacy chats, so keep it to one or two).
    - Remove the plugin from `plugins.enabled` at the end, and report that.
  - Never print secrets. Read tokens from their files into process memory; never into logs, commits or reports.
- **Option E only on an isolated Hermes:**
  - Use `HERMES_HOME=/private/tmp/hermes-spike` and `HERMES_GATEWAY_LOCK_DIR`, with `webapp.enabled` on a fixed port. Follow 08 §5 exactly.
  - Use the `/private/tmp` real path, a new random dashboard token, no platforms, and the oMLX `mlx_main` model.
  - Tear it down at the end.

## Experiments (record VERIFIED or FAILED, with evidence, for each)

- **S4a. Local connector.** Discover the endpoint (no `ensure_gateway_runtime`), mint a host-scoped ticket over `~/.hermes/gateway.sock`, then call `runtime.describe` and `profiles.list` (with `canonical_session` = Bot Chat).
- **S4b.** `session.create` (record the `source` and any tag we can set so the feed can recognise bb-created sessions), then `prompt.submit` and the streamed events until completion. Save the redacted frames as fixtures in `src/hermes/fixtures/`.
- **S4c.** Approval round trip (`approval.request` → `approval.respond`, `approval.settled`). A clarify round trip if you can trigger one.
- **S4d.** `session.interrupt` and `session.steer` while a turn is running; record the `execution_generation` fencing.
- **S4e.** Drop the socket mid-turn, reconnect, then `session.resume` plus `session.events.since`. Does gap replay work, and does the dedupe rule hold?
- **S4f.** Resume, as a viewer, one real interactive session and one Bot Chat in another profile, over the same host-scoped socket. Then watch `sessions.changed`: does it fire when another client writes?
- **S4g.** `session.mutate` sidebar (pin/unread) and rename on a spike session; read back via dashboard REST.
- **S0. Transports.** Measure each end to end: connect, auth, one turn, reconnect.
  - B: local socket (S4a).
  - A: a relay plugin on the live dashboard. It must use `_ws_auth_ok` and fail closed, so test unauthenticated, ticket and token cases. Connect over `https://$HERMES_HOST_TS.$TAILNET:8448`.
  - E: the isolated webapp listener, with its sign-in flow and token lifetime, and whether plugin routes run in-process next to the authority.
  - For each: latency, code size, private Hermes symbols used, and what breaks on `hermes update`.

## Deliverable

- `docs/spikes/S0-S4-hermes.md`:
  - per experiment: result, evidence, gotchas;
  - a transport recommendation with a ranked table;
  - a protocol cheat-sheet as actually observed (corrections to 08).
- Client code, fixtures and tests committed in your workspace.
- Final message to the parent: 6 bullets at most, plus paths and the IDs of spike sessions you created and deleted.

## Stop and ask the parent (end your turn with the question)

- Anything requires a live gateway restart, a config change other than `plugins.enabled`, or a submit into a non-spike session.
- Auth needs secrets you can't read without printing them.
- The protocol differs materially from 08.

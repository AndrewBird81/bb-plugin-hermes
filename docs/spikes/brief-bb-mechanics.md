# Spike brief: bb mechanics (S1 import, S2 mirror, S3 UX)

## Objective

Prove or disprove that a bb plugin provider can:
- turn existing Hermes sessions into normal-looking bb threads;
- mirror activity that happens outside bb, live;
- hide the machine and provider pickers.

Use an **isolated local bb** and a **fake Hermes** built into the bridge. Answer with evidence: screenshots and logs.

## Read first

- `docs/design/00-architecture-draft.md`
- `docs/research/07-bb-spike-prep.md` (most of the recipes are here)
- `docs/research/01-bb-plugin-sdk.md`
- `docs/research/09-architecture-review.md`

Reference code (read-only):
- `/tmp/spikeprep-bb/bb`: get-bb/bb clone; the `desktop-v0.48.1` tag has SDK 0.6.104. See `examples/plugins/echo-provider` and `packages/provider-bridge-protocol`.
- `/tmp/spikeprep-ea/bb-plugins/packages/external-agents`: no license, so ideas only, never copy code.
- The bundled SDK types: `~/src/bb-plugin-code-review-workspace/node_modules/@get-bb/plugin-sdk/bundled-types`.

## Where and how

- Work only in your jj workspace (cwd). Commit with `jj commit -m`. Never push.
- Plugin skeleton:
  - package name `bb-plugin-hermes`;
  - `bb` block with `server`, `app` and `host`;
  - `@get-bb/plugin-sdk` pinned to the host version (0.6.104; check with `bb plugin types --check`), listed under `dependencies` because the bridge imports `/provider-bridge`;
  - vitest.
- Isolated bb, per 07 §5:
  1. In a dedicated terminal, unset every inherited `BB_*` variable.
  2. Run `BB_SKIP_ONBOARDING=1 npx bb-app@0.48.1 --data-dir ~/.bb-spike --server-port 48886 --host-daemon-port 48887 --no-in-app-updates`.
  3. Then use `BB_SERVER_URL=http://127.0.0.1:48886 bb plugin install <path> --yes` and `bb plugin dev <path>`.
- **DANGER:** your own shell has `BB_SERVER_URL` pointing at the user's LIVE bb server. Every `bb` command meant for the spike must carry an explicit `BB_SERVER_URL=http://127.0.0.1:48886`. Never install, enable or configure anything on the live server. Never spawn, send to or archive live threads.
- UI evidence: use agent-browser (isolated profile) against `http://127.0.0.1:48886`. Save screenshots to `docs/spikes/img/`.
- Fake Hermes, in-bridge:
  - one canned session with history: 3 user turns, assistant replies, 2 tool calls, 1 reasoning block;
  - a server-triggerable "external turn" generator that streams text and a tool call over about 10 s, preceded by an external user line;
  - one canned "Bot Chat".

## Experiments (record VERIFIED or FAILED, with evidence, for each)

- **S1a. Import via an agent-only bind marker plus `input.provider` replay.**
  - Spawn with `title`, `pluginMetadata`, a short `sendAt`, and a marker in the input.
  - The bridge announces `thread/identity` = `<profile>:<root>`, replays history in a single turn, and closes it.
  - Screenshot the result: does the marker stay invisible? How do the System Message cards look?
- **S1b. Import by replaying history as real turns.**
  - Each historical user message becomes a visible input with an agent-only replay marker; the bridge answers from history and never "calls Hermes".
  - Compare with S1a on bubble rendering, prompt-history pollution, notifications/unread during import, timestamps and duration.
  - Recommend one.
- **S1c. Rebinding.**
  - Run `bb thread stop`, then a follow-up; then restart the isolated bb. Does `thread/resume` arrive with the same `providerThreadId`?
  - Handle collision: import the same session twice. What does bb do, and does it leave an orphan thread?
- **S2a. Wake.** The server calls `threads.send({mode:"queue-if-active", input:[agent-only marker]})`. The bridge mirrors the fake external turn live. Capture:
  - the home-page progress indicator;
  - whether a stray bubble appears;
  - unread state and notification behavior;
  - the time from the external start to the first visible delta.
- **S2b. Bridge-opened turn on an already-hosted idle thread,** with no send at all.
- **S2c. User sends while a mirror turn is open.** What does the runtime deliver, and how should the bridge map it?
- **S2d (optional, only if S2a is noisy).** Keep the runtime hosted with a pending `backgroundTask` item. What are the side effects?
- **S3a. Picker visibility.** Use `experimental_visibility:"installed"` with health `not_installed`.
  - Is the provider hidden from the standard New Thread picker?
  - Does the thread page still offer follow-ups, the model picker and a `profile` session option?
  - What does Settings → Providers show?
- **S3b. Our own entry point.** A `homepageSection` or `navPanel` "New Hermes chat" with a profile select spawns into the personal project with a fixed environment and host.
  - Is any machine picker shown anywhere in that flow?
  - Is the profile shown read-only after the first turn?
- **S3c.** `markRead`; `threadNotifications.set` via push-notifications RPC; archive and rename forwarded to the bridge when no runtime is live.

## Deliverable

- `docs/spikes/S1-S3-bb-mechanics.md`:
  - per experiment: result, evidence, gotchas;
  - a recommended approach for import, mirror and UX;
  - the SDK APIs actually used.
- Screenshots in `docs/spikes/img/`.
- The spike code committed in your workspace.
- Final message to the parent: 6 bullets at most, plus paths.

## Stop and ask the parent (`bb thread tell` is not needed; just end your turn with the question)

- The isolated bb won't start, or plugin install fails 3 times: give the exact error.
- Anything would require touching the live bb server or live Hermes.
- An experiment's result contradicts the draft in a way that changes the architecture.

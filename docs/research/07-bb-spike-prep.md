## Key answers

Scope: the bb-side details needed to design spikes S1–S3 (see `docs/design/00-architecture-draft.md`). Labels: **VERIFIED** = I read the code or doc, or ran a read-only command. **INFERRED** = my conclusion, not run. I ran no spike.

Sources:
- `get-bb/bb`, cloned read-only to `/tmp/spikeprep-bb/bb`:
  - `main` @ `d060de8e30f3` (SDK 0.6.120).
  - Tag **`desktop-v0.48.1`** (its `packages/plugin-sdk` is **0.6.104** = the live host). I diffed the key files against main (see bottom).
- Bundled SDK 0.6.104: `~/src/bb-plugin-code-review-workspace/node_modules/@get-bb/plugin-sdk/bundled-types/` (`$SDK`).
- Skills: `$SK` = `~/.bb-machines/$BB_SERVER_TS.$TAILNET/runtime/global-skills/4ce0…/skills`.
- `AndrewBird81/bb-plugins` @ `94cfe9a0`, cloned to `/tmp/spikeprep-ea/bb-plugins`.

1. **`experimental_visibility`** (VERIFIED)
   - Values: `"always"` (default) | `"installed"`; anything else is refused at registration. `"installed"` requires `maintenance.health: true`.
   - With `"installed"`, unscoped/host listings show the provider on a host only when its bridge's `provider/health` status is not `not_installed`.
   - Targeted requests (`providerId=` given) still resolve a hidden provider: `includeRequestedRegisteredProvider`.
   - The thread page queries with `providerId = thread.providerId`, so follow-ups and the model/session-option picker keep working.
   - Thread creation checks only *disabled*/*unavailable*, not visibility.
   - **So yes:** a bridge whose `provider/health` always answers `not_installed` stays out of the standard New Thread picker on every host, while plugin-spawned threads behave normally.
   - Side effects:
     - Settings → Providers / onboarding treat it as "not installed".
     - `bb provider disable` is **not** an alternative: a disabled provider refuses spawn and bridge launch (`provider_disabled`).
2. **`agent-only` input** (VERIFIED)
   - It is still a normal turn request (`client/turn/requested`), but it is invisible:
     - skipped by the timeline projection (no user bubble when every part is agent-only);
     - excluded from search, prompt history, title generation and the queued-messages UI.
   - The bridge receives it unchanged in `turn/start.input` with `visibility:"agent-only"`.
   - `thread/start` carries **no** input; the first prompt always arrives as `turn/start`.
   - `pluginSubmission`: opaque `{pluginId,data}`, seen only by `message.dispatch` hooks, not persisted, never reaches the bridge.
   - `sendAt`: thread created `pending`, with the first message queued until the clock.
3. **Hosting and wake**
   - bb (re)hosts a thread only through `ensureThreadRuntime` → `thread/resume`. Triggers: `turn.submit` (any send or retry) and `thread.goal.clear`. VERIFIED.
   - No server-plugin API hosts a thread without a turn: host RPC goes to a separate worker process, not the bridge; there is no "attach" command. VERIFIED by absence.
   - Bridge-opened turns are allowed on any thread the bridge process **currently hosts**, idle included. Deltas for unhosted threads are dropped.
   - **Cleanest S2 wake:** `bb.sdk.threads.send({threadId, mode:"queue-if-active", input:[{type:"text", text:"<sync marker>", visibility:"agent-only"}]})`.
     - The bridge must `input.accepted` it, then mirror the external turn inside that turn.
     - Outcome: no stray user bubble; the progress indicator works because it is a real turn.
4. **Notifications, read state, concurrency**
   - The plugin can mark threads read: `bb.sdk.threads.markRead/markUnread` (VERIFIED, `$SDK/bb-plugin-sdk.d.ts` 18886–18887).
   - The plugin can set a per-thread notification level through push-notifications RPC: `sdk.plugins.callRpc({pluginId:"push-notifications", method:"threadNotifications.set", input:{threadId, level}})` (VERIFIED, doc).
   - Concurrency:
     - The concurrency-limit plugin (running here) gates `message.dispatch` for **idle** threads against `threads.listRunning()`. So wake sends can be held, and running mirror turns count against the global limit and the host's limit ($HERMES_HOST auto = 18). VERIFIED.
     - Bridge-opened turns bypass the gate but still count as running (INFERRED).
5. **Isolated bb on $HERMES_HOST**
   - Command: `npx bb-app@0.48.1 --data-dir ~/.bb-spike --server-port 48886 --host-daemon-port 48887 --no-in-app-updates`.
   - First **unset every inherited `BB_*` var**: this shell has `BB_SERVER_URL`, `BB_HOST_DAEMON_PORT`, `BB_THREAD_ID`, … all pointing at the live server.
   - The launcher also runs a local host daemon, so the bridge runs on $HERMES_HOST beside Hermes.
   - Install the plugin by local path. Docs VERIFIED; not run.
6. **external-agents**
   - Author: Patrick Lee (fork of `patleeman/bb-plugins`). **No license**, so treat it as reference only and ask before copying.
   - Targets Hermes `/v1/runs` (API server), SDK 0.6.15.
   - Reusable *ideas*: event→delta mapper, approval choice narrowing, conformance-test pattern, fixture server.
   - Echo example: `examples/plugins/echo-provider`.
   - Conformance kit: `@get-bb/plugin-sdk/provider-bridge/testing` (`experimental_runBridgeConformance`).
7. **New risk for S1/S2** (VERIFIED in source; rendering not observed)
   - `input.provider` user lines render as a **"BB · System Message"** card (`initiator:"system"`, Info icon), not as a user bubble.
   - So imported or Discord user messages will look like system notes. S1 must judge this; alternatives are in §2.

## 1. Provider visibility (S3)

- Declaration and doc:
  - `$SDK/bb-plugin-sdk.d.ts` 20646–20650: `experimental_visibility?: "always" | "installed"`, default `"always"`.
  - `docs/provider-plugin-api.md` 162–165: listed on a host only when health is not `not_installed`; bridge failures hide only that provider.
- Validation: `packages/plugin-sdk/src/internal/host-policy.ts` 1536–1545 (bad value → error; `"installed"` without `maintenance.health` → error).
- Listing (`apps/server/src/services/system/execution-options.ts`, main):
  - 120–134: `listConfiguredSystemProviderInfos` keeps `visibility === "always"` only.
  - 161–232: `listInstalledPluginProviderInfos` probes `provider.health` per host and caches the result per `{hostId, providerId}` with revalidation. It keeps the provider only if `result.supported && status !== "not_installed"`.
  - 136–152: `includeRequestedRegisteredProvider` appends any registered, non-disabled provider that was requested explicitly.
  - 443–495: `resolveExecutionOptions` calls it for `query.providerId`.
  - Same logic at `desktop-v0.48.1` (`git show` lines 136, 171).
- Thread page:
  - `apps/app/src/views/thread-detail/ThreadDetailPromptArea.tsx` 705–718 passes `initialProviderId: thread.providerId` (0.48.1 line 704).
  - `apps/app/src/hooks/useThreadCreationOptions.ts` 424–442 sends it as `providerId` → `includeRequestedRegisteredProvider`. VERIFIED by reading.
- Creation: `apps/server/src/services/threads/thread-default-policy.ts` 180–210 rejects `provider_disabled` or `!available`, with no visibility check.
- Health is consumed only by listing and `provider-states.ts` (Settings/onboarding). Grep: `"provider.health"` appears only in `provider-states.ts:67` and `execution-options.ts:192`. VERIFIED.
- Hide trick for S3 (INFERRED, spike it):
  - Declare `experimental_visibility:"installed"` + `maintenance.health:true`; the bridge answers `provider/health` with `status:"not_installed"`.
  - Then check:
    - the New Thread picker hides it (all hosts);
    - the thread page lists models and session options;
    - the provider handoff menu on other threads (likely hidden; fine);
    - Settings → Providers shows "not installed" (cosmetic).
  - Caveat: health status is per host and context-free, so it cannot hide the provider from the picker while showing it to our own `experimental_ProviderModelPicker`. Our UI should pass `providerId` explicitly.
  - Alternative: answer `ready` and accept a picker entry. With `deriveProviderOptions` lacking a binding, a picker-started thread is an ordinary new Hermes chat (harmless).

## 2. agent-only input, pluginSubmission, sendAt (S1/S2)

- Schema (VERIFIED):
  - `packages/domain/src/shared-types.ts` 99–104: `visibility?: "agent-only"` on every prompt input part.
  - 0.6.104: `$SDK/bb-plugin-sdk.d.ts` ~13064 (localFile shows it; same for all parts).
- Rendering and indexing (VERIFIED, main = 0.48.1 for this file):
  - `packages/thread-view/src/user-message-parsing.ts` 48–51 skips agent-only parts; 91–94 returns `null` when nothing visible remains; 364 then emits no user message.
  - `packages/db/src/data/events.ts` 679–685, 3229–3231: excluded from search text.
  - `apps/server/src/services/prompt-history.ts` 331–336: not recorded in prompt history.
  - `apps/server/src/services/threads/title-generation.ts` 339–341: ignored for titles, so pass `title` on spawn.
  - `packages/client-core/src/prompt/threadQueuedMessages.ts` 14–17: hidden in queued rows.
- Still a turn (INFERRED, from turn plumbing):
  - It is persisted as a `client/turn/requested` event; status goes idle→active→idle; `thread.idle` fires.
  - push-notifications schedules "turn-finished" on `thread.idle` for visible threads: `plugins/push-notifications/sender.ts` 664–667.
  - `latestAttentionAt` is set on qualifying status transitions: `packages/db/src/data/threads.ts` 2351–2360.
- Bridge receives it:
  - `packages/agent-runtime/src/bridge-protocol-adapter.ts` 283–347: `thread/start` has no `input`; `turn/start` passes `command.input` unfiltered.
  - Intent confirmed by `apps/server/src/services/threads/turn-retry.ts` 109–137, where retries deliberately send agent-only blocks to the provider.
  - The bridge sees `{type:"text", text, visibility:"agent-only"}`. VERIFIED by reading.
- Binding transport recommendation: put the binding **in the agent-only marker text** (e.g. JSON `{hermesBind:{profile, sessionId}}`) instead of the pluginMetadata→`deriveProviderOptions` cache.
  - Reason: `deriveProviderOptions` gets only `threadId` and settings (01 §2), and the marker arrives in the same `turn/start`.
  - Keep pluginMetadata for the server side.
  - INFERRED; S1 verifies.
- external-agents' `prompt()` (`src/hermes-bridge.ts` 30–33) joins all text parts. Our bridge must branch on `visibility`.
- `pluginSubmission` (VERIFIED):
  - Defined at `packages/server-contract/src/api/threads.ts` 170–172 (create) and 292–294 (send).
  - Delivered only as `experimental_submission` to `message.dispatch` hooks: `apps/server/src/services/threads/dispatch-hooks.ts` 377. `packages/plugin-sdk/src/backend-contract.ts` 707–716: "Core does not persist or interpret the data"; null on queued re-attempts.
  - Not useful for the binding.
- `sendAt` (VERIFIED):
  - Create (`threads.ts` 162–169): thread `pending`, no turn, no environment work, first message queued until the epoch ms.
  - Send (`threads.ts` 295–300): queued row, re-attempted by the due sweep.
  - Use: spawn with a short `sendAt` so the plugin can write pluginMetadata and mappings before the first turn reaches the bridge (INFERRED).
- Send modes in 0.6.104: `queue-if-active | steer-if-active | auto | start | steer` (`threads.ts` 95–101; `$SDK` 13069–13075). Correction: 01's "`auto|queue|steer`" is out of date.
- `input.provider` (VERIFIED):
  - Assembler `packages/provider-bridge-protocol/src/assembler/delta-assembler.ts` 1290–1308: needs an open turn; emits `userMessage` text only.
  - Projection `user-message-parsing.ts` 479–516: `initiator:"system"`, `systemMessageKind:"unlabeled"`, `turnRequest.kind:"steer"`.
  - App `ConversationMessageContent.tsx` (0.48.1: 394–401) renders `initiator==="system"` as `GeneratedConversationMessage` with source "BB", title "System Message" (`GeneratedConversationMessage.tsx` 203–211), and the Info icon.
  - Options for S1:
    - (a) accept it;
    - (b) emit user lines as an extension item `"hermes/userMessage"` with declarative `presentation`, plus `experimental_timelineRenderer` for the expanded body. It still renders as a collapsible row, not a bubble (`$SK/bb-plugin-authoring/references/frontend-renderer-slots.md` 256–268);
    - (c) prefix the text, e.g. "$OWNER_NAME (Discord): …".

## 3. Turns, hosting, wake (S2)

- Bridge-opened turns (`docs/provider-bridge-protocol.md`, main 445–510 = 0.48.1 plus 16 unrelated lines):
  - Rule 3: "A turn the user did not initiate … becomes an explicit bridge-emitted `turn.open`."
  - ACP precedent: it opens a turn when the agent streams with no prompt in flight and settles after 5 quiet seconds.
  - Only bridge-vouched turn keys may scope deltas.
  - Rule 1: every accepted `turn/start` needs `input.accepted{clientRequestId}`, otherwise the turn-start watchdog fires (rule 4). A zero-work prompt must still produce `turn.open` + `turn.boundary`.
  - Item/stream deltas never open a turn (rule 2).
  - `provider/recovery` or notifications naming a thread the process does not host are dropped (405–406). `thread/delta` is treated the same way (01 §2, protocol 404–406).
- What hosts a thread (VERIFIED):
  - `apps/host-daemon/src/command-dispatch.ts` 415–437:
    - `thread.start` (new thread);
    - `turn.submit` and `thread.goal.clear` → `ensureThreadRuntime`;
    - `thread.rename` only when a runtime entry already exists.
  - `apps/host-daemon/src/command-handlers/thread.ts` 179–212, 306–336: `resumeThreadRuntimeIfMissing` → `runtime.resumeThread` → bridge `thread/resume{providerThreadId}`.
  - `thread.goal.clear` requires a timeline Goal of the legacy Codex goal extension kind (`apps/server/src/routes/threads/actions.ts` 483–487; `thread-runtime-display.ts` 453–463). Not usable.
  - `thread.unarchive` uses a maintenance runtime, not hosting (command-dispatch.ts 491–505).
  - With the `resumeThreadsAfterRestart` experiment, bb also retries turns cut off by a daemon restart (`bb-guide-thread-lifecycle.md` 56–68). That is a turn too.
- Idle release (VERIFIED):
  - The daemon reaper uses the global app setting `idleProviderSessionTimeoutMinutes` ∈ {0,5,10,30,60}, default 30 (`packages/domain/src/app-settings.ts` 9–15, 79). It is not per provider.
  - It skips threads with open `backgroundTask`/`delegation` work: `packages/agent-runtime/src/runtime.ts` 2531–2554; `runtime-background-work-state.ts` 30–45.
- Keep-alive option (INFERRED, spike it, fragile):
  - `backgroundTask` items are thread-scoped: completion is emitted with `threadScope()` (delta-assembler 1501–1509).
  - `item.open` still needs an open turn (1364–1378). `turn.boundary` does not settle open items (1326–1361).
  - So a bridge could open a pending `backgroundTask` "Watching Hermes session" in a turn, end the turn, and stay hosted indefinitely (reaper skip).
  - Costs: a visible pending row and background-work UI; it blocks `restartRecommended` restarts (runtime.ts 1003–1010).
  - Use it only if per-message wake turns prove too noisy.
- Hosting without a user-visible turn: **none found** (VERIFIED by absence across `command-dispatch.ts` handlers and `ThreadsArea`).
  - Host RPC (`bb.hosts.experimental_client`) reaches the plugin's host *worker*, a separate process; the bridge "runs in its own process with its own lifecycle" (`$SK/bb-plugin-authoring/references/backend-foundation.md` 291–293).
  - The bridge `start()` gets `{pluginId, dataDir, tempDir}` (`$SDK/bb-plugin-sdk-provider-bridge.d.ts` 4032–4043). The worker and bridge could share a socket in `dataDir` (INFERRED that it is the same dir), but that only helps for already-hosted threads.
- **Recommended S2 wake:**
  1. Feed event arrives (companion plugin → our `bb.http` route, or server polling).
  2. Server: `threads.send({threadId, mode:"queue-if-active", input:[agentOnly(JSON{sync:{cursor}})], originPluginId:"hermes"})`. While a turn is already open the marker queues; while a held turn exists (`turn.mainRun idle`), `queue-if-active` is delivered as a steer (protocol 168–175).
  3. Bridge `turn/start`:
     - emit `input.accepted` + `turn.open`;
     - attach to the Hermes session as a viewer;
     - emit `input.provider` for the external user line, then agent text and tools;
     - emit `turn.boundary` when Hermes finishes.
  4. Server: `markRead` if the user does not want unread; set the notification level per thread.
  - Alternative if the thread is already hosted: the bridge opens its own turn on the feed event, with no send at all. That needs a bridge-side feed subscription (a WS from the bridge to the companion plugin) and an "already hosted" check.
  - Both paths should be in S2.

## 4. Notifications and concurrency

- Read state: `markRead`/`markUnread` (`$SDK/bb-plugin-sdk.d.ts` 18886–18887). VERIFIED.
- Notification level (`$SK/push-notifications/SKILL.md` 21, 44–50, 74–78), VERIFIED:
  - Levels `inherit|all|input-only|muted`; the thread level overrides `childLevel`/`defaultLevel`; ancestors cap children.
  - Set via `sdk.plugins.callRpc` `threadNotifications.set {threadId, level}`; read via `threadNotifications.list {threadIds≤200}`.
  - Hidden threads (`visibility !== "visible"`) never get turn-finished pushes (`sender.ts` 665).
- Concurrency (`plugins/concurrency-limit/server.ts` 524–560), VERIFIED:
  - Proceeds if `attempt === "join-turn"` or the thread is `active`/`starting`.
  - Otherwise compares `threads.listRunning()` with the global limit (null here) and the host limit.
  - Live status (`bb concurrency-limit status --json`): global unlimited; $HERMES_HOST auto 18, $BB_SERVER_HOST 4, $WORK_HOST 14.
  - INFERRED: a wake send can wait in line when $HERMES_HOST is busy, and mirror turns occupy slots for other work. Low risk at 18.

## 5. Isolated local bb for spikes

- Docs (VERIFIED, `docs/configuration.md`):
  - Startup flags ~1420: `npx bb-app --data-dir ~/.bb-test --server-port 48886 --host-daemon-port 48887`.
  - 1436–1438: "Use `--data-dir` for fully isolated instances."
  - 249–250: default ports 38886/38887. The server binds 127.0.0.1 by default and its API is unauthenticated.
  - 207–216: `--no-in-app-updates`; one launcher per data dir.
- Local state (VERIFIED, read-only):
  - This machine is **$HERMES_HOST**. The live daemon lives in `~/.bb-machines/$BB_SERVER_TS.$TAILNET/` on port 38888 (`host-daemon-port`).
  - `~/.bb/` already exists (`logs`, `pi-bridge-sessions`, `plugins`), so **don't use the default data dir**. `npm view bb-app` → latest 0.48.1.
- Proposed steps (INFERRED; not run, needs user OK to start processes):
  1. Fresh shell: `unset BB_SERVER_URL BB_HOST_DAEMON_PORT BB_THREAD_ID BB_ENVIRONMENT_ID BB_THREAD_STORAGE BB_PROJECT_ID BB_CLI BB_CLI_REEXEC`. This list is from `docs/debugging-and-qa.md` 436; all of these except `BB_CLI_REEXEC` are set in this shell.
  2. `BB_SKIP_ONBOARDING=1 npx bb-app@0.48.1 --data-dir ~/.bb-spike --server-port 48886 --host-daemon-port 48887 --no-in-app-updates`. This also starts a local host daemon (a second host on $HERMES_HOST, own dir and port).
  3. `export BB_SERVER_URL=http://127.0.0.1:48886`, then `bb machine list` (expect one local host) and `bb provider list`.
  4. `bb plugin install ~/src/bb-plugin-hermes --yes`, then `bb plugin dev ~/src/bb-plugin-hermes` (rebuilds server/app/host/bridge and reloads). Local paths work because the server is local (`bb plugin install --help`).
  5. Optional: record bridge wire traffic with `BB_PROVIDER_BRIDGE_RECORD_DIR=~/.bb-spike/recordings` on the launcher (configuration.md / debugging-and-qa.md 497–520). It is documented for `pnpm dev`; whether `bb-app` honors it is unverified.
  6. Tear down: Ctrl-C the launcher, then `rm -rf ~/.bb-spike` after review.
- Risks:
  - The isolated bb runs bundled plugins (keep-awake, browser-automation, provider CLIs) as the same OS user. Disable the ones the spike doesn't need.
  - The second daemon watches files and can launch Codex/Claude providers with the user's credentials.
  - The bridge on this daemon reaches Hermes's loopback gateway socket directly (Option B path) and the dashboard over the tailnet.
  - code-review-workspace's e2e uses the same pattern on 4331/4333 but documents no start command (`~/src/bb-plugin-code-review-workspace/docs/development.md` 42–74). It needs `bb-host-daemon join` under the test bb's HOME for a real machine (line 60). `bb-app` provides the local daemon itself (INFERRED).

## 6. external-agents review

- Provenance (VERIFIED):
  - The repo is a fork of `patleeman/bb-plugins`.
  - `gh api …/commits?path=packages/external-agents`: 14 commits, all by Patrick Lee, 2026-10-03.
  - No LICENSE in the repo or package; `licenseInfo: null`; the upstream license endpoint returns 404.
  - Icons only: MIT notices for the upstream marks (`icons/README.md`).
  - → **No license grant. Do not copy code**; reimplement or ask the author.
- Structure (`packages/external-agents`, 1862 lines total):
  - `server.ts` 1–61: settings; `providers.register` for `hermes`/`openclaw`/`dot`; `models.scope:"host"`; `env.passthrough` of the token env var (exposure risk, 01 G11).
  - `host.ts` 1–14: host-RPC health plus `export { experimental_providerBridge }`.
  - `src/bridge.ts` 1–108: per-thread router. Hermes → `createHermesBridge`; OpenClaw → re-exported `experimental_acpProviderBridge`.
  - `src/hermes-bridge.ts` 1–188 (Hermes API server `/v1/runs`, SSE events):
    - `initialize` caps: grammar v3, `sessionRestore`, `approvalEnforcedBy:"provider"`, `steerMode:"inject"`.
    - `thread/start|resume` → `thread/identity` + `session.reset`.
    - `turn/start` → `input.accepted` + `turn.open`.
    - Approvals → `interaction/request`.
    - Stop → `turn.boundary interrupted`.
  - `src/hermes-events.ts` 1–79: `HermesEventMapper` (`message.delta` → `item.textDelta`; `tool.started/completed` → `item.open/close` type `tool`; `run.*` → boundary/`provider.error`). `approvalPayload`/`approvalResponse` never widen beyond the offered choices.
  - `src/hermes-client.ts` 1–123: fetch with Bearer from an env or dotenv file; SSE reader.
  - Tests: `src/conformance.test.ts` 1–35 (in-process HTTP fixture → `experimental_runBridgeConformance`); `src/hermes-bridge.test.ts` (approve/steer/stop/resume); `scripts/hermes-fixture.mjs` 1–40 (loopback fake `/v1/runs` with an approval round-trip).
- Reusable as patterns:
  - mapper shape;
  - approval choice narrowing;
  - conformance plus fake-server test layout;
  - per-thread active-run guard.
- Outdated or wrong vs our design and 0.6.104:
  - Pins SDK `0.6.15`, `engines.bb >=0.45`. The import names still exist in 0.6.104 (`createBridgeIo`, `experimental_defineProviderBridge`, `*ParamsSchema`, `THREAD_DELTA_GRAMMAR_V3` all present in `$SDK/bb-plugin-sdk-provider-bridge.d.ts`; VERIFIED by grep).
  - Starts a run on `thread/start.input`, which the runtime never sends (adapter 283–291). That path is dead.
  - Ignores `visibility:"agent-only"`.
  - Rejects non-text input.
  - Mints a fresh `providerThreadId` (`bb-<uuid>`): it cannot bind to existing sessions.
  - No `input.provider`, no bridge-opened turns, no `thread.name`, no session options/profiles.
  - Uses the API-server transport, which can't attach to sessions owned by another client (03/06).
  - Tool items carry no call id; it pairs start/complete by name in FIFO order.
- Echo example (VERIFIED):
  - `get-bb/bb/examples/plugins/echo-provider/` (`src/provider-bridge.ts` 819 lines, `server.ts` 78).
  - Tests: `provider-bridge.conformance.test.ts` 67, `.stream.test.ts` 509, `.parity.test.ts` 210 with `recordings/echo-agent/turn-tools/*.ndjson`; README §"How it is proven".
  - Uses `workspace:*` SDK (main = 0.6.120). Pin 0.6.104 when copying patterns.
- Conformance kit (VERIFIED):
  - Public: `@get-bb/plugin-sdk/provider-bridge/testing` → `experimental_runBridgeConformance`, `experimental_formatConformanceReport`, `experimental_createBridgeJsonRpcTestHarness`, `experimental_createDeltaAssembler`, `experimental_replayRecording`, … (`$SDK/bb-plugin-sdk-provider-bridge-testing.d.ts` 5392).
  - Source: `get-bb/bb/packages/provider-bridge-protocol/src/conformance/{scenarios,client,recorded}.ts`, `src/testing/*`.
  - Scenario ids include `handshake/initialize`, `session/start-identity`, `session/resume-identity`, `session/resume-id-uniqueness`, `turn/lifecycle`, `turn/settles-without-activity`, `stop/interrupt-settles-before-result`, `stop/release-not-interrupted`, `events/schema-valid`, `item/opens-before-delta`.
  - There is no scenario for bridge-opened turns: write our own test with `experimental_createDeltaAssembler`.

## Spike design notes (derived)

- S1 import:
  1. Spawn with `title`, `pluginMetadata{profile,sessionId}`, a short `sendAt`, and input `[agentOnly(JSON bind)]`.
  2. The bridge's `turn/start` parses the marker, answers with `thread/identity{providerThreadId:"<profile>:<root>"}`, then `input.accepted` + `turn.open`.
  3. It replays history as `input.provider` + `agentMessage` + tool items, then `turn.boundary completed`.
  - Check:
    - no user bubble;
    - how the "System Message" cards look;
    - title kept;
    - after `bb thread stop` and a follow-up, `thread/resume` arrives with the same `providerThreadId`;
    - after a bb restart, the same.
- S2 mirror: the wake send above, plus a bridge-opened turn on an already-hosted thread. Measure the status flip, notification, unread, and concurrency hold. Try the `backgroundTask` keep-alive only if needed.
- S3 UX: `"installed"` + health `not_installed`. Check that the picker hides it, the thread page shows the profile `sessionOptions` (`category:"mode"`), and our `homepageSection` spawns with a fixed `environment` + `providerId`.

## Version check (desktop-v0.48.1 vs main)

- Unchanged:
  - `user-message-parsing.ts`;
  - `command-handlers/thread.ts`;
  - the visibility and `includeRequestedRegisteredProvider` logic (`execution-options.ts`; only the `preferCached` selection changed);
  - `IDLE_PROVIDER_SESSION_TIMEOUT_MINUTES`;
  - the send modes / `sendAt` / `pluginSubmission` schemas;
  - `GeneratedConversationMessage` "System Message".
- Changed, but outside the areas cited here:
  - `delta-assembler.ts` (+6, command `description`);
  - `provider-bridge-protocol.md` (+16, CLI status cache);
  - `runtime.ts` (±16);
  - `actions.ts` (+60/−13).
  - Line numbers above are main unless marked 0.48.1.

## Residual risks

- Nothing was run against a bb instance; every runtime claim is from source reading. UI rendering (System Message cards, hidden marker, picker hiding) needs eyes in S1/S3.
- I didn't trace the full server path from `threads.send` to the daemon `turn.submit` for agent-only filtering. Evidence that it's preserved: the adapter does not filter, and turn-retry relies on agent-only reaching the provider.
- Whether the bridge `start().dataDir` equals the host worker's `experimental_paths.dataDir` is unverified.
- Whether `bb-app` honours `BB_PROVIDER_BRIDGE_RECORD_DIR` and `BB_SKIP_ONBOARDING` the way `pnpm dev` does is unverified.
- The `backgroundTask` keep-alive relies on items outliving turns. That is implied by thread-scoped events and the Codex precedent; not tested.
- Temp clones are in `/tmp/spikeprep-bb` and `/tmp/spikeprep-ea` (read-only reference; safe to delete).

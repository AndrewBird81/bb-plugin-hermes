# 01 — bb Plugin SDK capabilities for a Hermes plugin

Scope: what the bb Plugin SDK can and cannot do for `bb-plugin-hermes`. Labels: **VERIFIED** = I read or ran it; **INFERRED** = my conclusion, not tested.

Versions (VERIFIED):
- bb CLI/server `0.48.1`. Host Plugin SDK `0.6.104`: `bb plugin types --check` in `~/src/bb-plugin-code-review-workspace` printed "pin is 0.6.104, host is 0.6.104".
- Types read from `~/src/bb-plugin-code-review-workspace/node_modules/@get-bb/plugin-sdk/bundled-types/*.d.ts` (0.6.104).
- Contract docs read from GitHub `get-bb/bb` main @ `d060de8e30f3` (2026-11-04). That checkout has `packages/plugin-sdk` at **0.6.120**, so the docs may be slightly ahead of the host.
- Skills dir: `~/.bb-machines/$BB_SERVER_TS.$TAILNET/runtime/global-skills/4ce0524d…/skills/` (abbreviated `$SK` below).

## Key answers

1. **Extension points**
   - Backend `bb.*`:
     - `settings` (including `secret: true`), `storage` (kv plus a SQLite database), `http` (`local`/`token`/`none` auth, plus WebSocket), `rpc`, `realtime`.
     - `background` (services, cron schedules), `events.on` (17 lifecycle events), `experimental_hooks` (`message.dispatch`).
     - `cli`, `agents` (tools, configure), `ui.requestInput`, `providers.register`, `experimental_environments.register`, `experimental_machines`, `hosts` (host RPC to a daemon), `sdk` (full bb SDK).
   - Frontend `app.slots.*`:
     - `navPanel`, `homepageSection`, `settingsSection`, `experimental_tab`, thread header/action/info/context-card slots.
     - `experimental_threadRowMetadata`, `experimental_threadList` (exclusive), `experimental_sidebarNavigation` (exclusive), `experimental_composer` (exclusive), `composer.customize`.
     - `pendingInteraction`, `experimental_providerIcon`, `experimental_timelineRenderer`, and others.
   - Host components: `ThreadChat`, `experimental_NewThreadComposer`, `experimental_ProviderModelPicker`.
   - Documented in `$SK/bb-plugin-authoring/references/*`; typed in `bb-plugin-sdk.d.ts` and `bb-plugin-sdk-app.d.ts` (VERIFIED).
2. **Agent-provider contract**
   - Yes: a plugin can register a full provider (`bb.providers.register`) and ship a **provider bridge**: line-delimited JSON-RPC (protocol v2, delta grammar v3) exported from the plugin's `bb.host` artifact.
   - It covers: streaming text and reasoning, tool items with status and presentation, approvals and user questions, plugin-defined interactions, plans, usage and context window, title (`thread.name`), slash commands, session options, model catalog, interrupt/steer, resume by `providerThreadId`, fork (`tip`/`checkpoint`), `/compact`, and archive/rename mirroring (VERIFIED).
   - The bridge **always runs in the host daemon on an enrolled machine** (the thread's environment host), never in the bb server (VERIFIED). It can still be a pure network client: `AndrewBird81/bb-plugins/packages/external-agents` already drives the Hermes HTTP API this way (VERIFIED).
   - No declaration field hides the machine picker or the provider picker (VERIFIED: no such field in the types).
3. **Hermes profile**
   - Best fit: a per-model `sessionOptions` select (`bb/session-options`), e.g. `{id:"profile", category:"mode"}`. The model picker shows it, and `category: "mode"` puts it in the composer footer (VERIFIED schema). Choosing it at thread creation is clean; changing it mid-thread means the bridge must replace the session (INFERRED).
   - Alternatives:
     - One model entry per profile×model (the OpenClaw `openclaw/<agentId>` precedent).
     - One registered provider per profile/bot.
     - A plugin-owned control in our own new-chat form.
4. **Thread APIs**
   - Available:
     - `bb.sdk.threads`: spawn, fork, update (title, section, parent, model, visibility), pin/unpin, archive/unarchive, delete, `markRead`/`markUnread`, pluginMetadata, timeline/events read.
     - Events: `thread.archived`, `thread.unarchived`, `thread.deleted`, `thread.created`, `thread.active`, `thread.idle`, `thread.failed`.
     - `thread:changed` realtime notifications.
   - Not available (VERIFIED): an "import/adopt an existing provider session" API; any API to write timeline history without a turn (spawn requires at least one input unless it is a fork); a pin event; per-thread icons (the icon is per provider); a settable `updatedAt`.
   - Home-page and sidebar status comes from bb's own runtime turn lifecycle plus pending interactions and read state. A plugin cannot set it directly (VERIFIED from the DTO fields; INFERRED that there is no write path).
5. **Project and environment**
   - Every thread needs a `projectId` and an environment on a machine (VERIFIED).
   - "Projectless" means the singleton **personal project** plus an environment provider declared `requires: { projectless: true }`, such as first-party `personal-workspace`.
   - Best fit for hosted Hermes: personal project plus a fixed environment (personal workspace, or our own projectless environment provider that returns a fixed path on one chosen host). The bridge ignores `cwd` (INFERRED design).
6. **Existing ACP Hermes provider**
   - `acp-hermes-agent` comes from the bundled `provider-acp` plugin: `hermes acp`, `visibility: "installed"`, fork `tip`, native reasoning via `reasoning_effort` (VERIFIED).
   - Machine binding is automatic wherever `hermes` is on PATH; it is listed on $HERMES_HOST with 9 models (VERIFIED).
   - The ACP bridge reads `loadSession` and `sessionCapabilities.{resume,list,close,delete,fork}`, and it handles permissions, modes, config options, `available_commands_update`, `usage_update`, and `session_info_update`→title (VERIFIED in the artifact).
   - `session/list` appears only in the method table: there is no discovery of external sessions (INFERRED). Replayed history is flagged `replay` and does not become bb timeline (INFERRED).
   - The launch `command` is arbitrary, so `ssh $HERMES_HOST hermes acp` or a stdio↔WebSocket wrapper can make it remote (INFERRED).
7. **Packaging and dev loop**
   - `package.json` `bb` block: `name`, `description`, `branding`, `server`, `app`, `host`, `skills`, plus `engines.bb` and `engines.bbPluginSdk`.
   - `bb plugin build` builds `dist/server.js`, `app.js`, and `host.js`. `bb plugin install <src>` then `bb plugin dev`. Tests use vitest with `@get-bb/plugin-sdk/testing` (`createFakePluginHost`), `/testing/app`, and `/provider-bridge/testing` (conformance and replay).
   - The user's plugins install from **git** (`conductor` from `git:…@deploy`, `code-review-workspace` from tag `v1.11.0`), because the server is remote (VERIFIED). A local path install would point at the server's filesystem (INFERRED).
8. **Hard gaps** (details under "Gaps and risks")
   - High: importing external sessions, backfilling history, and showing live external activity without a bb turn.
   - Medium: hiding the machine/provider pickers; a mandatory host and environment; history timestamps and sort order.
   - Low: per-thread icons, pin events.
   - Each has a workaround, listed below.

## 1. Extension points (where documented / typed)

Backend factory `export default async function plugin(bb: BbPluginApi)`, from `$SK/bb-plugin-authoring/references/backend-foundation.md` 1–37 (VERIFIED):
- `bb.settings.define`: string/number/boolean/select/project; `secret: true` is stored as a 0600 file and never reaches the db or frontend. Supports `experimental_schema` and `onChange`. backend-foundation.md 45–123.
- `bb.storage.kv` (256 KB per value) and `bb.storage.database()` (SQLite) with `migrate`. backend-foundation.md 125–143.
- `bb.hosts.experimental_client` is typed RPC from server to `bb.host` on a chosen `hostId`. Workers stop after 5 minutes idle, calls time out after 30 s, and host signals reach the server. backend-foundation.md 158–299.
- `bb.http.route` / `experimental_websocket` (auth `local` | `token` | `none`), `bb.rpc`, `bb.realtime`, `bb.background.service/schedule`. backend-events.md 342–500.
- `bb.events.on`: 17 events, including `thread.created/active/idle/failed/archived/unarchived/deleted`, `interaction.pending`, `turn.failed`, and `experimental_thread.events`. There are no pin or rename events. backend-events.md 3–23, 83–97.
- `bb.experimental_hooks.on("message.dispatch")` can proceed, wait, or reject every message, but cannot rewrite it. backend-events.md 129–216.
- `bb.experimental_environments.register` (environment providers). backend-events.md 218–341.
- `bb.providers.register`, `experimental_contributeEnv`, `experimental_contributeEnvHealth`. providers.md 1–170.
- `bb.cli`, `bb.ui.requestInput`, `bb.agents.configure/registerTool`, `bb.experimental_aiServices`. backend-cli-agents.md 3, 130, 162, 253.
- `bb.ui`, `bb.status`, `bb.onInstall`, `bb.onDispose`. backend-ui-lifecycle.md.
- `bb.sdk.*` areas (threads, threadSections, projects, environments, hosts, providers, plugins, system, `subscribe`). backend-sdk.md 16–88. Types: `bb-plugin-sdk.d.ts` 18821–18950 (`ThreadsArea`), 18027–18035 (realtime map).

Frontend (`bb.app`, `definePluginApp`), typed in `bb-plugin-sdk-app.d.ts` 22052–22107 (VERIFIED):
- Pages and settings: `navPanel` (owns `/plugins/<id>/<path>/*`), `homepageSection` (`{projectId|null}`), `settingsSection` (below the declarative settings form). frontend-core-slots.md 63–98.
- Sidebar: `experimental_threadList` (exclusive replacement of the sidebar list, app d.ts 20944–20961), `experimental_sidebarNavigation` (exclusive), `sidebarFooterAction`, `experimental_threadRowMetadata`. Row metadata needs the `threadRowMetadata` experiment and a user toggle (frontend-thread-row-metadata.md 3–9).
- Thread surfaces: `experimental_threadAction` (thread menu), header button, `experimental_threadInfoRow/Section`, `experimental_threadContextCardRow/Section`, `experimental_tab`. frontend-registration.md 149–233.
- Composer: `composer.customize` (actions, `plusMenu`, `sendMenu`, banners, popups, richText). frontend-hooks-and-ui.md ~191–233. It cannot hide pickers (VERIFIED: the registration has no picker fields). `experimental_composer` replaces bb's whole composer box; it is exclusive and global (app d.ts 21053–21083).
- Rendering: `pendingInteraction` (plugin-defined interaction forms), `experimental_timelineRenderer`, `messageAction`, `experimental_providerIcon`, `fileOpener`, renderers.
- Host components: `ThreadChat` (`{threadId, variant, permissionPolicy, …}`); `experimental_NewThreadComposer`, whose `default*` props are seeds only and which always shows project, environment, and machine controls; `experimental_ProviderModelPicker` (`allowProviderChange={false}`). frontend-components.md 5–75, 226–257.

## 2. Agent-provider contract

Declaration: `PluginProviderDeclaration`, `bb-plugin-sdk.d.ts` 20580–20766; docs `docs/provider-plugin-api.md` §1 lines 48–216 (VERIFIED).
- Fields: `id`, `displayName`, `family`, `icon` (SVG path / glyph / `<pluginId>/<name>`), `strings`, `capabilities`, `maintenance {health, usage, installation}`, `reasoningLevels`, `serviceTiers`, `composerActions` (`plan`/`goal`), `completedTurnDisplay`, `extensionKinds`, `models {fallback, scope: host|workspace}`, `env.passthrough`, `experimental_bridgeOptions`, `experimental_visibility`, native skill/command roots, `deriveProviderOptions(ctx)`.
- `capabilities`: `permissionModes`, `fork`, `supportsNativeUserQuestion`, `supportsManualCompaction`, `supportsThreadArchive`, `supportsThreadRename`, `supportsServiceTier`.
- `deriveProviderOptions(ctx)` is synchronous and receives `{threadId, projectId, model, permissionMode, promptMode?, settings}` (non-secret settings only). It does **not** receive pluginMetadata. d.ts 20518–20545.
- A declaration in a plugin without `bb.host` is refused. d.ts 20575–20579.

Bridge (`experimental_providerBridge` export of `bb.host`), from `docs/provider-plugin-api.md` §2 218–292 and `docs/provider-bridge-protocol.md` (VERIFIED):
- Where it runs:
  - The daemon's bootstrap owns the process; there is one process per provider artifact (protocol.md 19–30; api.md 228–235).
  - Artifacts are content-addressed; the host daemon downloads and runs them with its own node. There is no server-side provider path (api.md 476–486).
  - **So provider code executes on the thread's host machine.**
- Handshake facts: `sessionRestore`, `threadArchive`, `threadRename`, `threadGoalClear`, `fork`, `approvalEnforcedBy`, `steerMode`, `skills.configure`, `grammarVersions [3,3]`. api.md 237–252; protocol.md 48–79.
- Runtime→bridge: `initialize`, `model/list`, `thread/{start,resume,fork,stop,discard,archive,unarchive,name/set,goal/clear}`, `turn/{start,steer}`, `skills/configure`, `commands/list`, `provider/{health,usage,installation/*}`. api.md 255–259.
- `thread/start` params include `cwd` (required string), `input`, `options`, `dynamicTools`, and `instructionMode`. `thread/resume` adds `providerThreadId`. `bb-plugin-sdk-provider-bridge.d.ts` 4511–4700.
- Bridge→runtime: `thread/delta`, `thread/identity`, `session/replaced`, `provider/recovery`, `provider/raw`, `error`, plus requests `item/tool/call` (bb-injected tools) and `interaction/request`. api.md 272–275.
- Delta kinds (d.ts 2291+):
  - Text: `item.textDelta/textClose` with channels `agentMessage|reasoningText|reasoningSummary|plan`.
  - Items: `item.open/close/progress/outputDelta`.
  - Turns and input: `turn.open/boundary/mainRun`, `input.accepted`, **`input.provider`**.
  - Usage and context: `usage`, `contextWindow` (cost, snapshot), `context.compacted/cleared`.
  - Titles and state: `thread.name`, `extension.state` (`bb/provider-commands`, `bb/session-options`, `bb/provider-model-catalog`).
  - Errors and sessions: `provider.error/warning/rateLimits/modelFallback`, `session.reset/ended`.
- Item kinds: message, reasoning, plan, command, fileChange, fileRead, search, webSearch, webFetch, imageView, imageGeneration, backgroundTask, delegation, planSteps, compaction, tool, plus `"<pluginId>/<name>"` extensions with declarative `presentation`. api.md 294–366.
- Interactions (api.md 368–425):
  - Approvals: `command`, `file_change`, `tool_use`, `permission_grant`; permission modes auto-decide them.
  - Requests: `userQuestion`, `planReview`, and `"<pluginId>/<kind>"` rendered by our `pendingInteraction` slot.
- Turn rules (protocol.md 445–510):
  - `thread/stop {interrupt|release}` must settle everything before it responds.
  - The bridge **may open turns the user did not start** ("provider-internal activity") with its own `turn.open`.
  - `input.provider` adds a `userMessage` item inside the open turn (assembler `packages/provider-bridge-protocol/src/assembler/delta-assembler.ts` 1290–1308, VERIFIED). This is how externally sent (Telegram) user messages could render.
- Sessions (protocol.md 423–443, 546–576):
  - `providerThreadId` is durable, and bb resumes with it after restarts.
  - bb refuses a handle that another thread announced first. Two bb threads cannot share one Hermes session.
- Recovery kinds: `authRequired`, `rateLimited`, `restartRecommended`, `sessionArchived`, `staleTurn`. protocol.md 371–421.
- Compaction is a `/compact` prompt gated by `supportsManualCompaction`; there is no compact method. protocol.md 130–134.
- Attachments: prompt input types are `text`/`image`/`localImage`/`localFile` (`createThreadRequestSchema` d.ts 12503+). The bridge decides what to forward.
- Idle release: bb releases an idle runtime after 30 minutes (`bb guide thread-lifecycle` lines 54–55, VERIFIED). Notifications naming a thread the process does not host are dropped (protocol.md 404–406).
- Machine independence: none at the process level. Practically, the bridge can talk HTTP to the Hermes dashboard from any host on the tailnet ($BB_SERVER_HOST, $HERMES_HOST, $WORK_HOST are enrolled; `bb machine list`, VERIFIED).
  - Precedent: `external-agents` `server.ts` 43–55 registers `hermes` with `models.scope:"host"` and an HTTP client.
  - `src/hermes-bridge.ts` 38–80 maps Hermes `/v1/runs` events to deltas and approvals to `interaction/request` (VERIFIED; written against SDK 0.6.15 and BB 0.45).
- Picker control:
  - The **provider picker** lists every enabled provider; order and default come from user settings (api.md 203–206). `bb provider disable` hides one provider globally.
  - The **machine picker** is part of the New Thread composer environment row.
  - No declaration field or `composer.customize` option hides either one for Hermes (VERIFIED: absent from the types).
  - Workaround: our own `navPanel` or `homepageSection` "New Hermes chat" form calls `sdk.threads.spawn({providerId, environment, projectId})`; opened chats render via `ThreadChat` or the normal thread page.

Testing kit: `@get-bb/plugin-sdk/provider-bridge/testing` (`experimental_runBridgeConformance`, replay/parity) and the echo-provider example. providers.md 245–282.

## 3. Representing a Hermes profile

Options, recommended first:
1. **`bb/session-options` select `profile`, declared per model in `model/list` `sessionOptions`** (VERIFIED schema: `packages/domain/src/thread-session-option.ts` 1–34; `id`, `label`, `category`, `type: select`, `values[{id,label,group}]` ≤ 1000).
   - Spawn takes `sessionOptions: {profile: "x"}`; the CLI form is `bb thread spawn --option profile=x`.
   - `category: "mode"` shows it in the composer footer (protocol.md 285–309).
   - Mid-thread change: the bridge replaces the session and emits `session/replaced` (INFERRED). Better to lock it after the first turn.
2. Model ids namespaced by profile (`<profile>/<model>`), like `openclaw/<agentId>` in external-agents README. Simple, but it multiplies the catalog.
3. One provider registration per profile or bot (`family: "hermes"`). This gives a separate picker tab and icon per bot, which fits "a dedicated chat per bot". Cost: clutters the global provider picker.
4. A plugin control in our own new-chat form, persisted in pluginMetadata and fed to the bridge (only `deriveProviderOptions` reaches the bridge, and it sees `threadId` only, so the plugin must keep a sync `threadId→profile` cache) (INFERRED).

## 4. Thread APIs for plugins

VERIFIED from `bb-plugin-sdk.d.ts` 18821–18950 and backend-sdk.md 20–34, 101–110, 138–262:
- Create: `threads.spawn(CreateThreadRequest)` takes `projectId`, `environment`, `providerId`, `model`, `sessionOptions`, `title`, `pinned`, `sectionId`, `visibility` (`visible|hidden`), `pluginMetadata`, `parentThreadId`, `sendAt`, `pluginSubmission`.
  - `input` must be non-empty unless `originKind` is `fork` (server-contract `packages/server-contract/src/api/threads.ts` 131–217).
  - With `sendAt`, the thread is created `pending` with no turn and no environment work (same file, 162–169).
- Idle fork without a run: `threads.fork` plus `agentContextSeed` ("Persist agent-only context without a first run", `bb guide threads`).
- Prompt input `visibility: "agent-only"` exists (`packages/domain/src/shared-types.ts` 99–104). It can carry a hidden sentinel.
- Mutate: `update` (title, sectionId, parentThreadId, model, reasoningLevel, visibility), `pin`, `unpin`, `reorderPinned`, `archive`, `archiveAll`, `unarchive`, `delete`, `markRead`, `markUnread`, `stop`, `send` (`auto|queue|steer`), `experimental_regenerateTitle`.
- `threadSections.create/update/delete` give a "Hermes" section.
- pluginMetadata namespace per thread (≤ 256 KiB; it is not an auth boundary). `experimental_listPluginMetadata` reads it for up to 200 threads.
- React to the user:
  - Events: `thread.archived`, `thread.unarchived`, `thread.deleted`.
  - Rename and pin have no event; use `sdk.subscribe({event:"thread:changed"})` and diff (INFERRED).
  - With `supportsThreadArchive` and `supportsThreadRename`, bb also forwards `thread/archive|unarchive|name/set` to the bridge (api.md 237–252). When that happens with no live runtime is unverified (INFERRED).
- Icons and badges:
  - The provider icon (`icon`, `experimental_providerIcon`) shows for every thread of that provider.
  - Per-thread badges need `experimental_threadRowMetadata` (experiment-gated) or our own `experimental_threadList`.
  - Thread origin is attributed `origin: "plugin"`, `originPluginId`.
- Home and sidebar status: the thread DTO carries `status`, `hasPendingInteraction`, `queuedWork`, `lastReadAt`, `latestAttentionAt`, `pinnedAt`, `updatedAt` (d.ts ~5200–5225). These are server-derived from runtime turns and interactions. **Progress shows only while bb runs a turn on the thread.**
- History backfill: no write API. The only path is the bridge emitting deltas during a turn: `input.provider` for user lines, `agentMessage` and tool items for replies, inside a bridge-opened turn (INFERRED technique; individual pieces VERIFIED).

## 5. Projects, environments, personal workspace

- `projectId` is required on create (threads.ts 133). Projects default to ordinary ones; `bb.sdk.projects.list({includePersonal:true})` returns the singleton **personal project** (backend-sdk.md 12–14, VERIFIED).
- Environment choices: `reuse`, `host` (unmanaged path / managed-worktree / personal), `project-default`, `provider` (`environmentProviderId` plus optional machine) (d.ts 12503–12545, VERIFIED).
- Environment providers: `requires: { projectless: true }` offers a provider only outside projects; every provider runs on the selected machine (backend-events.md 218–260, VERIFIED). The first-party `personal-workspace` is projectless (`bb environment providers`, VERIFIED).
- For hosted Hermes: personal project plus either the `personal-workspace` env on one fixed host, or a small plugin environment provider `hermes` (projectless). Its `create` returns a fixed path with `ownsPath:false`, and `policy.retireGraceMs: null`.
- Bridge host: $HERMES_HOST co-locates with Hermes. $BB_SERVER_HOST is always on and reaches the dashboard over the tailnet (INFERRED tradeoff).

## 6. Existing ACP Hermes provider (`acp-hermes-agent`)

- Definition: `get-bb/bb` `plugins/provider-acp/src/known-agents.ts` 179–200 (VERIFIED).
  - `command: "hermes", args: ["acp"]`, `visibility: "installed"` (listed only where its health check finds `hermes`), `fork: "tip"`.
  - `nativeReasoning.configId: "reasoning_effort"`, levels none→max, signIn `hermes login`, and a Hermes native-roots resolver.
- Live on $HERMES_HOST (VERIFIED: `bb provider list --machine $HERMES_HOST --json`):
  - pluginId `provider-acp`, `permissionModes [accept-edits, full]`, `supportsFork true`, `supportsThreadArchive false`, `supportsThreadRename false`.
  - `serviceTiers default|fast`, `modelCatalogScope host`, maintenance `health` only.
- Models (VERIFIED: `bb provider models acp-hermes-agent --machine $HERMES_HOST --json`): 9 models (openai-codex ×4, claude-subscription-directsdk ×4, `custom:mlx-main`). Each has session option `edit_approval_policy` (select, 3 values), and reasoning discovery is `known`.
- ACP feature use, read from the running artifact `plugin-host-artifacts/provider-acp/cd118a84…/host.mjs` (minified; VERIFIED by string inspection):
  - Parses agent caps `loadSession` and `sessionCapabilities.{resume,list,close,delete,fork,additionalDirectories}`.
  - Handles `session/request_permission`, `session/set_mode`, `session/set_config_option`, `session/set_model`, `session/cancel`, and `fs/*` and `terminal/*` client methods.
  - Updates handled: `available_commands_update` (slash commands), `current_mode_update`, `config_option_update`, `usage_update` (context and cost), `plan`, and `session_info_update` (title → `thread.name`, source agent).
  - Events carry a `replay` flag during load; replayed history does not become new bb rows (INFERRED).
  - `session/list` appears only in the method table: no discovery or import of external sessions (INFERRED).
- Questions: there is no native ACP question handler; agents use the `AskUserQuestion` plugin tool (`$SK/acp-provider/SKILL.md` 76–80, VERIFIED).
- Custom ACP agents: `bb plugin config provider-acp set customAgents '[...]'` with `id`, `command`, `args`, `env`, `cwd`, `modelCli`, `nativeReasoning`, `permissionCli`, `dialect`. The id `hermes-agent` **replaces** the shipped agent (`$SK/acp-provider/SKILL.md` 141–165, VERIFIED).
- Remote ACP: the command is arbitrary (`acpLaunchSpecSchema`, `bb-plugin-sdk-provider-bridge-acp.d.ts` 472–526). A wrapper (`ssh $HERMES_HOST hermes acp`, or a stdio↔WebSocket bridge to a companion Hermes plugin) works in principle (INFERRED). A plugin can also reuse the kit by re-exporting `experimental_acpProviderBridge` and registering its own dialect (acp d.ts 530–598, VERIFIED).
- Limits for our goals: every session the ACP agent runs is spawned by bb, so gateway, cron, and CLI sessions are never seen. There is also one `hermes acp` child per bridge on a single machine (INFERRED).

## 7. Packaging and dev loop

- Manifest (`$SK/…/quickstart.md` 18–122): package `name` `bb-plugin-hermes` → plugin id `hermes`.
  - `bb.name`, `bb.description`, `bb.branding.icon` (+ `experimental_icons`), `bb.server` (required), `bb.app`, `bb.host` (Node 22 ESM; holds the bridge), `bb.skills`, `bb.themes`, `engines.bb`, `engines.bbPluginSdk`.
- Dependencies: a provider plugin lists `@get-bb/plugin-sdk` under **`dependencies`**, because the host bundle imports `/provider-bridge` (backend-foundation.md 309–321; providers.md 201–208). Runtime packages bb shims are type-only devDependencies (quickstart.md 164–175).
- Build: `bb plugin build` emits `dist/server.js`, `app.js`/`app.css`, `host.js` and `*.meta.json`. Git installs run `npm install --omit=dev --omit=optional --ignore-scripts` and then build on the server (quickstart.md 134–181).
- Install and iterate:
  - Docs: `bb plugin install .`, `bb plugin dev` (rebuild and reload), `bb plugin reload`, `bb plugin logs <id> -f` (testing.md 222–239).
  - This setup: the server is remote (`$BB_SERVER_TS.$TAILNET`), and the user's plugins install from git — `conductor` from `git:github.com/AndrewBird81/bb-plugin-conductor@deploy`, `code-review-workspace` from tag `v1.11.0` (`bb plugin list`/`source`, VERIFIED).
  - Likely loop: push a branch, then `bb plugin update hermes` (or reinstall `@branch`). `bb plugin dev` needs the directory visible to the server (INFERRED).
- Tests in the user's plugins (VERIFIED):
  - vitest with `npm run check`.
  - Conductor (`package.json` 61–66): `@get-bb/plugin-sdk/testing` and `/testing/app` (`test/server.test.ts`, `test/app.test.tsx`), plus `test/packaging.test.ts`.
  - Code Review Workspace (`package.json` 63–69): `check` = test, typecheck, lint, `bb plugin types --check`, build. It snapshots registrations, runs Playwright e2e against an isolated local bb (`docs/development.md` 7–66), and has an engines test.
- external-agents tests: `src/conformance.test.ts`, `src/hermes-bridge.test.ts`, and a `scripts/hermes-fixture.mjs` fake server. These are a template for us (VERIFIED: file list).

## Gaps and risks

| # | Gap | Severity | Workaround |
|---|-----|----------|-----------|
| G1 | No API to create a thread bound to an existing external session, or to write history without a turn. Spawn needs input (threads.ts 205–211). | High | (a) Spawn with an `agent-only` sentinel input plus pluginMetadata `{hermesSessionId}`, optionally with `sendAt` so the plugin can cache `threadId→session` first. `deriveProviderOptions(ctx.threadId)` passes the binding; on `thread/start` the bridge binds (`providerThreadId` = Hermes session id) and replays history as one bridge-opened turn (`input.provider` + agent messages), without prompting Hermes. (b) Idle fork from a template thread + `agentContextSeed` (unclear if the bridge sees the binding). Both need a spike. |
| G2 | Live external activity (Telegram, cron) shows only while the bridge hosts the thread; idle runtimes are released after 30 minutes; notifications for threads the bridge does not host are dropped. | High | Companion Hermes plugin → POST to our `bb.http` `auth:"token"` route (or the server plugin polls the dashboard) → `threads.send` with an agent-only "sync" sentinel → the bridge emits the new external turns. Costs: each sync is a bb turn (status flips active→idle, unread/attention, notifications, concurrency limits, prompt history may show the sentinel). Or keep the session from being reaped by holding an open `backgroundTask` item (fragile; INFERRED). |
| G3 | Imported or backfilled events get "now" timestamps; `createdAt` and `updatedAt` cannot be set, so sort order is wrong for old sessions. | Medium | Import lazily (recent sessions only), and show original times inside message text or an extension row. |
| G4 | Cannot hide the machine picker or provider tabs in bb's New Thread composer or per provider; customizations cannot remove pickers. | Medium | Our own `navPanel`/`homepageSection` new-chat UI → `sdk.threads.spawn` with a fixed provider, env, and host, then `ThreadChat`. The exclusive `experimental_composer` replacement is global and heavy (not recommended). |
| G5 | Every thread needs a project and an environment on an enrolled host; the bridge runs on that host. | Medium | Personal project plus a projectless env pinned to one host. The bridge is a pure HTTP/WS client of the dashboard (external-agents precedent). Hermes chats become unavailable while that host is offline. |
| G6 | One Hermes session maps to at most one bb thread (handle uniqueness). | Medium | Archive or delete the old bb thread before rebinding; keep a plugin-side map. |
| G7 | bb-injected tools (`dynamicTools`, `bb thread tell/spawn` via agent tools) only work if the bridge exposes them to Hermes and answers `item/tool/call`. external-agents does not. | Medium | Map them to Hermes tool calls via the companion plugin (MCP or tool bridge), or accept no bb tools inside Hermes. User→thread `bb thread tell` works regardless, as a normal turn (INFERRED). |
| G8 | No pin or rename events; row badges need an experiment flag; icons are per provider only. | Low | `sdk.subscribe thread:changed`; provider icon = Hermes logo; per-bot identity via separate providers or sections. |
| G9 | Profile change mid-session. | Low | Lock the profile after creation, or emit `session/replaced`. |
| G10 | SDK drift: docs read at 0.6.120 (main), host is 0.6.104. Many members are `experimental_`. | Low | Pin to the host SDK with `bb plugin types`; re-read the bundled `.d.ts`. |
| G11 | `provider.env-resolved` events show contributed env values verbatim. | Security | Never pass the dashboard token via `experimental_contributeEnv`. Use a secret setting read on the server and handed over host RPC, or a token file on the host. |

Residual risks:
- I did not run any bridge, spawn, or import experiment. G1 and G2 techniques are INFERRED from the docs and assembler source.
- I did not inspect bb app behaviour for provider handoff on existing threads.

## Open questions for the user

1. Which machine should host the Hermes bridge: $HERMES_HOST (co-located, sleeps?) or $BB_SERVER_HOST (always on, reaches the dashboard over the tailnet)?
2. Import scope: all historical Hermes sessions, or only new and recent ones (e.g. the last N days)? This changes the cost of G1 and G3.
3. Is a short bb "sync turn" per external message acceptable (status flicker, unread badge, notifications)? Or should external sessions be read-only mirrors in a plugin page until opened?
4. Should Hermes threads get bb tools (`bb thread spawn/tell` from inside Hermes)? That needs tool bridging in the companion Hermes plugin.
5. Is a "bot" a Hermes profile, a gateway platform identity, or both? This decides between a per-bot provider registration and a profile session option.
6. Keep `acp-hermes-agent` enabled beside the new provider, or disable it (`bb provider disable acp-hermes-agent`) to avoid two Hermes entries in the picker?

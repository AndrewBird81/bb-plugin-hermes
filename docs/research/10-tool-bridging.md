## Key answers

Labels: **V** = I read it in source or docs (cited). **I** = inferred, not tested. Read-only; nothing ran.
Sources: Hermes `~/.hermes/hermes-agent` @ c314285f07, Conduit `~/.hermes/plugins/conduit_push`, SDK 0.6.104, `get-bb/bb` main via `gh api` (paths below are repo paths).

- **Hermes already has per-session, client-supplied tools: "editor MCP".** A `session.create` / `session.resume` with `source: "acp"` and `editor.mcp_servers: [...]` gives one session its own MCP tool overlay. Each session has its own schema manifest, and the manifest is frozen at turn boundaries. This is the mechanism bb's ACP provider uses today to put its `dynamicTools` into Hermes (V, see Q2). **It is the cleanest per-session path, but it only works for sessions with `source=acp`.**
- **Plugin `register_tool` is per profile, not per session.** The schema is static per name, the `check_fn` takes no arguments, and the tool list is memoized per toolset fingerprint. A plugin tool appears in every session of that profile (and by default on every platform) unless it is gated. Handlers get `session_id`/`task_id` and run on a worker thread. They may block for up to ~420 s by default (V, Q1).
- **Routes and tools can share in-process state only under the gateway's listener (option E, or the gateway's private listener).** Even then, sharing needs a deliberate process-global handle. The plugin is imported once per profile (`hermes_plugins.<slug>` plus `__home_<digest>` copies), and the dashboard API is imported separately as `hermes_dashboard_plugin_<name>`. Under a standalone `hermes dashboard`, routes and tools are in different processes (V, Q3).
- **What bb injects per thread:**
  - `update_environment_directory` (always);
  - `AskUserQuestion` (only if the provider lacks `supportsNativeUserQuestion`);
  - `bb_workflow_run` (normal threads); `bb_workflow_result` (workflow-worker threads, with per-thread `parameters`);
  - any other installed plugin's `bb.agents.registerTool`.
  - **Not injected:** browser automation and thread spawn/tell. Agents use the `bb` CLI plus skills for those (V, Q4).
- **Wire shapes:**
  - Request: `item/tool/call {providerThreadId, threadId?, turnId|null, callId, tool, arguments}`.
  - Response: `{success, contentItems:[{type:"inputText",text}|{imageUrl:<data URL>}]}`.
  - No runtime timeout. Cancelled by `notifications/cancelled {requestId}`, by turn completion or by thread stop.
  - **Needs an active bb turn**, otherwise it errors (V, Q4).
- **Recommendation: B1 (editor MCP served by the bridge) for bb-created sessions, plus `supportsNativeUserQuestion: true` (Hermes `clarify` → bb user question).** That covers every bb-created session with zero Python for tools. Imported Discord/cron/Bot Chat sessions get no bb tools at first. Fallback B2 (Python plugin tools + relay) only if those sessions must have bb tools, or if `source=acp` costs are unacceptable (Q5).

## Q1. Hermes plugin tool API

- **Registration**: `ctx.register_tool(name, toolset, schema, handler, check_fn=None, requires_env=None, is_async=False, description="", emoji="", override=False)` (V `hermes_cli/plugins.py:462-500`).
  - Schema is OpenAI function format: `{name, description, parameters: <JSON Schema object>}`. A non-dict `parameters` is rejected at registration (V `tools/registry.py:735-760`).
  - Shadowing a built-in or another toolset's name is **rejected** unless `override=True` and `plugins.entries.<id>.allow_tool_override: true` (V `plugins.py:466-483`, `registry.py:766-799`).
  - `execution_timeout` exists on `registry.register` but **not on `ctx.register_tool`** (V `registry.py:740` vs `plugins.py:463-466`).
- **Conduit precedent**: `conduit_health` = `{"name","toolset":"conduit","schema","handler","check_fn":available}`. The handler is `handler(args, session_id=None, **_) -> str`, and registration tries `description`/`emoji` first, then falls back on `TypeError` (V `health_tool.py:24-26,85-101`). Conduit registers ~12 tools in the same pattern (`phone_tool.py:209-228`, `call_tool.py:77-87`, …).
- **Scope**: plugin registrations land in the **profile's** registry slot (`scope = self._manager.scope_key`, V `plugins.py:478-487`; slots `registry.py:519-537`). Each profile's `config.yaml` must enable the plugin. Today only the default profile enables `conduit_push`; alex, david and neo don't (V, configs).
- **Per-session enablement**:
  - **Not available to plugins.** `check_fn` is called as `fn()` with no arguments and its result is cached per profile scope for ~30 s (V `registry.py:346-350,377-442`).
  - `get_tool_definitions` is memoized by enabled/disabled toolsets (V `model_tools.py:228-270`).
  - New plugin toolsets are **on by default for every platform** (cli, discord, …) unless listed in `known_plugin_toolsets` (V `hermes_cli/tools_config.py:520-527`; `known_plugin_toolsets` is absent from `~/.hermes/config.yaml`).
- **Execution**:
  - The model loop calls `registry.dispatch(name, args, task_id=, session_id=, user_task=)`. Kwargs are filtered to the handler's signature, so **`tool_call_id` is not passed** (V `model_tools.py:835-852`, `registry.py:972-985`).
  - `tool_call_id` and `turn_id` are available in the `pre_tool_call` hook (V `plugins.py:1922-1926`).
  - Sequential calls run on a `DaemonThreadPoolExecutor` worker thread (V `agent/tool_executor.py:894-950`). An `is_async` handler runs via `_run_async`, which uses a fresh thread and event loop when called under a running loop (V `model_tools.py:95-125`).
  - Gateway turns run in-process on gateway threads (V `gateway/turn_executor.py:1-14,69`; "now the turn runs here", `gateway/session_policy.py:1150-1160`).
- **Timeouts**:
  - Per call: `timeouts.tools.sequential_call`, which defaults to the concurrent-batch deadline `timeouts.tools.concurrent_batch` = **420 s** (V `tool_executor.py:138,189-198,838-845`). `0` disables it.
  - It can be extended only via the entry's `execution_timeout` (V `agent/tool_dispatch_helpers.py:107-114`).
  - Exempt tools: `delegate_task`, `manage_connections` (`tool_executor.py:856`). `clarify` runs inline with its own timeout (`tool_dispatch_helpers.py:30`, `tool_executor.py:905-909`).
- **Results and errors**:
  - The handler returns a `str` (usually JSON) or `{"_multimodal": True, "content": [...]}`. Anything else becomes a `tool_result_contract` error (V `registry.py:955-970`).
  - Exceptions become `{"error": "Tool execution failed: …"}`, sanitized and capped at 2048 chars (V `registry.py:986-1002`, `:51`). Helpers: `tool_error()` and `tool_result()` (V `registry.py:1101-1110`).
- **Blocking on an external reply**: allowed. The handler sits on a worker thread, so a WebSocket round trip to the bridge is fine up to ~420 s (I). On interrupt, the runner gives the worker 3 s, then abandons it with "[Tool execution cancelled …]" (V `tool_executor.py:941-960`). The handler should poll `tools.interrupt.is_interrupted()` (V `tools/interrupt.py:57`) and send a cancel to bb.

## Q2. Per-session dynamic tools in Hermes

Ranked best first.

1. **Editor MCP (session-local MCP overlay)**. V `gateway/session_local_mcp.py`:
   - **Create**: `session.create` accepts `editor` (`CREATE_FIELDS`, V `session_policy.py:15-19`). `validate_editor` **refuses unless `source == "acp"`** (V `session_local_editor.py:9-34`).
     - At most 16 servers, 64 KiB, stdio/http/sse specs validated against the ACP schema (V `session_local_mcp.py:41-70`).
     - Nothing restricts *which client* may send `source: "acp"`; only the `session:create` capability is checked (V `gateway/session_local.py:275-305`; I: no other gate seen).
   - **Mechanics**:
     - Per-session ledger scope `editor-session:<sha(profile:sid)>`; tool names become `mcp__editor_<server>_<tag>__<tool>` (V `:98-110`).
     - Schemas are discovered once and frozen into the session policy (prompt-cache prefix). They are re-frozen at turn admission if the server's `tools/list` drifted (V `:1-12,233-261,397-436`). A change announces `session.tools_changed` (V `:325-330`).
     - The overlay is applied via `tools.registry.session_tool_scope` during the execution (V `:183-216,500-512`; `registry.py:27-47,532-537`).
     - Connections are held while the session has a viewer and closed after the last viewer leaves (V `:145-230`).
     - Transport specs live only in owner memory; only a fingerprint is durable. **After a gateway restart the client must resupply the exact spec on `session.resume{editor}`** (V `:1-8,282-299`).
     - Changing the list = `session.mutate editor_mcp` while idle (V `:333-346`).
   - **Timeouts**:
     - `_configs` sets `connect_timeout=5, tool_timeout=30, lazy=False` (V `:128-141`).
     - But the MCP call timeout resolver reads `config["timeout"]`, then `timeouts.mcp.tool_call`, then 300 s (V `tools/mcp_tool_common.py:44-58`).
     - **I:** the effective editor tool timeout is 300 s, or 30 s if `tool_timeout` is honoured elsewhere (`tools/mcp_tool.py:357-363`). Spike it.
   - **Costs of `source=acp`**:
     - ACP rows never end and stay out of prune/archive (V `gateway/session_acp_lifecycle.py:1-5`).
     - Toolsets come from `platform_toolsets.acp` (V `session_policy.py:679-684`).
     - The edit-approval requester is installed with policy `ask` forced at create (V `session_local_editor.py:26-28,69-75`). **I:** every file edit asks.
     - The surface reads as `acp`, which collides with 09-M6 dedupe (`created_source=acp`).
   - **Coverage**: only sessions bb creates. Discord, cron and Bot Chat rows can't get it, because their source isn't `acp`.
   - **Precedent**: bb `packages/provider-bridge-acp/src/bridge/tool-proxy-mcp.ts` (server `bb-bridge`, stdio MCP that dials the bridge over loopback TCP with a token; 15 s progress heartbeat; `notifications/cancelled`). Hermes ACP forwards it as `editor.mcp_servers` (V `acp_adapter/gateway_server.py:374`).
2. **Explicit `toolsets` on `session.create`**:
   - It can only narrow the profile's `cli`/`acp` platform set, and refuses anything outside it (V `session_policy.py:652-691`).
   - Useful to *exclude* a plugin `bb` toolset from non-bb sessions. It cannot *add* tools or schemas per session.
3. **Plugin tools with a session gate in the handler**:
   - The tool is visible to every session of the profile. The handler returns `tool_error("not attached to bb")` when `session_id` has no bb binding.
   - Static schemas per name, so per-thread schemas such as `bb_workflow_result.parameters` are not representable (I).
4. **Global `mcp_servers` in config.yaml**: per profile, not per session; needs a config edit. Rejected.
5. **Calling `session_tool_scope` / `registry.register(scope=…)` directly from a plugin**: private API. Rejected.

## Q3. Shared state: dashboard plugin route ↔ tool handlers

- **Same process only under the gateway's listener**:
  - `gateway/run_api.py` mounts the full dashboard app inside the gateway (lazy on first request), with `session_authority` and `gateway_runner` set (V `run_api.py:1-13,44-110`). This holds for the Webapp listener and the private ephemeral one alike.
  - Under `hermes dashboard` (:9119) the plugin routes run in the dashboard process. Conduit detects this via `sys.modules["gateway.run_api"]._ACTIVE_RUNNER is None` (V `conduit_push/dashboard/api/core.py:449-451`).
  - So with option E, routes and tools share a process. On :9119 they do not.
- **Separate module instances even in-process**:
  - The general plugin is imported per profile scope as `hermes_plugins.<slug>`, plus `…__home_<digest>` for other profiles (V `hermes_cli/plugins_loader.py:789-798`).
  - The dashboard API is imported once by path as `hermes_dashboard_plugin_<name>` (V `hermes_cli/web_server_dashboard.py:1226-1246`).
  - Conduit loads its own files a third time as `conduit_push_dashboard_pkg` and shares through disk stores (V `core.py:338-356`).
  - → Module globals are **not** shared. Use one explicit process-global registry, e.g. a `sys.modules["bb_bridge_shared"]` module created idempotently, holding `{binding → ws connection, pending calls}` (I).
- **Isolation that breaks it**:
  - `plugins.isolation: host` moves general plugins to a plugin-host child per profile and refuses in-process dashboard plugin APIs (V `hermes_cli/plugin_isolation.py:1-12`; `web_server_dashboard.py:1198-1201`). It is not set in `~/.hermes/config.yaml` (V). This mode would break B2 and B1b.
  - Plugin WebSockets bypass the HTTP auth gate; they must call `_ws_auth_ok` themselves (09-M4).
  - Plugin routes on `?profile=` return 501 since v0.22.3 (V `conduit_push/upstream/contract.yml:59-62,119-125`). → One socket, profile carried in messages; never `?profile=`.
  - Plugin HTTP routes run under `_plugin_route_secret_scope` (the launch profile's scope, V `web_server_dashboard.py:995-1007`). Relaying a tool call needs no secrets (I).
- **Loop**: route handlers run on the gateway loop and tool handlers on worker threads. Cross over with `asyncio.run_coroutine_threadsafe(…, runner._gateway_loop)` plus `future.result(timeout)` (I; Conduit uses `runner._gateway_loop`, contract.yml note).

## Q4. bb side

- **Injection**: the server resolves `dynamicTools` per thread at runtime-config time:
  - the built-in `update_environment_directory` (always);
  - plus `listPluginAgentTools()` filtered by each plugin's `bb.agents.configure(context)`.
  - Tool `instructions` are appended to the thread instructions.
  - (V `apps/server/src/services/threads/thread-runtime-config.ts:85-106,215-240`; `thread-environment-directory.ts:27-28`.)
  - They are sent on `thread/start`, `thread/resume` and `thread/fork` as `{name, description, inputSchema, presentation?}` (V SDK `bb-plugin-sdk-provider-bridge.d.ts:1559-1589,4505-4530`).
- **Registered agent tools in `get-bb/bb`** (`gh search registerTool`):
  - `AskUserQuestion`: suppressed when `context.provider.capabilities.supportsNativeUserQuestion`. Waits 30 min–7 days via `bb.ui.requestInput` (V `plugins/ask-user-question/src/server.ts:16-25,53-60,131-138`).
  - `bb_workflow_run` (normal threads) and `bb_workflow_result` (worker threads, per-thread `parameters`) (V `plugins/workflows/src/server.ts:151-246`). Both lean on the `bb workflows …` CLI and `$BB_THREAD_STORAGE`.
  - Third-party plugins can add more (SDK `registerTool`, `bb-plugin-sdk.d.ts:20298-20320,20799-20805`; names `[a-zA-Z0-9_-]+`, unique, not reserved).
  - **I:** the exact list for a Hermes thread depends on the installed plugins; log it at `thread/start` in a spike.
- **Not injected tools**:
  - Browser automation is `bb browser-automation` CLI plus skill (V `global-skills/.../browser-automation/SKILL.md:1-8`).
  - Thread spawn/tell/wait are `bb thread …` CLI (V `bb-cli/SKILL.md:75-85`).
  - `plugins/mcp` is an MCP server for *external* clients that wraps the bb CLI (`search`/`read`/`run`), not a dynamic tool (V `plugins/mcp/src/mcp-handler.ts:11-19,52-120`).
  - → For Hermes to use those, its terminal tool needs `bb` on PATH with thread env. Out of scope here.
- **Request and response**:
  - `BridgeToolCallRequest {jsonrpc, id, method:"item/tool/call", params:{providerThreadId, threadId?, turnId|null, callId, tool, arguments}}` (V SDK d.ts:1711-1724).
  - The runtime resolves the thread, then `turnId ?? activeTurn`. With neither it **errors "Cannot route provider tool call … no active turn"** (V `packages/agent-runtime/src/runtime-provider-requests.ts:148-167,170-235`).
  - Result `{success, contentItems}`; the SDK decodes it to `{content, contentBlocks, images, isError}` (V SDK `dist/provider-bridge.js:3641-3671`, d.ts:1746-1763).
  - No per-call timeout in the runtime. Pending calls are cancelled on `turn/completed` for that turn, on thread stop, or on bridge `notifications/cancelled {requestId}` (V `runtime.ts:1265-1290`; `bridge-kit/provider-tool-call-contract.ts`).
  - The SDK helper `createPendingToolCallTracker` handles correlation (d.ts:1835-1862).
  - Presentation: stamp the definition's `presentation` and `server:"bb"` on `item.open`/`item.close` for the call (V `docs/provider-bridge-protocol.md:269-274`). The `callId` should equal the id on those deltas (`:151-160`).
- **How existing providers expose them** (V, `gh` source):
  - claude-code: in-process SDK MCP server `bb-bridge` → `mcp__bb-bridge__<name>` (`plugins/provider-claude-code/src/bridge/tool-proxy-mcp.ts:31-70`).
  - codex: **native** app-server `dynamicTools` (`plugins/provider-codex/src/bridge/bridge.ts:1340-1354`).
  - pi: **native** `pi.registerTool` via a bb extension (`plugins/provider-pi/src/bridge/bb-pi-extension.ts:301`).
  - provider-acp: a stdio MCP proxy in `session/new.mcpServers` (`packages/provider-bridge-acp/src/bridge/bridge.ts:584-600,2454`).

## Q5. Proposed design (fewest moving parts)

**B1. Editor MCP served by the bb bridge (recommended for bb-created sessions).**
- Bridge `thread/start`:
  - `session.create{profile, source:"acp", editor:{mcp_servers:[{type:"http", name:"bb", url:<bridge MCP URL>, headers:[{name:"Authorization", value:"Bearer <per-thread random>"}]}]}}`.
  - `thread/resume`: `session.resume{editor:<same spec>}` (required after a gateway restart).
- MCP endpoint in the TypeScript bridge (Streamable HTTP):
  - `tools/list` = the thread's `dynamicTools` (`inputSchema` passes through as-is).
  - `tools/call` → `item/tool/call` via `createPendingToolCallTracker`; send progress heartbeats; MCP cancel → `notifications/cancelled`.
  - `contentItems` → MCP `content` (text and image).
- When the `dynamicTools` change, call `session.mutate editor_mcp` while idle, or rely on the turn-admission re-freeze (V Q2).
- Event mapping: Hermes tool events named `mcp__editor_bb_<tag>__X` → render as the bb tool `X` with its presentation; callId = Hermes `tool_call_id`.
- Hermes-side code: **none** for tools. The gateway dials the URL. That works on loopback when the bridge host is $HERMES_HOST. If the bridge is on $BB_SERVER_HOST, the gateway needs tailnet reachability to a bridge port (I).
- Variant B1b: the MCP endpoint is a plugin HTTP route on the gateway listener relaying over the bridge's WebSocket. Use only if the gateway can't reach the bridge. It adds the shared-registry work from Q3 and needs a check of plugin-route auth for a non-browser MCP client (I).

**Also**: declare `supportsNativeUserQuestion: true` and map Hermes `clarify` to a bb user-question interaction. This removes `AskUserQuestion` (whose hours-long wait would hit Hermes' 300/420 s ceilings) (V auq.ts:131-138). Keep Hermes' own approvals mapped to bb approval interactions (draft 00).

**B2. Fallback: Python plugin tools plus relay** (only if imported sessions need bb tools, or `source=acp` is rejected):
- A fixed `bb` toolset of `bb__<name>` tools (or one generic `bb_tool{tool, arguments}`) registered per profile. Each handler looks up `session_id → binding` in a process-global registry, sends `{call_id, tool, args}` over the bridge's authenticated plugin WebSocket, and blocks on a `concurrent.futures.Future`.
- Exclude the toolset from Discord and other platforms with `hermes tools disable` (writes `known_plugin_toolsets`, V tools_config.py:520-527). Pass explicit `toolsets` on non-bb creates.
- Costs:
  - Python to maintain; static schemas (I);
  - the plugin must be enabled in every profile;
  - tools are visible but useless in unbound sessions;
  - breaks under `plugins.isolation: host`.

**Failure modes and their handling**

| Case | B1 | B2 |
|---|---|---|
| Bridge disconnects mid-call | MCP HTTP call errors → the model sees an error result. The bb runtime cancels the pending call when the turn ends or the thread stops. A late answer is dropped. | Handler Future times out or the socket closes → `tool_error("bb bridge disconnected")`. |
| Bridge reconnects or the gateway restarts | Resume must resend the exact editor spec; otherwise the turn fails `launch_credentials_unavailable` (V :500-512). | Re-register the binding on reconnect. |
| Hermes call with no bb turn open (Discord or cron turn on a bound session) | Runtime errors "no active turn" (V). The bridge should open a mirror turn first, or answer with an error. | Same. |
| Interrupt or steer | Hermes abandons the worker after 3 s (V). The bridge sends `notifications/cancelled`; the plugin's `ctx.signal` aborts. | Same, plus polling `is_interrupted()`. |
| Approvals | bb tools carry no bb approval. A Hermes `pre_tool_call` hook can return "approve" to force a Hermes approval, which maps to a bb approval (V plugins.py:1915-1930). Default: none. | Same. |
| Name collisions | Namespaced by Hermes as `mcp__editor_…__X` (V :103-110). No clash with built-ins. | `bb__` prefix. A bare `AskUserQuestion`-style name is rejected if it would shadow a built-in (V registry.py:766-799). |
| Several bb threads on different profiles | The scope key includes `profile_id:sid` (V :98-101). Bindings are per thread/token. | Per-profile module copies → one process-global registry keyed by `(profile, session_id)` (V loader, I design). |
| bb tool instructions or skills | `session.create` has no instructions field (V CREATE_FIELDS). They must ride the first `prompt.submit` or a skill (I). | Same. |
| Timeouts | Editor MCP: 300 s or 30 s (spike). Long waits exceed it; mitigated by native clarify. | 420 s default; `execution_timeout` is not exposed through ctx. |

## Spikes / open questions

- T1: a non-ACP client creates `source:"acp"` with `editor.mcp_servers` http over canonical `session.create`. Confirm it is accepted and tools appear as `mcp__editor_bb_<tag>__*`.
- T2: measure the effective editor MCP tool timeout (30 s vs 300 s), and whether progress notifications extend it.
- T3: find out what else `source=acp` changes for a bb chat: edit approvals per write, toolset set, row lifecycle, visibility in Desktop/Conduit, and the 09-M6 dedupe interplay.
- T4: dump `dynamicTools` + `instructions` that bb sends on `thread/start` for a Hermes thread on this server.
- T5: bb clarify mapping: Hermes `clarify` → bb user-question → `clarify.respond`, including its timeout.
- User decision: are bb tools required in imported Discord/cron/Bot Chat sessions? Yes → B2 (or B1 + B2). No → B1 only.

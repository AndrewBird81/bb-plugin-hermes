# 11 — Hermes profiles, models, bot metadata, bb-tools plugin, echo, handoff (H2)

Ground truth: `~/.hermes/hermes-agent` @ `c314285f07`; live gateway pid 63362 (unchanged).
Read-only round, 2026-11-04: canonical **reads** over the local socket (`model.options`, `profiles.list`, `profiles.get_asset`, `profiles.describe`), dashboard REST GETs, `sqlite3 -readonly`. No prompts, no sessions created, no config edits, no Discord.

**V** = VERIFIED (observed live, or read from files/DB). **C** = CODE (read in source, not exercised).

## Key answers

1. **Models:** fetch per profile with canonical `model.options{profile}`. It works on our host socket and is not listed in `x-canonical-methods`.
   - `session.create` doesn't check that a model or provider exists. A bad pick fails on the first turn, not at create.
   - `bb-models.json` is a hide-list plus labels for the default profile only.
2. **Bots:** every live profile is a Desktop Bot Mode bot. Bot metadata lives in `profile.yaml` `ui_meta['hermes-bots']`. Fetch avatars with canonical `profiles.get_asset{name}`, which returns a data URL.
3. **Bot Chat:** the logical id is stable. Compaction adds a physical segment row, but `session.resume`/`session.list{title}` keep returning the root id. No Bot Chat has been compacted yet. The id changes only if the chat is deleted or re-minted, or its title is displaced.
4. **Discord echo is feasible with public plugin API:** a `pre_llm_call` hook calls `ctx.post_message()`, which routes to `adapter.send` for the Discord chat. Recognising a bb turn needs one private contextvar, or a bridge-written registry.
5. **bb-tools plugin:**
   - It needs a per-profile install and enable.
   - Handlers see the gateway's env: `bb` is on PATH, but there is no `BB_SERVER_URL`/`BB_THREAD_ID`, so they must be injected per call.
   - Map handlers to bb threads by `HERMES_SESSION_CHAT_ID`/`HERMES_SESSION_KEY`, not the `session_id` kwarg.
   - Code reloads via the `reload-plugins` control verb, without a restart.
6. **cwd:** `session.create{cwd}` sets the terminal cwd and the base for relative file paths. It must be an existing absolute directory. Without one, the default is the profile's `terminal.cwd`, else the gateway's cwd (`~/.hermes`). Change it later with `session.mutate workspace`.
7. **Handoff:** there is no native cross-profile continue. Create a new session in the target profile and seed it with one visible first prompt: a handoff block plus the user's message.
8. **`sessions.changed`:** a DB-row signature watcher, 0.5 s poll with a 2 s floor. It covers any writer to a **watched** `state.db`. Sibling profiles are watched only once the process has served a legacy profile-scoped call for them (C), so bb should also stat sibling DBs itself.

## 1. Per-profile models (V unless marked)

How to fetch:
- **Canonical:** `model.options{profile:"<name>"}` on the host-scoped socket.
  - Timings: default 15.5 s cold (provider catalog fetch), siblings ~100 ms.
  - Handler: `gateway/session_config.py:214-237`. Flags `explicit_only|include_unconfigured|refresh` (bool).
  - `refresh:true` busts a per-provider model-id disk cache (C). I didn't use it, because it writes.
- **REST twin:** `GET /api/model/options?profile=<name>` returns the same shape (`providers, model, provider`; V 200 for alex).
- Result row: `{slug, name, is_current, is_user_defined, models[], total_models, source, authenticated, capabilities{<model>:{fast,reasoning,ultrafast?,can_disable_reasoning?}}, featured_models}`.
- **Don't use `profiles.list` for models:** on the canonical socket, sibling rows report `model:""`, `provider:""`, `skill_count:0`. REST `GET /api/profiles` gives the right `model`/`provider`.

Observed (authenticated providers → model count; ✱ = current default):

| profile | default | providers |
|---|---|---|
| default | `gpt-6.1-terra` / `openai-codex` | `nous` 69 · `openai-codex`✱ 15 · `claude-subscription-directsdk-experimental` 8 · `mlx-main` 1 |
| alex | `mlx_main` / `mlx-main` | `anthropic` 14 · `openai-codex` 15 · `mlx-main`✱ 1 |
| david | `mlx_main` / `mlx-main` | `anthropic` 14 · `openai-codex` 15 · `mlx-main`✱ 1 · `ollama` 0 |
| neo | `gpt-6.1-sol` / `openai-codex` | `anthropic` 14 · `openai-codex`✱ 15 |

Observations:
- The Claude subscription provider exists only in default, because only default enables that plugin. The other profiles use `anthropic` (API key).
- alex and david's `openai-codex` list is **stale**: it lacks `gpt-6.1-*` and `gpt-6-astra`, which default and neo have. This is a per-profile cache; refresh would fix it.

Reasoning options:
- Accepted values: `none` plus `VALID_REASONING_EFFORTS = minimal, low, medium, high, xhigh, max, ultra` (C `hermes_constants.py:1073-1100`).
- ACP offers `default` plus all of these (C `acp_adapter/gateway_session_meta.py:75-99`). `default` means "use the profile's level".
- Per-route wire clamp (C `agent/reasoning_effort.py:25-42,104-171`):
  - Codex `gpt-6-sol`/`gpt-6-luna`/`gpt-5.6`: `none, low…max`.
  - `gpt-6.1-sol`/`gpt-6-astra`: `low…max` (can't disable).
  - Others: `none, minimal…max`.
  - Unsupported levels clamp to the nearest weaker level, never escalate.
- `capabilities[model].reasoning` and `can_disable_reasoning` tell bb whether to show the picker and the `none` option.

`session.create` per profile (C, `gateway/session_policy.py:425-648`):
- It accepts `model`, `provider`, `base_url`, `reasoning`, `service_tier` under the target profile's config.
- Validation is **shape only**:
  - empty `model` → `invalid_params{field:"model"}`;
  - bad `reasoning` → `invalid_params{field:"reasoning", detail:"not a known effort level: 'x'"}`;
  - bad `service_tier` or `base_url` are refused the same way.
- An unknown **model id or provider name is accepted**. A provider pick drops the profile's route-bound keys.
- The failure comes on the first turn, when the runtime resolves:
  - `AuthError("Unknown provider '<x>'.", code="invalid_provider")` (`hermes_cli/auth.py:1640`);
  - or a no-credentials reply. On a LOCAL session the turn text is `⚠️ <resolver sentence>` (`gateway/run_turn_runner.py:160-183`).
- So bb must validate picks against `model.options` itself.
- Later changes:
  - `session.mutate model{model, provider?, reasoning?, confirm?}` / `reasoning{effort}` while idle (`expected_generation` required, `_POLICY`).
  - Or a one-turn `prompt.submit{model_override}`.

Comparison with `~/src/hermes-host/config/bb-models.json` (V):
- It holds a `hidden_models` list (`provider:model`) and `provider_labels` (`openai-codex`→Codex, `claude-subscription…`→"Claude Sub", `anthropic`→API, `custom:mlx-main`→MLX). It is not a model list.
- Problems:
  - It keys MLX as `custom:mlx-main`. `model.options` reports the slug `mlx-main`, while `session.info.provider` reports `custom:mlx-main` (seen in S4b).
  - Normalise both spellings.
  - Several hidden ids no longer exist (e.g. `claude-opus-4-7`, `claude-opus-4-6` under the subscription provider).
  - It reflects the default profile only (the ACP wrapper has no profile flag, 03 §2a).
- Recommendation: build bb's picker per profile from `model.options`, then apply bb-models.json's hide list and labels as a display layer.

## 2. Profile and bot metadata (V)

| field | source | default | alex | david | neo | todoist |
|---|---|---|---|---|---|---|
| `display_name` | REST `/api/profiles` | "" | "" | "" | "" | "" |
| `description` | REST / `profiles.describe` | "" | "" | "" | "" | "" |
| Bot Mode title (`bot_title`) | REST, from `ui_meta['hermes-bots'].title` | "" | "" | "" | "" | "" |
| `ui_meta['hermes-bots']` | `profile.yaml` | `{chat:<Bot Chat id>}` | — | `{shape, color, imageKind:"shape", title:"", custom}` | — | — |
| avatar | `profiles.get_asset{name, asset:"avatar"}` | png 3157 B | png 3296 B | png 2521 B | **none** | png 3778 B |
| Bot Chat | `profiles.list` `canonical_session` | `$HERMES_SESSION_02` | `$HERMES_SESSION_20` | `$HERMES_SESSION_01` | `$HERMES_SESSION_36` | `$HERMES_SESSION_03` |

- **Names:** none is set anywhere. bb should display the handle:
  - the folder name, with `default` shown as `hermes` while no profile is named `hermes` (C `tools/bot_mode_probe.py:_handle`);
  - or `display_name` → `bot_title` → handle, if set later.
  - Canonical `profiles.list` sets `display_name` to the folder name for siblings. Don't treat that as a user-set name.
- **Avatars:**
  - `profiles.get_asset{name}` on the canonical socket → `{found, mime, size, data:"data:image/png;base64,…"}` (found:false if absent).
  - `name` is required (`profile` → error `name required`).
  - Files live at `<home>/assets/avatar.{png,jpg,webp}`. There is no REST route.
  - Canonical `profiles.list` sets `has_avatar` on the default row only, so don't rely on it.
  - When there's no avatar, `ui_meta['hermes-bots'].shape/color` describes Desktop's generated "blobatar".
- **More detail:** `profiles.describe{name}` → `{name, description, soul (SOUL.md text), model{provider,default}, skills, toolsets, toolsets_pinned, mcp_servers}`.
  - REST `/api/profiles` adds `gateway_running`, `distribution_*` (alex, david and neo come from `~/src/hermes-config/profiles/*`) and `has_alias`.
- **Which profiles are bots:**
  - Desktop's roster is **every live profile** (`_roster`: default plus `profiles/*` that pass `named_profile_is_live`; C `bot_mode_probe.py:83-100`).
  - Hiding is per-bot `ui_meta['hermes-bots'].hidden` (C `apps/desktop/src/plugins/hermes-bots/hidden-bots.ts:25`). None is hidden today, including todoist.
  - Every profile has a Bot Chat. bb should apply its own "todoist hidden" rule.

## 3. Bot Chat lineage

- **Identity rule** (C `hermes_state_titles.py:203-220`): the canonical Bot Chat is the row titled exactly `Bot Chat`. Unlike other titles, a `Bot Chat #N` row never wins.
- Resolve the current one with either call. Both resolve server-side and return the logical id (V shapes):
  - `session.list{profile, title:"Bot Chat", include_hidden:true}` → `{session_id, id (root), resolved_id}`;
  - `profiles.list` → `canonical_session{id, resolved_id}`.
- **What compaction does:**
  - Desktop rewrites `/new` and `/reset` in a Bot Chat to `/compact` (C `apps/desktop/src/plugins/hermes-bots/plugin.tsx:772-800`, "This chat never resets").
  - Compaction ends the current physical segment (`end_reason='compression'`) and writes a child row whose `chat_id` is the logical owner (C `hermes_state_local.py:270-282`).
  - `session.resume` of any segment returns the owner, via `resolve_local_target` → `chat_id` (C `session_local_migration.py:52-73`).
  - Today every Bot Chat has `chat_id == id` (V sqlite). So **the id bb binds stays the root across compactions**; only `resolved_id`/the physical tip moves.
  - V: no Bot Chat in any profile has been compacted yet, so the end-to-end shape is untested.
- **When the id really changes** (C `gateway/session_bot.py:186-380`; `api_server_bot_chat.py`):
  - the Bot Chat is deleted and re-minted (`hermes chat -c "Bot Chat" --create-if-missing`, Desktop's first open);
  - an API conversation holding the title is displaced, so the title moves to a new local row;
  - a rename away from `Bot Chat`.
- **Events:**
  - Manual compact (`session.mutate compress`): `session.updated` (result payload) on the session stream (C `session_mutations.py:333-335`).
  - Auto-compression in a turn: just more `session.info`/`session.usage` on the same id.
  - Either way the DB row changes, so `sessions.changed` fires (§8).
  - Plugins get `post_compaction{session_id, old_session_id, …}` (C `agent/compaction_events.py:239`).
  - No event says the Bot Chat id rotated. On `sessions.changed`, re-run the title lookup per profile and rebind if `session_id` differs.

## 4. Discord echo ("$OWNER_NAME (via bb): …" before the bot reply) — C

Path:
1. bb calls `prompt.submit{session_id, text, submission_id, turn_author:{id:"bb:<bb-user>", name:"$OWNER_NAME"}}`.
   - `turn_author` is committed in `cli_turn_v1` for any session (`gateway/session_cli_turn.py:25-34`; `session_authority.py:714-742`).
   - Because uid:501 isn't the Discord user, the row also gets `local_operator_v1` (viewer input).
2. The drain runs on the Discord route.
   - `session_ingress.execute_admission` sets `admission_author` from `cli_turn_v1.turn_author` (`session_ingress.py:265-275,325-326`).
   - The turn binds `HERMES_SESSION_*` contextvars, including the route key (`_set_session_env`: `run_turn_prepare.py:657`, `run.py:3959-3985`).
   - The agent thread reads `admission_author` itself (`run_turn_runner.py:991-996`), so the context reaches it.
3. The agent fires **`pre_llm_call`** once per user turn, before the first model call (`agent/turn_context.py:849-873`). Kwargs: `session_id, task_id, turn_id, user_message, platform ("discord"), sender_id, model, is_first_turn, conversation_history, parent_session_id`.
4. In that hook, **`ctx.post_message(text)`** is a public `PluginContext` API (`hermes_cli/plugins.py:378`):
   - `plugin_messages.post` reads `bound_session_key()`;
   - `gateway/plugin_messages.resolve` → `runner._delivery_adapter_for(source)` → **`adapter.send(chat_id, text, metadata=thread)`** on the gateway loop (`gateway/plugin_messages.py:1-13,90-115`);
   - it blocks the agent thread for ≤ 30 s.
   - The reply streams only after that, so the echo lands first. Discord's stream consumer opens its message on the first delta (`run_turn_runner.py:258-308`).
5. Gates on `post_message`:
   - the session's profile must be the plugin's own profile (`_plugin_messaging_session_owned`), so the plugin must be enabled in **every profile with a Discord bot** (default, alex, david, neo);
   - no extra config flag.
   - Not `platform_actions` (that one is off by default and only adds reactions/titles).

Sketch (`bb_tools/__init__.py`):

```python
def register(ctx):
    def _bb_author():
        # Private, tiny: the admission author the gateway itself passes to run_conversation.
        try:
            from gateway.session_ingress import admission_author
        except ImportError:
            return None
        author = admission_author.get()
        return author if isinstance(author, dict) and str(author.get("id") or "").startswith("bb:") else None

    def pre_llm_call(platform="", user_message=None, **_):
        if platform in ("", "local", "cli", "tui", "desktop", "acp", "api_server"):
            return None
        author = _bb_author()
        if author is None or not isinstance(user_message, str):
            return None
        name = author.get("name") or "bb"
        ctx.post_message(f"**{name}** (via bb): {user_message}")   # adapter clamps to the chat's limit
        return None                                                  # inject nothing

    ctx.register_hook("pre_llm_call", pre_llm_call)
```

Fallback without the private import:
1. The bridge writes `{session_key, sha256(text), expires}` to `<home>/bb_tools/echo.json` **before** submitting.
2. The hook matches on `bound_session_key()` (via `hermes_cli.plugin_session.session_key()`) and the hash of `user_message`.
- Feature-detect `admission_author`, as Conduit does with `inspect.signature`.

Risks (C/I):
- The echo is a bot-authored message. The Discord adapter ignores its own messages (I), so it shouldn't loop back.
- It isn't in the Hermes transcript, which is what we want.
- The reply's `reply_to` is the admission id, not a Discord message id (`initial_reply_to_id=event_message_id`). Discord may reject that reference, or the adapter may drop it (unknown, 08 §4).
- `pre_llm_call` also fires for non-bb Discord turns; the author check is the filter.
- A turn the drain cancels before its first model call posts no echo.
- Precedent: Conduit registers `pre_llm_call` but never posts to platforms (V grep). In-tree platform plugins (`plugins/platforms/*`) use `post_message`.

## 5. bb-tools plugin (C unless marked)

- **Layout** (Conduit and alex's `vault-sync` are precedents, V):

  ```
  <profile home>/plugins/bb_tools/
    plugin.yaml   # name: bb_tools, manifest_version: 1, version, kind: standalone, provides_tools: [bb_…], provides_hooks: [pre_llm_call]
    __init__.py   # def register(ctx): ctx.register_tool(name, toolset="bb", schema, handler, check_fn=None, description=, emoji=)
  ```

  - Handler signature: `handler(args: dict, session_id=None, task_id=None, **_) -> str`. Kwargs are filtered to what the handler accepts (`tools/registry.py:972-985`). Run the CLI with `subprocess.run([...], env=…, timeout=…)`.
- **Per-profile:**
  - Each profile has its own `plugins/` directory and `plugins.enabled` (V: alex has 4 plugins, david 1, neo 0, root 4).
  - Install or symlink into all four homes, and add `bb_tools` to each profile's `plugins.enabled`. This is a config change; the user must approve it.
  - The toolset `bb` is on by default for every platform (Discord included) unless listed in `known_plugin_toolsets` (10 Q1).
  - To keep bb tools out of Discord turns: `hermes -p <p> tools disable bb --platform discord`, or `check_fn`. `check_fn` takes no args, so it can't gate per session.
- **Env inside the gateway (V `ps -E` names, values not printed):**
  - PATH includes `~/.local/bin`, which holds the `bb` shim → `~/.bb-machines/$BB_SERVER_TS…/npm/bin/bb`. So `bb` resolves.
  - **No `BB_*` vars** in the gateway env: no `BB_SERVER_URL`, `BB_THREAD_ID` or `BB_HOST_DAEMON_PORT`.
  - Without them the CLI targets `http://127.0.0.1:38886`, which isn't listening on $HERMES_HOST (V). The host daemon is on `127.0.0.1:38888` (V).
  - **Handlers must build the env per call:** `BB_SERVER_URL`, `BB_HOST_DAEMON_PORT`, `BB_THREAD_ID`, `BB_PROJECT_ID`, `BB_ENVIRONMENT_ID`, from the binding below.
  - Never put them in the gateway env, because it is shared by all sessions and profiles.
  - The gateway env also carries dashboard secrets. Pass `env={minimal}`, not `os.environ`.
- **Session id → bb thread:**
  - The `session_id` kwarg is `agent.session_id`, the **physical** segment. It changes on compaction.
  - Turn context gives the stable keys: `gateway.session_context.get_session_env("HERMES_SESSION_CHAT_ID" | "HERMES_SESSION_KEY" | "HERMES_SESSION_PROFILE")`.
    - Local sessions: `chat_id` = the logical id (`local-…` for bb-created ones), key `agent:<ns>:local:dm:<id>` (V REST row in S4).
    - Discord: the route key.
  - Options:
    1. **Recommended:** a binding file written only by the bridge, `<root>/bb_tools/bindings.json`.
       - Content: `{ "<profile-home>|<logical id>": {thread_id, project_id, environment_id, server_url, daemon_port, expires} }`.
       - The handler resolves the logical id from `HERMES_SESSION_CHAT_ID` (local) or the session key (messaging).
       - Same host, no network. The bridge rewrites the file on bind, unbind and rotation.
    2. Map from the physical `session_id` via the DB (`chat_id` column, or the compression lineage root). More code, same result.
    3. `session.create{client_env}`. It only carries PATH and toolchain names, plus `terminal.client_env_passthrough` (a config change), and reaches only terminal subprocesses, not in-process handlers. Rejected.
  - Without a binding (an unbound Discord or cron session), return `tool_error("not attached to a bb thread")`.
- **Timeouts:** sequential calls are bounded at **420 s** by default (`timeouts.tools.sequential_call` → `concurrent_batch`; 10 Q1). On interrupt the worker is abandoned after 3 s. Keep the subprocess timeout below 420 s and poll `tools.interrupt.is_interrupted()` for long calls.
- **Install and reload without a gateway restart:**
  - `hermes -p <p> plugins enable bb_tools` sends the control verb `reload-plugins`.
  - That runs `discover_plugins(force=True)`, which **unloads, evicts `sys.modules`, and re-imports** (`plugins.py:1203-1240,1544-1558`; `run_plugin_rewire.py:82-122`), so code edits are picked up too.
  - Hooks are live at once. **Tools appear in the next session** (prompt-cache invariant, `plugins_activation.py:1-67`).
  - The bridge can send `reload-plugins{home}` over `gateway.sock` itself, but it reloads **all** of that profile's plugins (Conduit included).
  - A new Python dependency needs a restart (`restart_required`).

## 6. cwd (projects)

- **Default when `cwd` is omitted** (C `session_policy.py:443-445`; `agent/runtime_cwd.py:105`):
  - `resolve_agent_cwd()` runs under the target profile's owner scope.
  - That gives the profile's `terminal.cwd` (V config): default `~/src`, alex `~/Documents/$OBSIDIAN_VAULT`, neo `~`.
  - david has none, so it uses the gateway's cwd, `~/.hermes` (V `lsof`).
  - `cwd_explicit:false` lets a named profile's `terminal.cwd` win over a cwd the client merely inherited.
- **`session.create{cwd:"/abs/project"}`:**
  - Must be an absolute, existing directory on $HERMES_HOST; otherwise `invalid_params{field:"cwd"}`.
  - It becomes the policy cwd, which the terminal tool starts in.
  - File tools resolve **relative** paths against it and warn when a relative path lands outside it (`tools/file_tools_paths.py:307-330`).
  - Context files (AGENTS.md etc.) are discovered from it.
  - In a code workspace the coding system-prompt parts plus a git snapshot apply. Toolsets swap only when `agent.coding_context: focus`; default is `auto`, so no swap.
  - V (S4b): REST row `cwd` = the given folder.
  - The row column can be steered separately with `row_cwd`. Desktop rows show `cwd NULL` (V sqlite).
- **Changing it later:**
  - `session.mutate{operation:"workspace", payload:{cwd}, expected_revision, expected_generation}` while idle (`_POLICY`).
  - It drops the session's terminal environment, so the next command starts in the new folder, and publishes `session.info` (C `session_mutations.py:318-329,354-359`).
- A remote or container terminal backend keeps its own cwd. All four profiles use `backend: local` (V).

## 7. Cross-profile handoff (user chose: hand off to a new chat in the other profile)

- **No native verb** (C):
  - `branch`, `reset` and `rewind` are same-profile.
  - Bot Mode `message_agent` DMs another bot's Bot Chat; it's messaging, not a handoff.
  - `adopt_session_lineage_from` is a legacy repair path that moves a stranded lineage into its rightful profile.
  - `session.mutate import` copies portable rows into a profile. Whether an imported row resumes as a live local session in the target profile is unverified (I), so it isn't recommended.
- **Recommended seeding:**
  1. `session.create{profile:B, request_id:"bb:<newThreadId>", cwd:<same project>, title:<carried title>, model?}`.
  2. Build a handoff block from the source:
     - canonical `session.export{profile:A, session_id, format:"md"}` (C contract: `{format, filename, content}`, nothing written on the host);
     - or bb's own thread transcript;
     - trim to the last ~N turns or ~20–30 kB.
  3. First `prompt.submit{profile:B, text: "<handoff from @A, session <id>>\n…\n</handoff>\n\n" + userMessage, title_preview: userMessage, turn_author}`. Use **visible** text: it is persisted, so later turns and compaction keep it.
- **Don't use:**
  - `api_text`: the model sees it on that turn only; the clean `text` is what's persisted (C `session_cli_turn.py:1-8`).
  - `display_kind:"hidden"`: it hides the user's own message in Hermes UIs too, and a separate hidden seed costs a model turn.
- In bb, show only the user's message (the bridge renders it) plus a "continued from @A" marker. Leave the source session untouched.

## 8. `sessions.changed` coverage (C, plus V where marked)

- Source: `tui_gateway/change_watcher.py:186-300,374-428`. One process-wide watcher, broadcast to every connected socket (`_broadcast_global_event`).
- It checks every **0.5 s**. A signature change broadcasts at most once per **2 s** window, and the trailing change re-fires. Latency ≈ 0.5–2.5 s.
- The signature is a digest of `sessions` rows only:
  - `id, source, session_key, display_name, model, parent_session_id, started_at, ended_at, end_reason, message_count, tool_call_count, cwd, git_branch, git_repo_root, title, title_source, profile_name, archived, pinned, hidden, last_read_at, handoff_state`;
  - read only when `state.db`/WAL mtime moves.
  - Heartbeat-only writes don't fire it. V: during a 10-minute passive watch the default WAL moved but no row changed, and no event came.
- **Writer coverage:** any process writing a watched DB.
  - The gateway's own Discord turns and cron runs: message_count/ended_at moves.
  - Conduit's legacy dashboard `/api/ws` writes in another process.
  - The CLI.
  - Streaming turns fire it repeatedly (message_count), coalesced by the floor.
- **Profile coverage:** the watched set is the launch home plus `tui_gateway.server._served_profile_homes`.
  - In the canonical gateway that set is filled lazily, by the legacy profile-scoped dispatcher (`_profile_home`, `server.py:455-477, 502-513`).
  - Canonical `profile:` routing (`_sibling_for`) doesn't add to it.
  - So sibling profiles (alex, david, neo, todoist) are covered **only once something in this process has made a legacy profile-scoped call for them**, e.g. Desktop over the legacy fallback (I).
  - Not verified live: no sibling row changed during the watch.
- **Not covered:** `unread` (it's a derived field; `last_read_at` is covered) and `runtime_revision`-only mutations.
- **Recommendation:**
  - Treat `sessions.changed` as a hint.
  - The bridge also stats each profile's `state.db-wal` mtime every ~2 s (same host, read-only) and re-lists that profile on change.
  - Re-list = `session.list{profile, scope:"stored"}` or REST `GET /api/sessions?profile=`.

## Open

- Live check of sibling `sessions.changed` coverage, and of a compacted Bot Chat's ids, when it next happens naturally.
- Discord: does the adapter accept or drop `reply_to` = the admission id; does the bot ignore its own echo. Needs a test bot or a supervised live try.
- The resume semantics of `session.mutate import` (only if handoff ever needs a full history copy).
- Config changes still pending approval: per-profile `plugins.enabled += bb_tools`, and optionally `tools disable bb --platform discord`.

# 04 — User's Hermes deployment and what "bots" means

Investigated 2026-11-04 on $HERMES_HOST. Read-only. Secrets shown only as present/absent. V = VERIFIED (ran/read), I = INFERRED.

## Key answers

1. **Deployment map**
   - V: All of Hermes runs on $HERMES_HOST as 3 launchd agents, on Hermes `0.22.6` @ `c314285f` (2026-11-03):
     - `ai.hermes.gateway`: `127.0.0.1:8642`, multiplexed for all profiles
     - `ai.hermes.dashboard`: `127.0.0.1:9119`
     - `ai.hermes.webui`: `127.0.0.1:8787`
   - V: Tailnet `tailscale serve` (tailnet only):
     - `:8446` → webui
     - `:8447` → oMLX `:8318`
     - `:8448` → dashboard (`dashboard.public_url`)
   - V: Docker image `~/src/hermes-image` is "not currently deployed" (unpinned, per its own Dockerfile). No containers running.
2. **Profiles**
   - V: `default` / Hermes: GPT-6.1 Terra via `openai-codex`. General assistant with Home Assistant, Todoist and executor-home MCP servers.
   - V: `alex`: `mlx_main` local. Obsidian-vault librarian, runs 2 enabled crons.
   - V: `david`: `mlx_main`. Todoist GTD operator, has an a2a source.
   - V: `neo`: GPT-6.1 Sol. Operator for the bb IDE (created 2026-11-03).
   - V: `todoist`: stale legacy profile with no `config.yaml`.
   - V: 4 Discord bot accounts connected through one multiplexed gateway: `$HERMES_DISCORD_BOT`, `Alex`, `David`, `$NEO_DISCORD_BOT`. No Telegram or Slack tokens are configured.
3. **"Bots"**
   - V: Most likely meaning is **Hermes Bot Mode**: Bot = profile + one permanent, hidden canonical session titled `Bot Chat`. Each of the 5 profile DBs has exactly one.
   - V: Conduit (third-party iPhone/iPad/Watch app + `conduit_push` plugin v0.126.2) shows the same Bots list and adopts Bot Chats.
   - V: `bot_relay/` is Bot Mode's Desktop-mediated cross-connection relay. Its roster is empty.
   - V: Personalities are Hermes' stock defaults. They are not bots.
4. **Clients in use**
   - V: Conduit on iPhone (`$PHONE_TS`) via dashboard `:8448`: active today (logins, WS tickets).
   - V: bb ACP threads: 18 `acp-hermes-agent` threads since 2026-10-21.
   - V: Discord: 4 bots.
   - V: Hermes Desktop: local build exists, not running now.
   - V: CLI/TUI: minor use.
   - V: hermes-webui: only polled. Its session store is untouched since 2026-09-06.
5. **bb integration today**
   - V: Stock bb `acp-hermes-agent` (provider-acp). `~/.local/bin/hermes` → `hermes-host/bin/hermes` wraps `hermes acp` in `hermes-bb-acp`, which only rewrites model-picker names and hides 19 model IDs.
   - V: That work is **uncommitted** in the `hermes-host` jj working copy.
   - V: Pain points:
     - bb ACP provider: no archive, no rename, no rewind
     - catalog bloat (24 → 9 models)
     - 137 empty ACP probe sessions polluting Hermes' DB
     - overriding the stock provider would lose its icon and fork support
6. **Volume**
   - V: ~446 sessions total across 5 SQLite DBs (~74 MB), about 4.7k messages.
   - V: Last 30 days: ~302 sessions, but only ~85 have messages. Breakdown: ~122 are alex cron runs, ~125 are empty bb ACP probes.
   - V: Real interactive sessions are about 1–3/day. Largest session: 153 messages, ~130 KB of content.

## 1. Deployment map (details)

- V: launchd (`launchctl list`): `ai.hermes.dashboard` pid 18230, `ai.hermes.webui` pid 61135, `ai.hermes.gateway` pid 63362.
- V: Source of truth is nix-config `modules/aspects/services/_hermes.nix` (lines 1-129).
  - The task's path `home/services/hermes.nix` 404s. It was moved in commit `17e6e8cd26` (2026-09-22); repo HEAD is `77be95d7ed`.
  - `mkAgent` at lines 34-66: label `ai.hermes.<name>`, `KeepAlive`, `ThrottleInterval 30`. It waits for the sops oMLX key, then execs `~/src/hermes-host/bin/hermes-<name>`.
  - Ports: webui 8787 (lines 84-88), dashboard 9119 (lines 90-94). The webui env points chat at the gateway (lines 105-118).
  - Line 98: "Any plist change restarts the agent and drops every live Hermes session".
- V: Rendered plists in `~/Library/LaunchAgents/ai.hermes.{gateway,dashboard,webui}.plist` match the nix module. Env holds no secrets: the key is read from a file at launch.
- V: Wrappers:
  - `~/src/hermes-host/bin/hermes-dashboard` (lines 1-29): `hermes_cli.main dashboard --host 127.0.0.1 --port 9119 --skip-build --no-open`. Requires `HERMES_DASHBOARD_SESSION_TOKEN` (present) from `~/.config/hermes-host/auth.env`.
  - `bin/hermes-gateway` (lines 1-25): `gateway run --replace`. It also sources `auth.env`, because the "gateway also mounts dashboard routes".
- V: Listeners (`lsof`):

  | Port | Bind | Process |
  |---|---|---|
  | 9119 | 127.0.0.1 | dashboard |
  | 8642 | 127.0.0.1 | gateway API server (also `~/.hermes/gateway.sock`) |
  | 8787 | 127.0.0.1 | webui (`~/src/hermes-webui/server.py`) |
  | 8318 | 127.0.0.1 | `omlx-server` |
  | 7749 | `*` | `oppi-server` (unrelated) |
  | 38888 / 55508 | 127.0.0.1 | bb host-daemon |

- V: `tailscale serve status`:
  - `https://$HERMES_HOST_TS.$TAILNET:8446` → `127.0.0.1:8787`
  - `:8447` → `:8318`
  - `:8448` → `:9119`
- V: hermes-host README ("Services" table) says "Only webui is exposed". That is **stale**: dashboard and oMLX are also served.
- V: Unauthenticated GET `https://$HERMES_HOST_TS.$TAILNET:8448/api/status` → 200. `/api/sessions` → 401. So $BB_SERVER_TS can reach the dashboard over the tailnet but needs auth.
- V: `~/.hermes/config.yaml`:
  - `gateway.multiplex_profiles: true`
  - `gateway.api_server.max_concurrent_runs: 10`
  - `dashboard.public_url: https://$HERMES_HOST_TS.$TAILNET:8448`
  - `platforms.discord.enabled: true`
- V: `gateway_state.json`:
  - `code_version 0.22.6`, `code_sha c314285f…`
  - platforms `discord`, `api_server` (`listener_base http://127.0.0.1:8642`), `alex:discord`, `david:discord`, `neo:discord`: all `connected`
  - `parked_profiles {}`
- V: `~/.hermes/hermes-agent` HEAD is `c314285f07` (2026-11-03). It is a plain git checkout of upstream `main` (hermes-host README, "Upgrading").
- V: Containers: `~/src/hermes-image/Dockerfile` lines 1-18 say "Intentionally UNPINNED … this image is not currently deployed". It was historically for a k8s cluster (amd64 + arm64). `docker ps` shows nothing running.
- V: david's README notes the same profile also runs in an "Omnigent k8s runner image" (`AndrewBird81/omnigent-host`).
  - I: That is a second, off-box Hermes runtime for david. Tailnet node `$K8S_RUNNER_TS` is active.
  - The neo README says "Hermes runs nowhere else" than $HERMES_HOST.
- V: `/Applications` has no Hermes or Conduit app; hermes-host README still claims a `/Applications/Hermes.app` stub.
- V: The Desktop local build is at `~/.hermes/hermes-agent/apps/desktop/release/mac-arm64/Hermes.app`. Its stamp: commit `c314285f`, built 2026-11-03, `source local`. It is not running.

## 2. Profiles (details)

| Profile | Purpose (from README/SOUL) | Model / provider | Discord bot | Cron jobs | Notable |
|---|---|---|---|---|---|
| default ("Hermes") | General assistant; 667 B SOUL | `gpt-6.1-terra` / `openai-codex` | `$HERMES_DISCORD_BOT` | 3, all disabled (HA night-mode/sleep) | MCP: `executor-home`, `Home Assistant`, `todoist`. Plugins: `claude-subscription-directsdk-experimental`, `conduit_push`, `herdr-agent-state`, `omlx-effort`. 40 skill dirs incl. `bb-cli`, `herdr`, `home-assistant`, `hermes-desktop-plugins` |
| alex | Obsidian vault librarian ("Alex") | `mlx_main` / `mlx-main` (oMLX :8318) | `Alex` | 2 enabled: `vault-legacy-triage` (`0 8-22/2 * * *`), `vault-triage-execute` (`0 9-21/2 * * *`), delivered to a Discord channel | Plugins: `omlx-effort`, `legacy-triage-guard`, `vault-sync`, `triage-execute-guard`. 7 vault-* skills |
| david | Todoist GTD operator ("David") | `mlx_main` / `mlx-main` | `David` | none (`jobs.json` absent) | MCP `todoist`. Also an `a2a` platform in its own `gateway_state.json`. Also runs in Omnigent k8s |
| neo | bb IDE operator ("Neo") | `gpt-6.1-sol` / `openai-codex`, personality `concise` | `$NEO_DISCORD_BOT` | none | Skills `bb-inquire`, `bb-start`, `bb-reply`, `bb-review`, `dev-setup`. Needs `BB_SERVER_URL` (present) |
| todoist | Legacy predecessor of david (I) | no `config.yaml` | no token in `.env` | none | 2 sessions, both empty |

- V: Sources:
  - `~/src/hermes-config/profiles/{alex,david,neo}/README.md`, `distribution.yaml`, `.env.template` (key names only)
  - live `~/.hermes/profiles/*/config.yaml` via a redacting parser
- V: hermes-config git HEAD is `8e2d887` ("neo: add Code Review Workspace (bb review) skill"). The repo has no `todoist` profile.
- V: Discord identities come from the log lines `Connected as $HERMES_DISCORD_BOT#…`, `Alex#…`, `David#…`, `$NEO_DISCORD_BOT#…` (`~/.hermes/logs`, `profiles/*/logs`).
- V: Per-profile `.env` (presence only):
  - `DISCORD_BOT_TOKEN`: present for default, alex, david, neo; absent for todoist
  - `DISCORD_ALLOWED_USERS`: present for all profiles
  - `API_SERVER_KEY`: present for default, alex, todoist
  - No Telegram, Slack, WhatsApp or Signal keys anywhere
- V: neo `.env.template` says reusing another profile's Discord token "blocks the multiplexed gateway".
- V: `channel_directory.json`: 27 Discord entries (24 threads, 1 channel, 1 DM, 1 group). `config.discord.auto_thread: true`, so each Discord conversation is a thread → a session.
- V: Root `config.yaml` `agent.personalities` holds 14 stock entries (helpful, concise, technical, kawaii, pirate, …). `display.personality: ''`. Only neo sets a personality (`concise`).
- V: `session_reset: {mode: both, idle_minutes: 1440, at_hour: 4}` and `group_sessions_per_user: true`. Gateway chat sessions therefore roll daily or after 24 h idle. I: a long Discord conversation becomes many Hermes sessions.

## 3. What "bots" means — candidates and evidence

### A. Hermes Bot Mode (most likely)

- V: `~/.hermes/hermes-agent/website/docs/user-guide/bot-mode.md` (lines 1-60):
  - "A Bot **is** a Hermes profile"
  - "One permanent **Bot Chat** per Bot … `/new` compacts it instead of forking it"
  - roster with avatar, latest message, unread
  - Routines = cron jobs named `[bot:<name>] …`
  - Groups/rooms of 2–6 Bots
  - Built into the Desktop app, on by default
- V: Terminology: `profiles.md` lines 19-44 distinguish "Bot Mode bot" (profile + roster metadata + pinned canonical Bot Chat) from "Messaging bot" (platform account).
- V: Canonical Bot Chat identification:
  - `tools/bot_mode_probe.py:32` and `hermes_cli/subcommands/peer.py:23` define `BOT_CHAT_TITLE = "Bot Chat"`
  - `peer.py:142-158`: "Bot Mode always HIDES canonical chats". Lookup is `GET /api/sessions?title=Bot Chat&include_hidden=1`. Creation is `POST /api/sessions {title:"Bot Chat", source:"bot_peer_dm"}`. Title is `UNIQUE` per DB.
- V: Live data: each state DB has exactly one session with `hidden=1` and `title='Bot Chat'`:

  | Profile | Session ID | Messages |
  |---|---|---|
  | default | `$HERMES_SESSION_02` | 6 |
  | alex | `$HERMES_SESSION_20` | 6 |
  | david | `$HERMES_SESSION_01` | 37 |
  | neo | `$HERMES_SESSION_36` | 14 |
  | todoist | `$HERMES_SESSION_03` | 0 |

  - `~/.hermes/profile.yaml` stores `ui_meta.hermes-bots.chat: $HERMES_SESSION_02`.
  - `profiles/david/profile.yaml` stores `ui_meta.hermes-bots` avatar (`shape`, `color`, `imageKind`, `title`).
  - `hermes_cli/profiles.py:860-889` reads `ui_meta['hermes-bots'].title` as the bot title.
- V: Desktop has the plugin dir `apps/desktop/src/plugins/hermes-bots`. hermes-host README mentions the "no Bots tab after the Bot Mode update" bug class.
- I: For the bb plugin, "dedicated chat per bot" maps to: one bb thread per profile bound to that profile's `Bot Chat` session, resolved by title + `include_hidden`, never created twice.

### B. Messaging bots (Discord)

- V: 4 Discord bot accounts, one per profile except todoist, on one multiplexed gateway.
- I: Plausible secondary meaning. In Hermes terms these are channels into the same profile, not separate chats.

### C. `~/.hermes/bot_relay/`

- V: Contents: `roster.json` (`{"agents": [], "updated_at": …}`) plus empty `outbox/`, `replies/`, `claimed/`.
- V: Writer is `hermes-agent/tools/bot_relay.py` (lines 1-11): "Bot Mode cross-connection relay … the Desktop owns every socket". It is fed by `bot_relay.roster.sync` and `bot_relay.outbox.drain` RPCs and lets bots on one gateway message bots on another.
- V: Empty roster = no other Desktop-connected gateway.
- I: Not something bb needs. If bb ever wants cross-bot messaging, Hermes' own `message_agent` already handles local profiles.

### D. Conduit

- V: What it is: the third-party **Hermes Conduit** iPhone/iPad/Apple Watch app (`github.com/kaishi00/hermes-conduit`) plus its host plugin `~/.hermes/plugins/conduit_push`.
  - Plugin remote: `kaishi00/hermes-conduit-notifier`, HEAD `0c68ec8` (2026-11-03), `plugin.yaml` version `0.126.2`.
  - Installed 2026-11-02/03 (file mtimes). Enabled in root `plugins.enabled`.
- V: The plugin README (lines 1-60) lists notifications/calls via a push relay, live voice, Watch, phone data tools (`conduit_health`, `conduit_location`, …), rich cards, rooms, chat takeover and settings.
  - "Every route sits behind the Hermes dashboard's own auth."
  - `link_status.py` docstring: "Conduit is a dashboard client".
- V: Conduit app version 2.2.1 (`conduit-settings.json`), 1 device registered. Device name omitted.
- V: `~/.hermes/conduit-*` files (shapes only):
  - `conduit-settings.json`: `{version, devices{<install-id>:{name, app_version, mode:"ask", settings[23], seen_at}}, pending[], results[], applied[], asked{}}`. Setting keys are all `voice.*` (mode, live tone, Gemini/Qwen/GPT/Grok voice/memory/personality, push-to-talk, …). It is the phone's settings mirror, which Hermes may request changes to (`settings_store.py`).
  - `conduit-prefs.json`: cross-device prefs (`voice.preferences`, `voice.keep_screen_awake`, `app.dashboards`, `app.chat_font_style`), last write wins.
  - `conduit-present.json`: phone confirm prompts / cards (`devices{features[7]}`, `prompts[]`, `cards[]`). Features: chat-cards, info-cards, live-cards, maps-navigate, media-cards, show-cards, text-drafts.
  - `conduit-calls.json`: "Hermes calls you" settings + job watches (`settings{enabled, per_hour, per_day, rules…}`, `watches[]`, `ends[6]`).
  - `conduit-push.json`: relay pairing (`credential`, `gateway_id`, `relay_url`, E2E keys), all present.
  - `conduit-local-live.json`: `api_key` present.
  - `conduit-link-status.json`: `app_seen_at` / `push_ok_at`. Root: app seen and push OK on 2026-11-04. Every profile has its own (alex, david, neo, todoist all seen today).
  - `conduit-self-update.json`: plugin self-update record (version 0.126.2).
  - `conduit-pulse.db`: "Pulse" proactive probe turns into the home chat (`pulse.py`). Tables with rows: settings 24, attempts 3, outcomes 13, cards 2, candidates 2.
  - `conduit-rooms/`: only a lock. Rooms = Linked Rooms with other people (`room_tool.py`).
  - `conduit-on-screen/`: empty. Tracks which chat Conduit has on screen so no "reply ready" push is sent for it (`chat_on_screen.py`).
  - `conduit-bot-chat-adopt.lock`: from `bot_chat_adopt.py`, which moves an old Bot Chat under the profile's gateway ("hermes-conduit FEATURE_MAP 'Bots messaging bots'").
- V: Plugin README line 140: a Conduit Bot Chat "is titled with its bot's name … as Conduit's Bots list shows it (its Bot Mode title, else its display name, else its profile id capitalized, and Hermes for the main bot)".
- I: The user's mental model of "bots" is probably Conduit's/Desktop's Bots list: Hermes, Alex, David, Neo, plus a stale Todoist.

### E. Not bots

- V: Personalities are stock prompt presets. Subagents are `delegate_task` children (1 `subagent` session total).

## 4. Clients currently used (evidence)

- V: **Conduit (iPhone) via dashboard `:8448`**.
  - `logs/dashboard-auth.log`: from `$PHONE_TS` ($PHONE_IP), 8 `ws_ticket_minted` on 11-03; 2 `login_success` and 4 tickets on 11-04.
  - Every profile's `conduit-link-status` was touched this morning.
- V: **Unknown Mac** `$OTHER_MAC_TS` ($OTHER_MAC_IP): 31 WS tickets plus 1 refresh on 11-04. I: Hermes Desktop or Conduit on another Mac → ask the user.
- V: **bb ACP**: `bb thread list --machine $HERMES_HOST --json` shows 18 `acp-hermes-agent` threads (16 archived, 5 pinned, 6 sub-threads), created 2026-10-21 → 2026-11-04. bb 0.48.1.
- V: **Discord**: 33 Discord sessions across profiles (3 + 1 + 2 in the last 30 days for default/david/neo, plus alex 2); all 4 adapters connected.
- V: **Desktop app**: 21 `desktop`-source sessions overall, mostly Aug. Recent ones: neo's Bot Chat (`created_source desktop`, 11-03) and a pinned root desktop session (11-04, same minute Conduit settings synced).
  - I: Conduit-originated chats may record `source=desktop`.
  - V: `logs/desktop.log` last written 2026-09-14.
- V: **CLI/TUI/oneshot**: root `cli` 47 (5 in last 30 days), `oneshot` 9, `tui` 1. Neo has 4 oneshot (I: bb or neo invoking `hermes -p neo -z`/one-shot).
- V: **hermes-webui**: `logs/webui.log` is mostly `GET /api/session/status` polling (2836 of the last ~5000 lines span Aug→Nov). `~/.hermes/webui/sessions/_index.json` last modified 2026-09-06. README says webui is "what the Hermex iPhone app talks to". I: Hermex was superseded by Conduit.
- V: **OpenAI-compatible API server** (`api_server` source): 9 sessions, none in the last 30 days.

## 5. bb's current Hermes integration

- V: `bb provider list --machine $HERMES_HOST --json`:
  - `acp-hermes-agent`, `pluginId provider-acp`, `displayName "Hermes Agent"`, `family acp`
  - capabilities: `supportsThreadArchive false`, `supportsThreadRename false`, `supportsFork true`, `supportsSessionRewind false`, `permissionModes [accept-edits, full]`, `modelCatalogScope host`
  - reasoningLevels none…max; serviceTiers default/fast
- V: Launcher chain: `~/.local/bin/hermes` → `~/src/hermes-host/bin/hermes` (lines 1-10). For `acp` only it runs `bin/hermes-bb-acp -- ~/.hermes/hermes-agent/.hermes/bin/hermes acp`; everything else execs the real launcher.
- V: `bin/hermes-bb-acp` (lines 1-109) is a stdlib ACP stdout filter.
  - `transform()` (lines 34-55) rewrites `models.availableModels` and `configOptions[category=model]`, including `session/update` `config_option_update`.
  - `present()` (lines 15-31) hides `hidden_models` (keeping the current model), strips the `"Provider · "` name prefix, and disambiguates duplicates with `provider_labels`.
  - stdin is passed straight through.
- V: `config/bb-models.json` (lines 1-29): 19 hidden IDs (old Claude via directsdk, `-900k` aliases, GPT-5.6/6-sol). Labels: Codex, Claude Sub, API, MLX.
- V: `docs/bb-model-audit.md` (lines 1-87): 2026-11-03, visible catalog cut from 24 to 9. Refresh is via `bb provider models acp-hermes-agent --machine $HERMES_HOST --selected-model …`; "disposable discovery session does not send a model prompt".
- V: hermes-host README "BB model picker" says to keep bb's shipped `acp-hermes-agent`, because "overriding it through `provider-acp.customAgents` loses its built-in Hermes icon and fork support".
- V: **Uncommitted**: `jj st` in hermes-host shows `bin/hermes`, `bin/hermes-bb-acp`, `config/bb-models.json`, `docs/bb-model-audit.md` and tests as `A` (added), with README/bootstrap modified, on working copy `bb96c5ab` (no description). Parent `16bbe989` is `main`.
- V: `~/.hermes/config.yaml.bak-bbtrim-20261021` (snapshot taken 2026-10-21, the first bb-Hermes thread day):
  - vs. the earlier `bak-meridian55-20261021`: a second Claude provider is removed (4 aliases), `meridian-personal` added (3 models), `moa.enabled` set false, tirith security and terminal sandbox images removed, curator thresholds tightened, `_config_version` 39→51.
  - I: The "bbtrim" removed duplicate Claude entries from bb's picker. Mixed with an update migration.
  - vs. current `config.yaml`:
    - default model: `mlx_main` → `gpt-6.1-terra` (openai-codex)
    - added: `gateway.multiplex_profiles: true`, `dashboard.public_url`
    - plugins: added `claude-subscription-directsdk-experimental` and `conduit_push`
    - `meridian-personal` removed (backup `bak-nomeridian-20261103`)
    - `display.show_reasoning` true → false
- V: **ACP probe pollution in Hermes' DB**: root `state.db` has 138 `source=acp` sessions, of which 137 have 0 messages.
  - 91 have cwd `~/.bb-machines/$BB_SERVER_TS.$TAILNET/provider-maintenance-workspace`, 8 have `~/nix-config`, 39 have null cwd.
  - I: Created by bb model discovery and catalog refreshes.
- V: **Real bb ACP threads are stored as `source=local, created_source=acp`**: 11 sessions, 294 messages, cwds `~/nix-config`, `~/src`, `~/src/hermes-config`, and an Obsidian vault path.
  - I: Hermes rewrites the source once the gateway session authority adopts the session. The sync must de-dup these against existing bb ACP threads.
- V: The bb host-daemon runs on $HERMES_HOST (`~/.bb-machines/$BB_SERVER_TS.$TAILNET/…/daemon-bundle.mjs`, plist `app.getbb.host-daemon.$BB_SERVER_TS-$TAILNET_SLUG-$BB_HOST_2.plist`).

## 6. Session volume (sizes the sync)

V: From `sqlite3 file:…?mode=ro`. "Last 30" counts sessions started in the last 30 days; "Non-empty" counts sessions with at least one message.

| DB | Size | Sessions | Last 30 | Non-empty last 30 | Last 7 | Messages | Active days / 30 | Max/day |
|---|---|---|---|---|---|---|---|---|
| root `state.db` | 54 MB (+4.7 MB WAL) | 282 | 166 | 41 | 93 | 2984 | 28 | 55 |
| alex | 13 MB | 131 | 127 | 35 | 100 | 1260 | 11 | 20 |
| david | 4.0 MB | 24 | 2 | 2 | 1 | 390 | 2 | 1 |
| neo | 2.1 MB | 7 | 7 | 7 | 7 | 67 | 1 | 7 |
| todoist | 0.5 MB | 2 | 1 | 0 | 1 | 0 | – | – |

- V: Root sessions by source (total / last 30): acp 138/125, cli 47/5, discord 28/3, cron 18/6, desktop 18/4, local 13/13, api_server 9/0, oneshot 9/9, subagent 1/0, tui 1/1.
- V: alex by source: cron 122/122 (2 jobs × ~every 2 h, 1058 messages), discord 2, oneshot 2, tui 2, acp 1, cli 1, desktop 1.
- V: david by source: acp 11, cli 4 (+3 tagged `profile_name=todoist`), a2a 2, desktop 2, discord 1, oneshot 1.
- V: neo by source: oneshot 4, discord 2, desktop 1.
- V: Root flags: archived 9, pinned 1, hidden 1, child sessions 5. alex has 0 archived. david has 2 archived.
- V: Largest sessions (messages / tool calls / content bytes / span):
  - root: desktop 153/75/129 KB/4.1 h (~4.9 M tokens); cli 131/78/220 KB; api_server 85/47/176 KB/6 h; desktop 82/41/92 KB
  - alex: acp 112/53/173 KB; cron runs about 50 messages / ~120 KB each
  - david: acp 43/26/116 KB; desktop Bot Chat 37/17/120 KB/15.7 h span
- I: Sizing:
  - Under 500 sessions in total and about 10/day, excluding probes. Initial backfill plus polling every few seconds is trivially cheap.
  - The two filters that matter:
    - drop empty `acp` probes
    - decide whether to show or collapse ~100/week alex cron runs (default: group or hide under the alex bot)
- V: Schema notes for sync (`sessions` table):
  - `id` format is `YYYYMMDD_HHMMSS_xxxxxx`
  - Columns: `source`, `created_source`, `profile_name`, `title` (UNIQUE), `pinned`, `archived`, `hidden`, `auto_archived`, `parent_session_id`, `last_activity_at`, `last_activity_description`, `last_read_at`, `message_count`, `tool_call_count`, `cwd`, `origin_json` (`{platform, chat_id, chat_type, user_id, thread_id, chat_topic…}`), `transcript_revision`
  - The DB also holds `session_turn_leases` and `hosted_room_*` tables.

## Gaps and risks

- V: The multiplexed gateway serves all profiles, but sessions live in **5 separate SQLite DBs**. Any sync must enumerate profiles, not just root.
  - I: The dashboard API is profile-scoped. The dashboard lane should confirm how to list across profiles.
- V: Bot Chats are `hidden=1`. A naive `/api/sessions` listing misses them; `include_hidden=1&title=Bot Chat` is required (`peer.py:142-158`).
- V: Session-writer lease: `bot_chat_adopt.py` docstring says an open client (Conduit/Desktop) holds the Bot Chat's active-session lease, and other writers are refused ("held by another session writer"). I: bb driving the same Bot Chat while Conduit has it open may hit this.
- I: Gateway `session_reset` (daily at 04:00 / 24 h idle) splits Discord conversations into many sessions. bb threads per Discord chat would fragment unless grouped by `origin_json.chat_id`/`thread_id`.
- I: Two copies of bb ACP history exist: the bb thread and the Hermes `local/acp` session. The plugin must link them, not duplicate them.
- V: Any plist change drops all live Hermes sessions (nix module line 98). `hermes update` orphans the dashboard with a fresh token unless `bootstrap.sh service` is re-run (README "Upgrading"). A bb plugin relying on the dashboard token must expect 401s after updates.
- V: `HERMES_DASHBOARD_SESSION_TOKEN` exists (present) in `~/.config/hermes-host/auth.env`. Its value was not read.
- V: README drift: "only webui exposed" and the `/Applications/Hermes.app` stub are stale.
- V: hermes-host bb-adapter work is uncommitted; it could be lost or overwritten.
- Not checked: dashboard REST/WS API shapes (other lane), hermes-webui internals, Conduit iOS app source, Omnigent k8s runtime, bb server-side config. The `todoist` profile's status was inferred from file contents only.
- Blocked: `home/services/hermes.nix` path in the task is wrong (404). Used `modules/aspects/services/_hermes.nix` instead.

## Open questions for the user

- "Bots" = Bot Mode bots (Hermes, Alex, David, Neo; one forever Bot Chat each), as Conduit/Desktop show them? Or should Discord bot conversations also be their own chats?
- Should the stale `todoist` profile appear as a bot, or be hidden?
- alex's cron runs (~100/week): show each as a bb thread, collapse them under the Alex bot, or hide them?
- Should existing bb `acp-hermes-agent` threads (18) be migrated, linked to their Hermes sessions, or left as they are?
- Which client is the Mac `$OTHER_MAC_TS` (31 dashboard WS tickets today): Hermes Desktop, Conduit on Mac, or something else?
- Is the david Omnigent k8s runtime still live, and should its sessions appear in bb (it is off-$HERMES_HOST)?
- Should the uncommitted hermes-host bb-adapter work be committed first, since the plugin may replace it?

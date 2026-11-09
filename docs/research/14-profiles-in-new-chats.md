# 14 — Profiles in new chats

Read-only round, 2026-11-09. Hermes `c314285f07`; live `state.db`s with `sqlite3 -readonly`/`mode=ro`; config and `profile.yaml` read key by key (no secrets, no `.env`); no gateway calls. Conduit: its public source (`kaishi00/hermes-conduit`, `main`), read only.

**VERIFIED** = observed in live data or files. **CODE** = read in source, not run. **INFERRED** = reasoned, not observed. **FAILED** = tried, no result.

## What the owner should know

- **The understanding holds for the conversation.** A new chat with David is its own Hermes session in David's DB, with David's SOUL, memory, skills, tools and MCP. Its turns never enter the Bot Chat's transcript or model context (VERIFIED, §4).
- **It is David, not "the David bot".** Only the Bot Chat gets the Bot Mode section (roster, `message_agent`) and follows later profile edits. A side chat freezes the profile's model, toolsets and MCP at create (VERIFIED, §1).
- **Profile-wide state does cross over.** Memory writes, new skills, cron jobs (one can deliver into the Bot Chat), "always" approvals, and `session_search` recall. Each reaches the Bot Chat later, not its context now (CODE, §1).
- **A side chat can't become the Bot Chat** while one exists: the title is unique and protected (CODE, §3).
- **Model:** the alex side chat ran `gpt-6.1-terra`, which bb asked for, not alex's `mlx_main`. Desktop sends a model only when the user picked one in the composer (VERIFIED, §1, §5).

## 1. What a new session with profile X takes from X

The gateway routes `session.create{profile:X}` to X's authority (`gateway/session_controls.py:173-199`), then `build_policy` freezes X's `config.yaml` into the session's launch policy (`gateway/session_policy.py:419-500`).

| Item | Taken from X | Frozen or live | Evidence |
|---|---|---|---|
| Persona (SOUL.md) | X's own home | Stored prompt reused every turn; rebuilt at compaction or `hermes sessions refresh-prompts` | CODE `agent/system_prompt.py:550-556`, `agent/prompt_refresh.py:1-13`. VERIFIED: alex and neo side chats' prompts contain their SOUL's first line |
| Bot Mode section (roster, `message_agent`) | **Bot Chat only** (title gate) | — | CODE `tools/bot_mode_probe.py:1-10`, `tools/bot_mode_dm.py:1-13`. VERIFIED: in 3/3 Bot Chat prompts, 0/3 side chat prompts |
| Model and provider | X's `model:` unless `session.create` names one | Frozen (Bot Chat: `follow_profile_config`, re-read each turn) | CODE `session_policy.py:20-23,456-460`. VERIFIED: `follow_profile_config` only in Bot Chat `model_config` |
| Reasoning | X's `agent.reasoning_effort`, or the create pick | Frozen; `/reasoning` pins it per session | CODE `session_policy.py:42-56` |
| Toolsets | X's platform toolsets for the surface (`gui`) | Frozen in the policy | VERIFIED: policy `toolsets` incl. `memory, skills, cronjob, session_search, clarify` |
| MCP servers | X's `mcp_servers` | Frozen | VERIFIED: the default side chat's policy holds Home Assistant, executor-home, todoist; alex and neo none |
| Skills | X's `skills/` | The index is in the stored prompt; `skill_view` reads disk | CODE `bot_mode_probe.py:375-450` |
| Memory | X's `memories/MEMORY.md`, `USER.md`; provider `builtin` for all 4 | Snapshot at session start; writes go to disk at once | CODE `tools/memory_tool.py:1-5,38-40`. VERIFIED: config, and MEMORY.md's first entry in the default and alex side chats' prompts |
| Cron | X's `cron/` (the `cronjob` tool) | Live | CODE `tools/cronjob_job_args.py:110-121,257-275` |
| cwd | bb sends X's `terminal.cwd`, else `~` | Frozen; `session.mutate workspace` changes it | CODE `src/bridge/thread.ts:561-570`. VERIFIED: rows show `~/src`, `~/Documents/$OBSIDIAN_VAULT`, `~` |
| Approvals | X's `approvals.mode` (all `smart`) | Read live each prompt | CODE `tools/approval_context.py:283-295` |

**What a new chat can change that later shows in the Bot Chat or other chats** (CODE unless marked):

- **Memory** (`memory` tool → X's files).
  - Other chats' tool reads see it at once.
  - Their **prompts** only at their next rebuild: compaction, refresh-prompts, or (Bot Chat) a capability-epoch change.
  - New chats start with it (VERIFIED above).
- **Skills** (`skill_manage` → `X/skills/`).
  - Installed skill names are in the Bot Chat's capability fingerprint, so the Bot Chat rebuilds its prompt on its next turn and lists the new skill (`agent/conversation_loop.py:770-860`).
  - The same holds for SOUL, toolsets and MCP edits.
- **Cron jobs** land in X's `cron/`. Desktop and Conduit show them as the bot's Routines.
  - The deliver target `bot-chat[:<profile>]` posts the run into a Bot Chat.
  - The default for a local session is "save only": a local chat has no origin to deliver to.
- **Approvals:** `always` adds to X's `command_allowlist`, shared by every chat of X (`tools/approval.py:347-362`). `session` stays per session.
- **`session_search`** reads X's whole `state.db`.
  - INFERRED: FTS hits include the hidden Bot Chat; only kanban, subagent and tool sources are excluded (`tools/session_search_tool.py:23`; no hidden filter in `hermes_state_search.py`).
  - So a side chat can recall Bot Chat text, and the reverse. The recent-sessions list skips hidden rows (`hermes_state_sessions.py:1329`).
- **Anything the terminal can do** with X's files, e.g. `hermes -p X chat -c "Bot Chat" -q …` posts into the Bot Chat. `message_agent` itself is Bot-Chat-only.

## 2. What is per session (CODE, VERIFIED where marked)

- **Transcript:** its own row and messages. VERIFIED: 3 side chats, each `chat_id = id`, separate from the Bot Chat row.
- **Compaction:** per session; `/new` in a bb chat compacts that chat (01 §4).
- **Title:** per row, unique per profile DB (`hermes_state_titles.py:136-170`). bb's thread title stays in bb.
- **Model override:** create pick, `session.mutate model`, or one-turn `prompt.submit{model_override}`.
- **Reasoning:** create pick or `/reasoning`, pinned per session (`SESSION_PINS`).

## 3. The Bot Chat

- **Lookup:** the row titled exactly `Bot Chat` (`hermes_state_titles.py:203-214`). bb resolves it by `session.list{title, include_hidden}` on every send (`src/bridge/thread.ts:611-655`), as Desktop does; Conduit by title (S8 A-S8a).
- **A side chat named "Bot Chat":**
  - **While one exists:** a rename is refused ("Title … already in use"), and auto-titles yield (`hermes_state_titles.py:105-170`). A hidden Bot Chat can't be moved off its title (CODE).
  - **When none exists, or it was archived:** a visible side chat could take the title, and every client's lookup would then adopt it as the Bot Chat (INFERRED).
  - Today every live profile has one (VERIFIED, 04 §3), and bb never titles a Hermes session.
  - FAILED: a scripted check on an isolated copy didn't start (the Hermes venv lacks `ruamel` outside its launcher).
- **Bot Chat rows** after the 3 dogfood side chats: still `hidden=1`, own ids, own prompts (VERIFIED).
- **Conduit's view:** side chats are ordinary visible rows (`source=local, created_source=desktop`), listed with the profile's chats; the Bots Home portrait still opens the Bot Chat (INFERRED from S8, §5).

## 4. Our side chats today

Trace (CODE):
1. Rail "New chat with X" → `newChat(profile)` (`src/server/chats.ts:64-90`).
   - It refuses an unknown or off bot.
   - It spawns the bb thread with `sessionOptions.profile` and binds it with `expected_id`.
   - No Hermes call yet.
2. First message → `ensureSession` (`src/bridge/thread.ts:549-572`) → `client.create({profile, request_id:"bb:<thread>", source:"gui", cwd, model?, provider?, reasoning?})` (`src/hermes/client.ts:235`).
3. Gateway: `_sibling_for(profile)` → X's authority → `_create` → `stage_local_session` → `build_policy` (`session_controls.py:173-199,470-520`).
   - The session id is `local-` + sha256 of `[home, "uid:501", "bb:<thread>"]` (`hermes_state_keys.py:71-74`).

Live (VERIFIED: deterministic ids recomputed from bb's 16 Hermes threads and matched read-only):

| Side chat | DB | Row | Launch request |
|---|---|---|---|
| Neo "Side chat: name shapes and colors" | neo | `profile_name=neo`, `source=local`, `created_source=desktop`, visible, 48 msgs, own `session_key agent:neo:local:dm:…` | `gpt-6.1-sol`, `openai-codex`, `reasoning high`, `gui` |
| Alex "Alex side chat reply ok" | alex | `profile_name=alex`, visible, 4 msgs | **`gpt-6.1-terra`**, `openai-codex`, `medium` (alex's default is `mlx_main`) |
| Hermes "Test rotation 1 of 12…" | default | `profile_name=default`, visible, 24 msgs (2 segments) | `gpt-6.1-terra`, `openai-codex`, `medium` |

Each is a separate session from its profile's Bot Chat, and neither prompt has the Bot Mode section. No `default` side chat other than the rotation test was found.

## 5. How Hermes' own apps pick a profile (source and docs)

- **Desktop** (CODE `apps/desktop/src`):
  - **Profile rail:** pills drawn by `ProfileGlyph`. `default` is a home icon; other profiles show their first letter on a tint of the profile color (`components/ui/profile-glyph.tsx`).
  - **Rail right-click:** "Set as default", which saves the startup profile (`store/default-profile.ts`), and "Open in new window".
  - **Sidebar:** groups chats per profile. Each group's "+" starts a new chat in that profile (`newSessionInProfile`, `gateway-groups.tsx:214-226`).
  - **No pick:** a new chat goes to the active profile (`session-create-request.ts:119-123`).
  - **Model:** sent only on a manual composer pick (`:108-116`). Switching profile reseeds the model to that profile's default (`desktop.md:248`).
  - **Bots tab:** rows show the avatar (an image, or a shape and color; default is a violet squircle), the name, `@handle` (default → `@hermes`) and a preview (`plugins/hermes-bots/bot-row.tsx`, `avatar.tsx:1140`).
    - Name order: Bot Mode title → `display_name` → "Hermes" for default → title-cased folder name (`labels.ts:14-77`).
    - A row click opens the Bot Chat; right-click → "Open recent session" opens other chats (`bot-mode.md:36-37`).
- **Conduit** (public Swift source):
  - **Profiles sheet** (`Views/ProfilePickerSheet.swift`): rows with a 48 pt avatar (the Hermes profile picture, shared with Desktop; else initials), the display name (editable), a glow color, and Reorder.
  - A tap switches the **active profile**: "Sessions and settings follow the active profile", so a new chat goes there.
  - An optional "All profiles" chat list.
  - **Bots Home** (first tab): portraits, each opening its Bot Chat.
  - The default profile is unknown (INFERRED: the last active one).
- **CLI and TUI:** the profile is fixed at launch:
  - `hermes -p <name>`, the `<name>` alias, or sticky `hermes profile use <name>`; else `default` (`profiles.md:178-210`);
  - `/profile` only shows it (`hermes_cli/commands.py:178`);
  - a "Profile: X" banner. No avatar.

## 6. Edge cases

- **`served_profiles`:** default, alex, david, neo, todoist; none parked (VERIFIED `gateway_state.json`).
  - An unserved profile is refused with `profile_mismatch`, never a fallback (CODE `session_controls.py:173-199`).
  - bb shows "Not served by this machine's gateway" and disables the switch.
- **`default`:** the root home. bb labels it "Hermes"; `bb thread spawn` without a profile uses it if it's on (`src/bridge/context.ts:68-70`).
- **A bot that is off in bb (todoist):**
  - `newChat` refuses: "<bot> is switched off…" (`chats.ts:67`);
  - a `bb thread spawn --option profile=todoist` stays unbound (`chats.ts:95-109`), and its turn fails with the same text before any Hermes I/O (`context.ts:68-70`);
  - Hermes itself would serve todoist, which has no `config.yaml` (built-in defaults; INFERRED). So the guard is bb's alone.

## 7. Picker data

- **Canonical `profiles.list`:**
  - `name, path, is_default, model, provider, description, display_name, canonical_session, ui_meta, has_avatar`;
  - siblings' `model`, `display_name` and `has_avatar` are unreliable (r11 §2).
- **REST `/api/profiles`:** adds the true `display_name`, `description` and `bot_title`.
- **`profiles.get_asset{name, asset:"avatar"}`:** a data URL.
- **`profiles.describe{name}`:** description, SOUL, model, skills, toolsets, MCP (r11 §2).
- **Live** (VERIFIED `profile.yaml`, unchanged since r11):
  - no `display_name`, description or title anywhere;
  - david has a `shape` and `color`;
  - avatar files for default, alex, david and todoist; none for neo.
- **Ours today:**
  - the worker's `describe` gives `{name, home, handle, terminal_cwd, served}` (`src/worker/describe.ts`);
  - the bot row gives `{profile, profile_home, bot_label, served, enabled, thread_id, import_count}` (`src/shared/rpc-contract.ts:53-70`);
  - no avatar, color, title, `display_name` or description;
  - `botLabel` skips the Bot Mode title and `display_name`. It matches Desktop today only because none is set.

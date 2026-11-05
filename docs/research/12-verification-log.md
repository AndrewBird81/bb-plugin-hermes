# 12 — Verification log: parent checks while vetting the plan

Run 2026-11-04 by the orchestrating thread, after reviews R4–R6 and spike S8. Hermes `~/.hermes/hermes-agent` @ `c314285f07`.
- **Read-only:** `sqlite3 -readonly`, source and log reads, `bb` and `tailscale` read commands. No prompts sent, no live config edits.
- **Secrets:** `.env` files read by key name only. The Discord id was compared by hash, never printed.
- **Labels:** V = VERIFIED (command or file:line), S = SUSPECTED.

## 1. Bot Chats (D44)

| Profile | Session | Messages | Last activity |
|---|---|---|---|
| default | `$HERMES_SESSION_02` | 6 | Aug 21 |
| alex | `$HERMES_SESSION_20` | 6 | Nov 3 |
| david | `$HERMES_SESSION_01` | 37 | Aug 22 |
| neo | `$HERMES_SESSION_36` | 78 | Nov 4 (user rows: 1 on Nov 3, 12 on Nov 4) |

- V: each profile has exactly one session titled `Bot Chat`, none archived.
  - All four: `hidden=1`, `chat_id` set, 0 rows in `session_admissions` (`target_session_id`).
  - All four have gateway adoption keys in `state_meta` (`gateway.local_policy.v1:`, `local_legacy.v1:`).
- V: neo's Bot Chat is in daily use through Conduit. R5's and R6's "2 Bot Chat messages in 30 days" predates this.
- From code (r11 §3, not re-run): a Bot Chat never resets, since Desktop rewrites `/new` and `/reset` to `/compact`.
  - Compaction keeps the root id.
  - It is re-minted only on delete, title displacement, or a rename away from `Bot Chat`.

## 2. Discord (pending Q23)

Discord sessions in the last 60 days:

| Profile | DM sessions (messages) | Thread sessions (messages) |
|---|---|---|
| default | 1 (80) | 5 (142) |
| alex | 0 | 2 (6) |
| david | 0 | 1 (7) |
| neo | 1 (11) | 1 (3) |

- V: a Discord DM is its own session, not the Bot Chat: default `$HERMES_SESSION_33` and neo `$HERMES_SESSION_35`.
- V (grep): nothing routes a platform DM into the Bot Chat. Neither `plugins/platforms/discord/` nor `hermes_cli/config_defaults.py` references the Bot Chat.
- V: what does land in a Bot Chat:
  - Desktop, Conduit and bb turns;
  - Bot Mode `message_agent`, locally as `hermes -p <name> chat -c "Bot Chat" --create-if-missing` (`tools/bot_mode_dm.py:10-12`);
  - peer DMs, via an exact-title lookup (`gateway/platforms/api_server.py:2529`).
- V: `DISCORD_ALLOWED_USERS` holds one id, the same in all five profiles (A39).

## 3. hermes-webui (D45: out of scope)

- **R6's "unused" was wrong:** webui is still in use (V, `~/.hermes/logs/webui.log`).
  - From tailnet Mac `$OTHER_MAC_TS`:
    - Oct 23: 1 request;
    - Nov 3, morning: 290 requests;
    - Nov 4, morning: 569 requests.
  - Those requests read `/api/sessions`, `/api/crons/recent`, `/api/health/agent`, `/api/settings`, `/api/projects` and the session event streams.
  - On Nov 4, the page polled `/api/session/status` once a minute and got 404 (195 times), so it is an older webui build.
  - The iPhone opened webui on Nov 4.
  - No request after that morning, as of that evening.
  - S: this looks like interactive morning use, not a forgotten tab. It corrects the parent's earlier "every minute since yesterday" and "probably a tab left open".
- V: webui's own session store is unchanged since Sep 6 (`~/.hermes/webui/sessions/_index.json`).
- V: webui runs as pid 61135 from `hermes-agent/venv` (Python 3.11), on `127.0.0.1:8787`, and is served on tailnet `:8446`.

## 4. Hermes driving bb (D43 risk; later: restrictions)

- **V: Hermes' danger detector flags no `bb` command, so smart approvals never prompt for one.** This corrects the parent's earlier "Hermes approvals apply".
  - Method: `detect_dangerous_command` from `tools/approval_detection.py`, under Hermes' Python 3.14, with `tools.ansi_strip` stubbed.
  - Not dangerous:
    - `bb thread spawn --machine $WORK_HOST …`;
    - `bb thread spawn --permission-mode full …`;
    - `bb thread tell`, `bb thread archive`, `bb thread log`.
  - Control: `rm -rf /tmp/x` is flagged.
- V: `approvals.deny` globs block a command even under yolo or `mode=off` (`tools/approval_floors.py:23-43`). They match command text only, so they can't tell a work thread from a personal one.
- V: Neo's skills hold policy as text only:
  - `bb-reply` approves or denies bb interactions on "his explicit word only" (`profiles/neo/skills/bb-reply/SKILL.md:28`);
  - `dev-setup` says "$WORK_MODEL_RULE" (`profiles/neo/skills/dev-setup/SKILL.md:63`).
- V: Neo's access comes from the user's repo `~/src/hermes-config/profiles/neo`. Its live skills are identical (`cmp`).
  - It passes `terminal.env_passthrough: [BB_SERVER_URL]` (`config.yaml:19-20`) and requires `BB_SERVER_URL` (`distribution.yaml:7`).
  - It is installed with `hermes profile install` and updated with `hermes profile update --force-config`.
  - Write policy (`README.md:8`): "reads free; spawn, tell and relaying the owner's answers free on their clear ask; stop, archive, retry, delete … need explicit OK".
  - Only neo's `.env` has a `BB_SERVER_URL` key.

## 5. Hermes config (Q24)

- V: `~/.hermes/config.yaml:154` sets `compression.in_place: false`, so `default` rotates its session id on compaction. Hermes' own default is `true` (S8 A-S8d).
- V: `:595` sets `gateway.multiplex_profiles: true`, so one gateway serves every profile.

## 6. Conduit chats (D44)

- V: Conduit's chats from the iPhone are legacy rows. In 30 days: `$HERMES_SESSION_31`, `$HERMES_SESSION_34`, `$HERMES_SESSION_37`.
  - All three: `source=desktop`, no `chat_id`, 0 admissions.
- V: Pulse `$HERMES_SESSION_38` is different.
  - `source=desktop`, with a `chat_id`.
  - Pinned: the only pinned session in any profile.
  - 7 admissions; 7 hidden user rows on Nov 4.

## 7. Usage (context for D42)

Snapshot: Nov 4 afternoon, last 30 days, active user rows in top-level sessions.

| Source | User messages |
|---|---|
| bb, via ACP | 21 |
| Discord | 15 |
| CLI | 8. Only 5 start "Reply with exactly", so R6's "all 8 are pings" is wrong |
| Conduit, typed | about 4; the rest of `desktop` is Pulse's hidden rows |
| cron, one-shot | 37, 16 |

- neo's Bot Chat grew after this snapshot (§1).
- V: across 455 sessions in all profiles, 1 is pinned (Pulse), 11 are archived, and none has `last_read_at` (confirms R5).

## 8. Other checks

These are already applied in the plan:
- V: `bb keep-awake status` → enabled, all hosts (D21).
- V: 4 of 26 projects have checkouts on both Macs: nix-config, src, bb-plugin-code-review-workspace and bb-plugin-conductor. They count as personal (D28 wording).
- V (code): a `session.mutate` on an unrouted legacy row claims it (A23).
  - Path: `gateway/session_mutations.py:174-183` → `hermes_state_mutation_binding.py:74-98`, `claim=True`.

Other verified state:
- After S8, the live services are unchanged:
  - gateway pid 63362 on `:8642`;
  - dashboard pid 18230 on `:9119`;
  - webui pid 61135 on `:8787`.
- S8's isolated Hermes (`/private/tmp/hermes-s8`) is gone, with no listeners left on `:9149` or `:18931`.
- GitHub `AndrewBird81/bb-plugin-hermes`: private and empty; nothing is pushed.
- Secret scan of all 79 tracked files, this one included: 0 hits.
  - Patterns: GitHub, OpenAI, Anthropic, Slack and AWS tokens; private keys; Discord bot tokens; bearer tokens; gateway tickets; `*TOKEN|SECRET|PASSWORD|API_KEY=` assignments; the Discord user id.
  - Not secrets, but personal: the docs name tailnet hosts, paths and session ids, and r02, r04 and S8 contain tailnet IPs. This matters only if the repo goes public.

# S8: Conduit and bb sharing one Hermes conversation

Run 2026-11-04. Hermes `c314285f07`, conduit_push 0.126.2 (`0c68ec8`).
- **Live Hermes:** read-only (logs, `sqlite3 -readonly`, source).
- **Experiments E1–E14:** isolated Hermes at `/private/tmp/hermes-s8`, with its own lock dir, dashboard `:9149`, an ephemeral gateway port and a stub model (`127.0.0.1:18931`) that echoes the user messages it was sent.
  - Conduit: simulated with a legacy dashboard WebSocket client.
  - bb: the repo's canonical TS client over `gateway.sock`.
  - Processes and home were removed afterwards. Live host locks and pids (18230, 63362) were unchanged.
- **Labels:**
  - **V**: verified (code cited, or an experiment run);
  - **S**: suspected;
  - **A**: assumed.

Scope follows the parent's update: a public plugin for any Hermes user, with only the minimum coordination. Rarer cases are listed as "later".

## Verdict

- **Feasible with conditions, on today's Hermes and Conduit.** Hermes already coordinates the two writers. bb only has to behave like Hermes Desktop: a canonical client that submits to the gateway's FIFO.
- **No fork, no takeover (V):**
  - bb and Conduit alternated on one Bot Chat and on a Conduit chat. Each model call saw every earlier turn from both apps.
  - Conduit kept sending after every bb action, including adoption and compaction (E2, E3, E6, E7, E8, E10).
- **Conditions bb must meet:**
  1. Find the Bot Chat by its title, as Desktop does. Never create a second one.
  2. When Conduit holds a not-yet-adopted chat, wait and retry. Never fork, never take over.
  3. After a gateway restart, resolve bb's own `unknown` turns. Until then Conduit is refused (V, E11b).
  4. Stop only bb's own turns, or Conduit turns that Hermes forwarded into the gateway.
  5. Show Conduit's own turns from history: the user message first, the reply when the turn ends. They don't stream.
- **Biggest risk:** two Hermes race bugs, neither caused by bb.
  - Sends from both apps within about 50 ms: Conduit shows an error for a message Hermes still stored, or one turn replies to stale history (V, E4).
  - Chats whose compaction rotates the session id: Conduit's handoff check misses gateway work (V, E9b). The live `default` profile has `compression.in_place: false`.
  - Both are rare for one person using two apps. Neither loses a message.
- **Confidence:** high for Hermes' behaviour (run on the live commit). Medium for the Conduit app itself, which is closed source: its behaviour is inferred from logs and its plugin.

## How Conduit and Desktop share a session today

| | Conduit (iPhone) | Hermes Desktop, local |
|---|---|---|
| Transport | Dashboard `:9119` (tailnet `:8448`), legacy TUI-gateway JSON-RPC on `/api/ws` (V: `gui.log` `tui_gateway.ws … peer=$PHONE_IP`) | Canonical gateway, after `hermes gateway ensure` and native tickets (V: `apps/desktop/src/AGENTS.md:6-31`). Remote Desktop uses the legacy path, like Conduit (`canonical-protocol.ts:1-2`) |
| Bot Chat lookup | The session titled exactly `Bot Chat` in the profile. V for its plugin (`session_titles.py:31`, `bot_chat_adopt.py:44`); S for the app | `session.list{title:"Bot Chat", include_hidden:true}` on every open. No stored id (V: `AGENTS.md:63-97`) |
| Creating a Bot Chat | Mints it on the dashboard. V from logs: iPhone socket → neo's row 5 s later (legacy id, `source=desktop`, `follow_profile_config`) → first prompt 13 s later | `session.create{title:"Bot Chat", hidden:true, follow_profile_config:true}`, then adopts the winner if another client created one meanwhile (V: `canonical-chat.ts:386-530`) |
| Other chats | Legacy rows: `source=desktop`, no `chat_id` | Canonical rows |
| `/new` in a Bot Chat | Unknown | Rewritten to `/compact` (r11 §3) |

- **Endpoints Conduit calls (V).** The dashboard logs no HTTP requests. Paths come from `dashboard-auth.log`:
  - `/api/ws` (tickets, `token_auth_success`);
  - `/api/sessions`, `/api/profiles`, `/api/config`, `/api/env`;
  - `/api/plugins/conduit_push/*`.
- **Today (V):**
  - Desktop isn't running (`desktop.log` last written Sep 14). Every Bot Chat has 0 canonical admissions, so only Conduit writes them now.
  - All 4 Bot Chats are already adopted by the gateway (`state_meta` `gateway.local_policy.v1:` and `local_legacy.v1:` keys).
  - neo's Bot Chat is in active use: 11 Conduit prompts on 11-04 (`gui.log`) and 78 messages later that day, up from 66, still with 0 admissions.
- **When a Conduit turn is saved (V, E2 and E9d):** the user row when the message is sent; the reply and the tool rows only when the turn ends.

How Hermes coordinates the two writers (V, code plus experiments):
1. **One owner, one queue:**
   - The gateway runs canonical turns from its durable queue (`session_admissions`).
   - When the dashboard gets a send while the queue holds work for that session, it passes the text to the gateway's queue instead of running it (`tui_gateway/owner_forward.py:1-16`; `methods_prompt.py:721-765`).
     - Conduit gets `{status:"queued", forwarded:true}` and only `message.start` and `message.complete` (E3b).
     - Images and rewinds can't be passed on: they are refused with `SESSION_OWNER_BUSY`.
     - An `unknown` admission is never passed on: the send is refused.
2. **Cross-process turn lease:**
   - Both processes take `session_turn_leases` per conversation (TTL 300 s; waits up to 1800 s; `agent/turn_facade_lease.py:26-27,299-389`).
   - The waiting side shows "⏳ Another Hermes process is using this session…", then reloads the transcript (E9a).
3. **Fresh model context:**
   - The gateway loads the transcript every turn (`gateway/run_turn_prepare.py:695-705`).
   - The dashboard folds in rows that other apps wrote before each turn (`tui_gateway/prompt_turn.py:512`).
4. **Writer claim (`runtime/active_sessions.json`):**
   - The dashboard claims a chat on its first turn. The claim blocks only the gateway's adoption of a not-yet-adopted row (`runtime_coordination_required`; `gateway/session_local_migration.py:335-340`).
   - It doesn't block canonical turns on adopted rows (E2: Conduit held the claim and bb's turns ran).
5. **The Conduit plugin:**
   - lets go of idle Conduit claims after 60 s, except on Bot Chats, which keep theirs while Conduit is connected (`conduit_claims.py:43,166`);
   - adopts old Bot Chats every 10 min when nothing holds them (`bot_chat_adopt.py:1-27`).

## Experiments (isolated, stub model)

| # | What | Result |
|---|---|---|
| E1 | bb creates a Bot Chat (`session.create` with `title`, `hidden`, `follow_profile_config`); creates again with another `request_id` | One hidden row, saved at once. Every later create returns **the same id**. Found by `profiles.list.canonical_session` and by a legacy `session.list` |
| E2 | Alternate Conduit A1 → bb B1 → A2 → B2 | Transcript A1, B1, A2, B2. The model saw everything before each turn. No live events cross between the apps, only `sessions.changed` |
| E3a / E9a | bb sends during an 8 s Conduit turn | bb's turn queues, shows the "waiting" status, runs after with Conduit's reply in context |
| E3b | Conduit sends during an 8 s bb turn | Passed to the gateway queue; runs after. bb gets its events live (admission `desktop-forward-…`) |
| E4 | Both send with an offset of −120…+120 ms (8 trials) | Correct at ±120 ms, bb first by 5 or 30 ms, and Conduit first by 5 ms. Failed at 0 ms (twice) and Conduit first by 30 ms (see Failure cases) |
| E6 | Profile `bob`: Conduit mints the Bot Chat (legacy), holds its claim; bb looks it up, creates, resumes | All three refused `runtime_coordination_required`; **no fork**. `profiles.list` showed `null`. ~21 s after Conduit left, bb's resume adopted it. Then bb and Conduit both continued |
| E7 | Compaction in place (Hermes' default): bb (`session.mutate compress` + `expected_generation`) and Conduit (`session.compress`) | Same session id; both apps continued |
| E8 | Rotating compaction (`in_place:false`) | New segment, `chat_id` = root. The `Bot Chat` title **moves to the tip**. Resuming the root gives the tip. Both apps kept writing the tip |
| E9b–c | Stop | Conduit's Stop on a forwarded turn: replied "interrupted", but the turn ran. bb's `session.interrupt` during a Conduit turn: idle handle, no effect |
| E10 | A Conduit "other chat" (legacy) | bb refused while Conduit held it. After release, adopted (still `source=desktop` in the database, `gui` on the wire). Conduit continued |
| E11b | Gateway killed mid bb turn | bb's turn becomes `unknown`. Conduit is refused ("outcome-unknown work … nothing was run here") until bb calls `prompt.resolve_unknown`. Then it works |
| E12 | bb mints the Bot Chat; Conduit then mints without looking up | Conduit's row silently loses the title → a second hidden chat (a fork on Conduit's side) |
| E14 | Secondary: a skill dropped into a profile | See the Secondary section |

## Recommended protocol for bb

Minimum for v1:
1. **Bot thread identity:**
   - A bot thread is bound to `(profile home, "Bot Chat")`, not to an id (as Desktop).
   - On each send and each re-list, resolve it with `session.list{profile, title:"Bot Chat", include_hidden:true}`.
   - Don't treat `profiles.list.canonical_session: null` as "none": it is null while Conduit holds a Bot Chat the gateway hasn't adopted yet (E6).
   - Cache `chat_id` (the lineage root) only for dedupe and history reads.
2. **First send to a bot that has no Bot Chat yet:**
   - Re-check, then `session.create{profile, title:"Bot Chat", hidden:true, follow_profile_config:true, request_id:"bb:botchat:<profile_home>"}`.
   - Create lazily, never at setup: that keeps the double-mint window (E12) to the user's own first send.
   - The create returns an existing Bot Chat if one appeared meanwhile (E1).
3. **`runtime_coordination_required`** from lookup, create or resume means "Conduit has a chat it hasn't handed to the gateway yet":
   - keep the send queued in bb;
   - retry with backoff at 2, 5, 10 and 30 s, then every 60 s;
   - show the banner "Open in Conduit: sends when it's free".
   - Never create, never take over. Bot Chats free up when Conduit disconnects; other chats after 60 s idle.
4. **Send:** `session.resume{omit_messages:true}` (this adopts a legacy row once) → `prompt.submit{submission_id:"bb:<thread>:<request>"}`.
   - Always submit; the gateway orders it.
   - Never auto-resend: one `submission_id` per user message.
5. **Concurrent turns:**
   - **bb busy, Conduit sends:** Hermes passes it into the gateway queue. bb sees a foreign admission on its subscription → render it live as an outside turn tagged `[Conduit]`.
   - **Conduit busy, bb sends:** bb's turn queues. Show Hermes' "waiting for another Hermes process" status. No retry.
6. **Mirror Conduit's own turns:** on `sessions.changed`, read history (REST, D40).
   - The user row lands when Conduit sends: show it at once.
   - The reply rows land when the turn ends: append them with the plan's `mirror{rest:true}`. There is no live stream.
7. **Rotation and compaction:**
   - The default (in place) keeps the id.
   - With rotation, the title moves to the tip and resuming the root reaches the tip (E8). The thread follows by title and `chat_id`.
   - `/new` or `/reset` in a bot thread → `session.mutate{operation:"compress"}`, never a new session.
8. **Stop:**
   - bb's own running turn → `session.interrupt{gen}`;
   - bb's own queued turn → `prompt.cancel`;
   - a forwarded Conduit turn: allowed (canonical, D27);
   - a Conduit turn running in the dashboard: no Stop. The button reads "Running in Conduit".
9. **Errors:**
   - After a reconnect, call `prompt.resolve_unknown` for bb's own `unknown` admissions at once. Mark the bb turn failed ("Hermes restarted: resend?").
   - `not_found` → resolve by title again.

What the user sees:

| Event | In bb | In Conduit |
|---|---|---|
| bb sends | Streams live | `sessions.changed`. When the open chat refreshes is S (closed app). A push notification for bb's replies is S (conduit_push) |
| Conduit sends while idle | User bubble at once, reply when the turn ends | Normal stream |
| Conduit sends during a bb turn | Streams live after bb's turn | "Queued", then the reply text in one piece |
| bb sends during a Conduit turn | "Waiting for another Hermes process…", then streams | Sees bb's turn on refresh |

Later (not v1):
- the simultaneous-send and rotation bugs, upstream;
- Conduit's image sends during a bb turn;
- the double-mint race;
- non-multiplexed installs.

## Failure cases

| Case | Behaviour | Evidence | bb |
|---|---|---|---|
| Both send within about 50 ms | Two outcomes: (a) Conduit says `prompt.submit` → `streaming`, then an `error` ("pending work in the gateway's queue"), though its user row is stored. A later turn answers it merged with the next prompt. (b) A gateway turn reads the transcript before Conduit's reply is saved: a prompt is answered twice and bb's prompt is unseen in that turn. Nothing is lost | V E3, E4. Cause: the dashboard stores the user row before its second check (`prompt_turn.py:118-137` emits an error instead of forwarding); the gateway loads history before taking the lease | None (one person rarely sends from both apps in 50 ms). Report upstream |
| Rotated chat (`in_place:false`) | Conduit's handoff check uses the tip id while gateway work uses the root id. No forward: the turn lease still orders the runs, but the stored rows interleave (user, user, reply, reply). With an `unknown` admission, the results were garbled | V E9b, E11. Cause S: the dashboard checks only its own id (`session_lifecycle.py:180-214`). Live: `~/.hermes/config.yaml:154` | Later: upstream. Or the user sets `in_place:true` (Q5) |
| Gateway restart during a bb turn | The admission becomes `unknown`. The gateway queue pauses; Conduit is refused | V E11b; `owner_forward.py:16` | `prompt.resolve_unknown` on reconnect |
| Conduit holds a not-yet-adopted chat | bb's lookup, create and resume refused | V E6, E10 | Wait and retry (step 3) |
| Conduit mints without looking up after bb minted | A second hidden chat; Conduit's half of the conversation forks | V E12. Whether Conduit looks up first: S | Lazy create only (step 2) |
| Conduit sends an image during a bb turn | Refused; the image is removed; "Send it again when the current turn ends" | V code `methods_prompt.py:741-748` | None |
| Conduit's Stop on a forwarded turn | No effect | V E9b; no interrupt path in `owner_forward.py` | bb can stop it |
| bb's Stop on a Conduit dashboard turn | No effect | V E9c | No Stop button |

## Per-profile reach

- **V (isolated):** one host-scoped ticket on the root's `gateway.sock` drove the secondary profiles `bob` and `carol`: create, list by title, resume, submit, adopt a legacy row, `prompt.resolve_unknown` (E6, E11b, E12).
- **R6 C5's suspicion is refuted for served profiles.** Adoption passed through the host socket (`bind_native_transport` accepts the host owner; `session_local_migration.py:19-29`).
- **Live:** `gateway.multiplex_profiles: true`, all 5 profiles served (r04). S0-S4 resumed alex's Bot Chat through the host socket.
- **General users:**
  - Multiplexing is Hermes' default, and updates move installs onto one gateway per host (V: `config_defaults.py:2163-2169`).
  - A profile with its own gateway isn't in `served_profiles`, so bb must discover `<profile_home>/gateway.sock` for it. S, untested; later.

## Plan changes

- **D35 → superseded (user, 2026-11-04).** Each enabled bot's pinned thread is that profile's Bot Chat, mirrored both ways.
  - Restore D5's binding: identity by title, as Desktop.
  - Remove "Bot Chat sharing with Conduit and Desktop" from Out.
  - Glossary: Bot Chat is bound, not "never imported".
  - Flow 8: the protocol above (lazy create, `runtime_coordination_required` → retry, no Hermes pin, `/new` → compress).
- **D16 / Q20:** keep adoption on the first bb send, and add the wait-and-retry. Read-only is excluded by the requirement. A23 (no mutations before adoption) stays.
- **Flow 4 (mirror):**
  - Conduit turns: the user row lands at send, the reply at the end. The plan's `partial` + `mirror{rest:true}` fits: render the user row at once, then append the reply rows.
  - A foreign admission on bb's subscription (`desktop-forward-…`) becomes a live outside turn. Fix the "only our admission" filter (02 event filter).
- **Flow 10:** `prompt.resolve_unknown` for bb's own `unknown` admissions. Add it to `contract/used-surface.json`.
- **Protocol mapping:**
  - `session.mutate compress` needs `expected_generation` (V E7: `invalid_params` without it).
  - Stop rules as in step 8.
- **New assumptions:**
  - A-S8a: Conduit finds Bot Chats by exact title (S).
  - A-S8b: Conduit refreshes the open chat on `sessions.changed` (S).
  - A-S8c: Conduit looks up before minting (S).
  - A-S8d: compaction is in place by default (V, `config_defaults.py:668-672`).
  - Verify A-S8a–c in P1 dogfood with the real app.
- **Phases:**
  - Bot Chat binding and the two-client rules go in P1; add to D19's gate: "the bot thread continues in Conduit".
  - T1 tests: the two-client harness from this spike (legacy dashboard and canonical client with a stub model) joins the fake and the canary (03 §8).
  - The race and rotation bugs go to "later" as upstream issues.

## Secondary: per-profile bb access

Findings (V: E14 on `bob`, plus code):
- **A skill placed in `<profile>/skills/<name>/`** is listed in the next new session without a gateway restart.
- **SKILL.md `required_environment_variables: [BB_SERVER_URL]`:**
  - on `skill_view`, it registers the name for terminal passthrough;
  - the value comes from the profile's `.env`. A line appended after the gateway started was used.
  - No `terminal.env_passthrough` is needed (`tools/env_passthrough.py:1-5`, `skills_tool_setup.py:46-85`).
  - Registration is process-wide and is cleared by any session reset (`slash_commands_session.py:90`), so the skill must be loaded again.
- **`terminal.env_passthrough` (config)** is cached per home for the process lifetime: it needs a gateway restart (`env_passthrough.py:95-124`).
- **`skills.external_dirs`** is re-read when config.yaml changes, with no restart (`agent/skill_utils.py:215-219,338-372`). It is still a config.yaml edit.
- **Updates:** `hermes update` syncs only bundled skills (`tools/skills_sync.py:1-7`). `hermes profile update --force` keeps user skills (`profile_distribution.py:628`).
- **Gateway environment:** the gateway's own environment reaches the terminal. The isolated gateway inherited `BB_SERVER_URL` from the shell; a launchd gateway has none. Without it, the bb CLI targets `127.0.0.1:38886`, which works only when the bb server is on the same machine.

Options (recommended first):
1. **A plugin-owned skill and a wrapper.**
   - The host worker writes `<plugin data>/bin/bb-hermes`: it sets `BB_SERVER_URL` only when the server is remote, then runs `bb`.
   - It also writes the generic bb skill (bundled with the plugin, rendered with the wrapper's path) to `<profile>/skills/bb-plugin-hermes/`, with a marker file, for each enabled profile.
   - Pros: no edit to config.yaml or `.env`; no restart; survives Hermes and profile updates; turning it off deletes two paths.
   - Cons: the agent must call the wrapper, not plain `bb`; one copy per profile.
2. **The skill with `required_environment_variables`, plus a `BB_SERVER_URL` line the plugin writes into each profile's `.env`.**
   - Pros: plain `bb` works.
   - Cons: edits the user's secrets file, and removal must strip the line; a reset clears the passthrough until the skill is loaded again.
3. **Neo's way:** skills shipped with the profile, `BB_SERVER_URL` in `.env`, and `terminal.env_passthrough` in config.yaml.
   - Cons: config edits, and a gateway restart for the passthrough, which drops every live session.

Neo's `hermes-config` setup is an example only; it is option 3.

## Open questions for the user

1. **Simultaneous sends (a Hermes bug):**
   - **Accept, and file an upstream issue (recommended).** Pro: no private-API code. Con: a rare confusing error in Conduit.
   - bb reads Hermes' private turn-lease table before sending. Pro: narrows the window. Con: depends on the private schema, and is still racy.
2. **bb's `unknown` turns after a gateway restart:**
   - **bb resolves them at once and shows "Hermes restarted: resend?" (recommended).** Pro: Conduit is never blocked. Con: bb decides "not sent" for the user, which Hermes leaves to a person.
   - Ask in bb each time. Con: Conduit stays refused until you answer.
3. **A Conduit chat that Conduit holds before adoption:**
   - **Wait and retry with a banner (recommended).** Pro: no takeover. Con: a bb send can wait until Conduit disconnects.
   - Drop the claim with conduit_push's takeover route. Con: a third-party private route, and close to the "takeover" you ruled out.
4. **Secondary access:** the wrapper and skill (recommended), the `.env` line, or Neo's config way. Pros and cons above.
5. **Your live `default` profile has `compression.in_place: false`:**
   - **Leave it (recommended for v1).** Con: rows can interleave after a rotation.
   - Set it to `true`. Pro: removes the id mismatch in `default`. Con: a Hermes config change outside the plugin.

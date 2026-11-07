# 01 — Product behaviour

One section per flow, each ending with testable acceptance criteria (AC). The phase is in brackets (04). "Qn default" = a plan default (README §Plan defaults); Dn = a decision.

## F1 Entry points [P1]

- **Hermes rail panel** (`navPanel`, Hermes SVG icon):
  - bot threads with unread dots;
  - "New <Profile> chat" per visible profile, plus an optional project select;
  - recent Hermes chats; "Older Hermes chats" (P3, F5);
  - a connection line ("<Hermes host> offline").
- **Home composer** (type-first, R2 S1): "Send to Hermes · <Profile>" rows in bb's own send menu (`ComposerCustomization{scopes:["new-thread"], sendMenu}`).
  - Attachments and voice stay. Spike in P1 (A27); fallback: the verified home-section message box (S1-S3 §S3b).
  - Hidden on a project home with no folder on the Hermes host (e.g. $WORK_HOST work projects, R2 S4).
- **⇧⌘H** (`app.commands.register`): an empty chat in the last-used profile.
- Not used: the sidebar-footer disclosure (S7 §3).
- **Sidebar:**
  - Hermes threads are ordinary rows; pinned threads (bots included) sit under "Pinned" (S7 §4).
  - Hermes icon on rows (D22): a row-metadata badge with the Hermes SVG and the profile, "Hermes · Alex" (`experimental_threadRowMetadata`). The user turns on the row-metadata option once. If the T1.4 spike fails (A28), rows have no glyph.
  - The provider icon and the rail use the same SVG.
- **Hidden from bb's pickers:** New Thread picker and Settings → Providers (S1-S3 §S3a). No machine picker anywhere (S7 §5).
- **bb tooling** works on Hermes threads: `bb thread tell|read|wait|stop|archive`.
  - `bb thread spawn --provider hermes [--option profile=<p>]` makes a normal Hermes chat in the default profile (A18).
  - Started on another host (e.g. $WORK_HOST), the turn fails with "Hermes runs on <Hermes host>: add `--machine <Hermes host>`" (the Hermes host setting, D30; $HERMES_HOST today).
- **Navigation:** our UI uses `useBbNavigate`. `threads.open` moves every client, phones included (S7 finding 3), so it is a fallback only.
- **Phone** (D19): starting a chat and talking to a bot from bb mobile is a P1 gate.
  - If plugin slots don't render on mobile (A30), pinned bot threads still work, and new chats come from desktop or `bb thread spawn`.

AC:
- No Hermes entry in the New Thread picker or Settings → Providers.
- Rail, home row and ⇧⌘H each start a Hermes chat; no machine or harness picker.
- Opening a chat from our UI doesn't move other clients.
- `bb thread tell <hermes-thread> "ping"` gets a reply.
- On the phone: start a Hermes chat and chat with Alex's bot thread.

## F2 New Hermes chat [P1]

- **Type-first** (home send menu): the chat is created with the first message; bb's own title generator names it.
- **Empty chat** (rail, ⇧⌘H; S7 §2):
  - the title "New <Profile> chat" is always set (bots: the handle), and the placeholder is replaced by the first message cut to 60 characters (bb can't generate a title here, S7 finding 4);
  - an agent-only init publishes the chip and model list, muted, then `markRead`;
  - 5–8 s to a usable composer.
- bb titles push to Hermes (F9); Hermes' own titles for these chats never come back (D38).
- Composer: bb's own, with text, attachments, voice, the **Profile** chip, bb's model chip and reasoning.
  - **Profile:** visible profiles only (`todoist` hidden). Labels are handles; `default` shows as "Hermes" (r11 §2).
  - **Model:** the profile's `model.options` minus hidden models; default = the profile's current model. Validated against the last-known list; never blocks a turn (R2 S9).
  - **Reasoning** (D17): Hermes levels per model (`capabilities.reasoning`, `can_disable_reasoning`; r11 §1). `default` = the profile's level.
  - **Attachments:** images and files go to `prompt.submit.attachments`. A model without image input gets a warning and the text still goes (R2 M2).
  - **Voice:** bb dictation into text. It uses bb's Codex voice service, so audio goes to OpenAI, as Hermes chats already do (R6).
  - Hermes slash commands and `/compact`: F14.
- **Project** (optional; projects on the Hermes host only, D4): from the home's project or the rail's select. None = a personal chat.
- The Hermes session is created on the first message, so an abandoned chat leaves nothing in Hermes.
- Hermes' working folder:
  - project chat: the project root (`project-checkout`, S7 §5);
  - personal chat: the profile's `terminal.cwd`, else `~` (david has none, R1 S10).
- A normal Hermes session: visible in Hermes Desktop and other clients.

AC:
- Each visible profile's first reply comes from that profile (`session.info.profile_name`).
- A "High" reasoning pick reaches Hermes (`session.info` shows it).
- A pasted image is described by each profile's default model, or the turn warns (MLX).
- An abandoned empty chat: 0 Hermes rows, 0 unread, 0 pushes.
- An approved `pwd` returns the project root, the profile's `terminal.cwd`, or `~` for david.
- No sidebar title shows marker text; no Hermes title equals `New <Profile> chat` (R2 S2).
- Tool items from sensitive tools show by name only (F15).

## F3 Composer chips and profile handoff [P1]

- **Profile chip** (`bb/session-options`, `id:"profile"`, `category:"mode"`):
  - next to bb's model chip, always listing every visible profile;
  - bb refuses values we didn't publish, and saves a pick at once (S7 §1a, finding 2).
- **Model list follows the profile** (S7 §1c):
  - `models.scope:"workspace"` + a published `bb/provider-model-catalog`;
  - personal chats each have their own list;
  - project chats share one list per project path (Q9). Mitigations: unoffered model → profile default, with a warning; the catalog is republished after each turn. No profile-namespaced model ids (S7 §1b).
- Model or reasoning change mid-chat: applies from the next turn (`session.mutate`, while idle).
- **Profile pick, chat not yet started** (binding `pending`): applies in place (init turn, ~250 ms).
- **Profile pick, chat started** (binding not `pending`, including one-turn imports and bots; R1 M9) → **handoff** (S7 §1d):
  1. A new chat opens in the chosen profile and project, titled "<Profile> chat (from <old title>)". Our UI navigates the current window (A17).
  2. The old chat keeps its profile; its chip reverts.
  3. Its first Hermes prompt is visible text: a handoff block (the old thread's bb timeline, ≤ ~25 kB; sensitive tool results by name only, F15) plus the message (r11 §7). No Hermes history read (R6 C4). bb shows the message plus "Continued from <old thread>".
  - The same path is "Continue in bb" for read-only Discord threads (F7).
  4. A send that races the pick is refused: "This chat stays on <old>. A <new> chat is opening."
- Limitations (bb UI, can't be hidden):
  - bb's model picker also offers "Handoff to new thread" to other harnesses;
  - bb's own handoff to a new Hermes thread drops the profile, so it starts in the default.

AC:
- The chip appears on new, imported and bot threads.
- Two personal chats on different profiles each show their own models.
- An unoffered model never reaches Hermes; the turn says so.
- After a handoff, "what were we just discussing?" is answered correctly.
- The old Hermes session's `revision` is unchanged.

## F4 Bots [P1] (D35)

- One pinned bb Hermes chat per visible profile: Hermes, Alex, David, Neo (`todoist` hidden). No "Bots" section (S7 §4).
- Each is an ordinary bb-created chat: an empty chat at setup titled by handle; the Hermes session is created on its first message, in that profile, with the handle as its title.
- It behaves like any Hermes chat: chip, handoff, approvals; title and archive push as in F9. The pin is bb-only: no Hermes pin writes for bots.
- Not shared with Hermes' own Bot Chats. Those stay in Hermes for Desktop and Conduit, and are never imported (Bot Mode finds them by exact title).

AC:
- Setup creates exactly 4 pinned threads; a re-run creates 0.
- The first message in "Alex" creates one session in alex (`session.info.profile_name`), titled "Alex".
- Every Hermes Bot Chat is unchanged (`revision`) and none is imported.
- The bot sessions stay unpinned in Hermes.

## F5 Imported threads [P2]

- **Scope** (deny-list, R2 M3): every session with ≥ 1 message active in the last 30 days, except (each label checked in both `source` and `created_source`, R6):
  - cron and one-shot (toggles, off); Discord (toggle, on; D13); `a2a` and `tool` (D32);
  - `acp` in `source` or `created_source` (D12);
  - Bot Chats (D35) and subagents (nested);
  - bb-created and tombstoned sessions.
  - `api_server` imports, tagged `[API]` (D32). Discord threads are read-only (F7).
  - Tags come from the real source values (`[CLI]`, `[TUI]`, `[Desktop]`; Conduit records as Desktop, A5); unknown → `[Hermes]`.
- **Pre-migration sessions** (D16):
  - render read-only from Hermes history (REST projection first, R6 C3);
  - Hermes adopts the session (`session.resume`) only when the user first sends from bb;
  - `importPreview` counts them separately.
- **First import:**
  1. `importPreview` shows counts by profile, source and legacy; the user confirms.
  2. The import runs serially, oldest first.
  3. Each thread is hidden while it replays, then shown, marked read and released. No pushes.
  - An import cut off by a restart is redone (R3 S2).
  - Circuit breaker: more than 5 new automatic imports in a day (after the first run) → import pauses, health red.
- **Placement:** cwd at or inside the root of a project on the Hermes host → that project; else personal.
- **State:** an import reads Hermes' title and archived state once (D33, D38). It never copies Hermes' pin: the only pinned session is Pulse (R6 C6). Later Hermes-side changes never come back.
- **Rendering** (S1-S3 §S1b):
  - each user message is the user's bubble, tagged with source and date: `[CLI · Oct 12] …` (R2 S10);
  - reply and tools follow, collapsed; sensitive tool results show by name only (F15);
  - title = Hermes title, else the first message cut to 60 characters (R2 S2);
  - item times are import time (Q7 default);
  - replayed lines enter prompt history (accepted).
- **Lineage:** a compressed session is one thread. Compaction clones and `/retry` rewrites render once (`message_uid`, R1 M2).
- **Subagents:** a delegation item in the parent's turn, openable as a sub-thread (`parentThreadId`); live while it runs.
- **Later:**
  - new eligible sessions become threads, then mirror (F6);
  - turning a source on, or raising the window, backfills (R2 S6);
  - turning a source off stops new imports only.
- **Older Hermes chats** (P3, R2 S6): a rail list of sessions outside the window, with "Open in bb" (import on demand).

AC:
- Imported count == `e2e/eligibility` (same filter constants, per profile home, R3 S6); `(profile_home, lineage_root)` unique.
- 0 ACP, 0 empty, 0 cron, 0 one-shot imported.
- A re-run creates 0 threads.
- After import: 0 unread, 0 pushes, 0 hosted bridges.
- 0 Hermes writes (`revision` unchanged on every imported session).
- A session with a compaction and a `/retry` imports as 1 thread, with no repeated turns.

## F6 Live mirroring and source tags [P2]

- Outside activity in a bound session (Discord included) mirrors into its thread: spinner, streaming text, tools, then unread.
- An outside user message is the user's own bubble, tagged `[CLI]`, `[TUI]`, `[Desktop]`, `[Discord]`, `[API]`, `[Hermes]` (S7 §8). Sensitive tool results show by name only (F15).
  - It lands in prompt history (D15). A bb send that starts with a source tag (an ↑-recalled line) is refused: "Remove the [Discord] tag to send."
  - A turn with no user line (Pulse, subagent results) mirrors the reply only.
  - Images in outside messages: text only in v1.
- Each outside turn is shown once, even across re-lists and compaction (R1 M1–M2). A CLI `/retry` adds a "Retried in CLI" turn with the new reply (R4 S1).
- Queued sends merged with a mirror are still sent to Hermes (R1 M6).
- **Notifications** (D26):
  - turns the user started (the user's own Discord id, bb, CLI, TUI, Desktop/Conduit; D33) are marked read automatically: no dot, no push;
  - hidden-prompt turns (the user row is hidden, e.g. Conduit's Pulse, ~7 a day) are muted and marked read too; Conduit already pushes them (R6 C6);
  - turns the user didn't start (other Discord users, subagents) keep the dot and push; unknown author: no push;
  - approvals and clarify always push.
- Typing in bb during a mirror → queued behind the outside turn (S1-S3 §S2c).
- **Stop during a mirror** (D27): interrupts that Hermes turn, fenced by its admission and generation. With no live events (legacy writer), it stops watching only.
- Approvals and clarify from an outside turn show in bb, even while a bb turn waits behind it (R1 S1). The first answer anywhere wins (r08 §4).

AC:
- Outside start → visible in bb ≤ 3 s (A13).
- 3 re-lists during one outside turn → 1 bubble. A compaction adds no `[Hermes]` summary bubble (R4 M3b).
- A CLI turn: no dot, no push. A Pulse turn: no dot, no push. A subagent result: dot + push.
- Sending a recalled `[Discord] …` line is refused.
- Streamed text == final text when attaching mid-turn (R1 S2).
- Back-to-back outside turns render as 2 turns.
- Turns made while the bb server or daemon was down appear in order after reconnect.

## F7 Discord: read-only, Continue in bb [P2] (D39)

- Discord sessions import and mirror live like any session, tagged `[Discord]` (F5, F6). bb never replies into Discord.
- A bb send to a Discord thread is refused before it starts: "This Discord chat is read-only in bb. Pick a profile in the chip to continue it in a new bb chat."
- **Continue in bb:** on a Discord thread the profile chip shows "Discord · read-only" (A41). Picking any profile hands off to a new bb chat that carries the conversation: F3's handoff, with the F15 filter.
- Stop (D27), approvals and clarify on a Discord turn still work from bb.
- Each Hermes Discord session is its own thread (Q4); the daily reset starts a new one.

AC:
- A Discord message appears in bb as `[Discord] …` plus the reply.
- A bb send in that thread is refused with the notice; nothing reaches Hermes or Discord.
- Picking "Alex" opens a new Alex chat whose first reply knows the Discord conversation.

## F8 Approvals, clarify, interrupt, steer [P1]

- **Approval card:**
  - the command or diff;
  - only Hermes' choices (`once|deny`, plus `session|always` for commands);
  - a deadline from the request's `timeout_s`: 60 s live (`approvals.timeout: 60` for edits and commands; 300 s was the isolated manual-mode run, R6).
- **Clarify:** a bb user question (choices, multi-select, free text, skip) with a 600 s deadline. Native, so `AskUserQuestion` isn't injected (r10 Q5).
- **Timeout** → Hermes decides; the card closes "Timed out in Hermes". Answered elsewhere → "Answered elsewhere".
- **Never auto-approved:** the one declared permission mode, `auto`, must never answer for the user (A2, D17). Live Hermes runs smart approvals; P1 dogfood includes a command smart mode escalates.
- **Stop:**
  - ours running → interrupt (271 ms, S0-S4 §S4d);
  - ours queued behind an outside turn → cancel ours only (R1 M4).
- **Steer:**
  - ours running → Hermes steer;
  - otherwise → a queued prompt. Never into another client's turn (R1 M4).

AC (isolated Hermes, manual approvals, quoted throwaway paths):
- `deny` leaves the target untouched; `once` runs it once.
- A double answer is silent; a timeout closes the card.
- The clarify answer is used.
- Stop ≤ 1 s.
- Stop or steer while a CLI turn runs leaves that turn untouched.

## F9 State push, bb → Hermes [P2] (D38)

| bb action | Hermes effect |
|---|---|
| pin / unpin | `sidebar{pinned}` |
| archive / unarchive | `archive{archived}` |
| rename (any bb title except the "New <Profile> chat" placeholder) | `rename{title}` (`"[bb] "` stripped) |
| delete (Q1 default) | none; the session is tombstoned against re-import |

- One-way: Hermes-side changes (pins, archives, renames, auto-titles) never come back. Imports read them once (F5).
- Read state isn't synced in either direction: Hermes records no reads (`last_read_at` unset on 0 of 455 sessions, R5), and D26 marks user-started outside turns read.
- A session deleted in Hermes: the bb thread stays; a send fails with "Deleted in Hermes".
- Not pushed: bot pins (D35); legacy bindings until the first bb send adopts them, since a mutation also claims the row (D16, A23); Discord threads (read-only, D39); ACP threads.
- A refused push (e.g. a title already used in that profile; titles are unique per DB) is logged in `diagnostics`; Hermes keeps its value.
- Hermes host unreachable: bb changes are pushed on reconnect.

AC:
- Each row lands in Hermes with one revision per user action.
- A Hermes-side rename or pin doesn't change the bb thread.
- No Hermes title starts with `[bb] ` or equals the placeholder.
- A pin made during an outage reaches Hermes ≤ 10 s after reconnect.

## F10 Notifications [P2]

- Each bound thread gets the Settings default level (`inherit`, D7) via `threadNotifications.set` (S1-S3 §S3c), overridable per thread.
- Outside turns the user started run at `input-only` (approvals and clarify still push) and are marked read when they finish (D26). Hidden-prompt turns (Pulse) run `muted` and are marked read (R6 C6).
- Imports and init turns: silent. bb-started turns: normal bb behaviour.

AC:
- A Conduit chat turn: 0 bb pushes, no dot.
- A Pulse turn: 0 pushes, no dot.
- An outside approval: 1 push.
- First import: 0 pushes.

## F11 bb skills in Hermes [standalone task TS.1] (D37)

- Hermes uses bb as Neo does today: skills plus the `bb` CLI from its terminal. No Hermes plugin.
- default, alex and david get Neo's `bb-start`, `bb-inquire`, `bb-reply`, `bb-review` and their dependency `dev-setup`.
  - As symlinks to `~/.hermes/profiles/neo/skills/<name>` (Neo's come from `~/src/hermes-config/profiles/neo/skills`): one source of truth.
  - Hermes' skill index follows symlinks (`agent/skill_utils.py:882`, `os.walk(followlinks=True)`), and default's `bb-cli` is already a symlink (read 2026-11-04). Fallback: copies.
- The CLI needs `BB_SERVER_URL` in the terminal. A profile's `.env` never enters the gateway's environment; only names in `terminal.env_passthrough` reach terminal commands (Neo's `config.yaml`). Today only Neo has the key (key names read, 2026-11-04). So each of default, alex and david gets:
  - `BB_SERVER_URL` in its `.env`;
  - `terminal.env_passthrough: [BB_SERVER_URL]` (default has `[]`; alex and david have none).
- Guard: skill guidance only. Hermes' smart approvals flag no `bb` command (R6 C2); a real guard is pending Q19.
- Work rule (D28), guidance text in `dev-setup`, not enforced:
  - a thread is work when it runs on $WORK_HOST (the user's rule: "$WORK_HOST is always work", `~/.agents/reference/model-routing.md`);
  - the 4 projects on both hosts (nix-config, src, bb-plugin-code-review-workspace, bb-plugin-conductor) are personal; their $WORK_HOST threads are still work;
  - Hermes chats can't be in work projects: those have no $HERMES_HOST checkout;
  - touch work threads only when the owner asks from bb or Conduit, never from Discord.
- Accepted loss: threads Hermes starts are top-level, not nested under its Hermes chat, because Hermes doesn't know its bb thread id. No workaround.
- Accepted risk (user decision): 05 R20.
- Not gated by D34: it runs whenever the user approves this live Hermes change.

AC:
- From a bb chat in each of default, alex and david: `bb thread list` works.
- "Start a Codex thread that lists ~/src" → a new top-level bb thread; Hermes reads its result with `bb thread read`.
- Neo's skills still work.

## F12 Settings v1 [P0–P2, P3]

| Setting | Default | Phase |
|---|---|---|
| Hermes host + Hermes root (required; unset = no Hermes I/O; D30) | unset; $HERMES_HOST + `~/.hermes` on live | P0 |
| Connection health: gateway, Hermes version, drift result, worker last sync, Hermes host online, bb and SDK versions; `audit` result from P2 | — | P0 |
| Default profile; hidden profiles | `default` ("Hermes"); `todoist` | P1 |
| Hidden models per profile | from `hermes-host/config/bb-models.json`, `custom:mlx-main` = `mlx-main` (r11 §1) | P1 |
| Import sources | Discord on; cron and one-shot off (`a2a` and `tool` always excluded, D32) | P2 |
| Import window | 30 days | P2 |
| Default notification level, outside activity | `inherit` | P2 |

AC: each setting applies to the next action without a reload; `bb-models.json` is no longer read.

## F13 ACP retirement and the stack after v1 [P3]

- **Parity gate** (D25), run in this phase: F1–F3 (reasoning included), F8 and F14 (slash commands, fork) pass on live, plus 1 week of daily use without falling back to ACP. Service tier is not required.
- `bb provider disable acp-hermes-agent`: the 18 threads stay viewable and sends fail (r07 §1; A7). Their sessions are never imported.
- Then, only after the user confirms the listed ids and a `state.db` backup is taken (R3 S10), delete:
  - the empty ACP probe sessions (137 on 2026-11-04; ~125 more per 30 days until ACP is disabled);
  - the spike leftover `local-a6fec510…`.
  - Sessions bound to the 18 ACP threads are excluded.
- Optional, user-approved (R2 S8): retire `ai.hermes.webui` (`:8787`, tailnet `:8446`, `HERMES_WEBUI_*`) through nix-config, and the hermes-host bb adapter (Q8).

AC:
- The 18 threads render; a send shows a clear error.
- No Hermes ACP entry in any picker.
- 0 empty ACP probes after cleanup.

## F14 Slash commands and fork [built from P1; gate P3] (D25)

Not part of the P1 exit. The protocol check runs in P0 (T0.12), so a gap shows early.

- **Slash commands** ride Hermes' legacy methods: there is no canonical catalog (A31):
  - bb's command menu lists the profile's commands from `commands.catalog`;
  - a picked command runs through `slash.exec`;
  - `/compact` is bb's manual compaction (`supportsManualCompaction`), mapped to Hermes `session.mutate compress` (A33);
  - text that isn't a listed command goes to the model as-is.
- **Fork:** bb "Fork" on a Hermes thread → `session.mutate branch` (A34, verified in code) → a new bb thread bound to the branch, with the same profile and project. The api_server fork route needs `API_SERVER_KEY`, a credential D1 rules out.
  - Checkpoint fork uses `branch{through_message_id}`.
  - If only tip works live, we declare `fork:"tip"`: bb then offers forking at the latest turn only.

AC:
- A listed command runs, and its output shows in the thread.
- `/compact` compacts the Hermes session (`context.compacted` in bb; same thread).
- A fork is a new thread whose first reply knows the forked context. The source session is unchanged.
- Checkpoint fork (if declared) starts from the chosen turn.

## F15 Sensitive tool results [P1; P2 for import and mirror] (D36)

- Results of sensitive tools render in bb by tool name only, e.g. "used conduit_location": no arguments, no result, no progress text.
- Applies to every Hermes thread: bb-started chats, import replay, mirror turns and the handoff block. The full result stays in Hermes.
- The rule lives in code (`src/shared/sensitive-tools.ts`) and matches by prefix: `conduit_*` (18 phone tools today: health, location, contacts, calendar, inbox, phone, maps, free_busy, …) and `mcp__Home_Assistant__*` (R6 C7).
- Test: every `provides_tools` entry in `<hermesRoot>/plugins/conduit_push/plugin.yaml` matches a prefix. It runs in the drift check too, since Conduit updates itself.
- Limit: the model's own reply can still mention the data.

AC:
- A bb-started, replayed, mirrored or handed-off `conduit_location` or `conduit_contacts` call shows only the tool name. bb's thread events and the handoff text contain none of the fake result.

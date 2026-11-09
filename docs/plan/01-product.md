# 01 — Product

What the user sees, feature by feature. Each ends with acceptance criteria (AC); the phase is in brackets (04).

## 1. Connect and health [P0]

- Plugin settings page: **Hermes folder** in bb's settings form; below it the plugin's Connection section with the **Hermes machine** picker and the health line (02 §Placement). Each setting appears once:
  - **Hermes machine:** a picker of bb machines. Unset → "Not connected", no Hermes I/O. The machine is saved with the folder it was set for: a folder that changed without a save (a reinstall resets the folder but keeps the machine) → "Not connected" until the connection is saved again.
  - **Hermes folder:** defaults to `~/.hermes`; editable for unusual installs and for tests (02 §Placement).
- **Health line:** connected or not; Hermes version and "supported" or "not supported"; worker last seen.
  - Not supported → mirroring and import pause; chats from bb keep working while the methods they use are present (02 flow 11).
- Provider hidden from bb's New Thread picker and Settings → Providers (S1-S3 §S3a). No machine picker anywhere.

AC:
- Unset machine: 0 Hermes calls. Set: health green within 60 s. No Hermes entry in bb's pickers.
- A changed Hermes contract (fake) → health "not supported", mirroring paused, a bb chat still replies.

## 2. Bot switches [P1; import P2]

![What the per-bot switch does](../diagrams/bot-switch.svg)

- One row per bot the host's gateway serves (S8 §Per-profile reach). A profile with its own gateway shows "Not served by this machine's gateway", switch disabled while off (a bot that is on can always be switched off).
- **Every bot starts off** (D43). Off = absent from bb: no chat, no mirroring, no bb access.
- The grant, once, in a warning card above the rows (ux-v1.1 §1, r12 §4): "A bot that's on can operate bb. It can read, start, message, stop and archive any bb thread on any machine. Hermes doesn't ask before running bb commands. Restrictions come later."
- Each row: the bot's name, its switch on the right, and at most one line: the error; else, while off, "Not served by this machine's gateway." or "Imports 12 chats from the last 30 days." (count from the history reader: the chats that become mirrored threads; the Bot Chat goes into the bot thread and isn't counted; none for 0). No avatar.
- **On:**
  1. The worker writes the bot's bb skill and the shared wrapper, then refreshes that profile's prompts (02 flow 1).
  2. The bot thread appears, pinned (§3).
  3. Threads archived by an earlier switch-off unarchive and catch up (D48). [P2] Chats from the last 30 days import (§7).
- **Off:**
  1. bb stops watching the bot's chats; turns running in Hermes keep running there.
  2. Every bb thread of that bot is archived (D48), the bot thread included. Sends to one the user unarchives fail: "Neo is switched off in the Hermes plugin settings."
  3. The worker deletes the bot's skill, and the wrapper once no bot is on. The bot's own bb skills, if any, are untouched.

AC:
- Fresh install: every switch off; 0 skills written; 0 bot threads.
- On: skill + marker in `<profile>/skills/bb-plugin-hermes/`; a new Hermes chat and the existing Bot Chat both list it on their next turn (A43); 1 pinned thread.
- Off → on: the same threads come back (no duplicates), and turns made while off appear.
- Off: 0 skill files left; wrapper gone if no bot is on; threads the user archived before stay archived after on.

## 3. A bot's threads [P1]

The owner's model: **each bot has one thread, its Bot Chat.** A bot can also have side chats and mirrored chats. bb keeps them apart:

| Thread | Created by | Hermes session | In the sidebar |
|---|---|---|---|
| **Bot thread** (one per bot) | the plugin, at switch-on | the profile's Bot Chat, found by title on every send (S8 step 1) | Pinned; title = bot name ("Neo"); badge "Hermes · Neo · Bot Chat" |
| **Side chat** (any number) | you: bb's New Thread with Neo in the Bot chip (D51), or `bb thread spawn` | a new session, created on the first message | Normal row; bb's title from your first message; badge "Hermes · Neo" |
| **Mirrored chat** (any number) | the plugin, when a CLI, TUI, Desktop or Conduit chat of Neo exists | that session | Normal row; Hermes' title; badge "Hermes · Neo" (no app: Hermes' record names none unambiguously, `docs/operations.md` §Surfaces); outside bubbles tagged `[Outside bb]` |

- The composer of each shows the Hermes icon and the bot's name in a one-value chip, so the bot is visible and fixed (A52).
- UI text names an app only when Hermes records it for that exact chat or turn. Hermes records no per-turn source, so every outside turn, in every thread, reads `[Outside bb] …` (owner ruling, 2026-11-08).
- Turns in the Bot Chat from any app (Desktop, Conduit, Bot Mode DMs from other bots, r12 §2) show in the bot thread, never in a new thread.
- A Hermes side chat that bb started shows in Hermes Desktop's sidebar like Desktop's own side chats.
- Deleting the bot thread in bb: it is re-created, pinned, at the next reconcile (D44). The Hermes Bot Chat is untouched.
- Badge missing (A28 fails): pinned position and title still mark the bot thread.

AC:
- [P2] One bot with a Bot Chat, 2 side chats and 3 CLI chats → exactly 1 pinned + 5 other threads, each badge as above.
- A Bot Chat turn from Conduit lands in the bot thread; no thread is created.

## 4. Chat from bb [P1]

![A chat from bb](../diagrams/chat-from-bb.svg)

- **Start:** bb's New Thread (D51): pick Hermes on the Hermes machine, then the bot in the Bot chip, which lists every enabled bot (r13 §3). `bb thread spawn --option profile=<bot>` does the same. The bot thread itself is a chat too.
  - bb names the chat from its first message.
  - The Hermes session is created on the first message: an abandoned draft leaves nothing in Hermes.
- **Composer:** bb's own: text, attachments, voice dictation, bb's model chip, reasoning.
  - **Model:** "The bot's model" first and the default (D53), then the bot's `model.options`. It sends no model, so a chat runs its bot's own unless you pick one there; it offers the bot's current model's reasoning. A pick is validated against the last-known list; never blocks a turn. An unoffered model → the bot's default plus a warning (S7 finding 6).
  - **Reasoning** (D17): Hermes levels per model; `default` = the bot's level (r11 §1). Mid-chat changes apply from the next turn.
  - **Attachments:** images (PNG, JPEG, GIF, WebP) go to Hermes (A50); other files don't: a warning names them, the text still goes.
- **Replies** stream live: text, reasoning, tools.
- **Approvals and `clarify`** (D11): a bb card with Hermes' choices only and the request's deadline (`timeout_s`: `approvals.timeout`, 60 s on the owner's setup, R6; 600 s for `clarify`). A push goes out. Timed out → "Timed out in Hermes"; answered in another app → "Answered elsewhere". bb never answers for you (A2).
- **Steer:** into bb's own running turn; otherwise queued as the next message.
- **`/new`, `/reset`:** a compaction of the same chat, never a new session (S8 step 7; README confirm item 7). Hermes keeps a chat's first and last messages, so a short chat's `/new` compacts nothing: bb says so.
- **Working folder:** in a project, bb's folder for the chat (the project root with Project checkout), as Codex, Claude and Pi (D54); with "No project", the bot's `terminal.cwd`, else `~` (R1 S10). Hermes' terminal follows the session's folder on its local backend.
- **Phone** (D19): the bot thread works as any thread. New side chats come from bb's New Thread, as on desktop.

AC:
- Each enabled bot's first reply comes from that profile (`session.info.profile_name`).
- "High" reasoning reaches Hermes (`session.info`).
- An image is described; a non-image file warns and the text still goes.
- An abandoned empty chat: 0 Hermes sessions, 0 unread, 0 pushes.
- `deny` leaves the target untouched; `once` runs once; a timeout closes the card; the `clarify` answer is used.
- `/new` in the bot thread: same lineage root, `context.compacted` shown. A chat too short to compact (Hermes answers `noop`): no `context.compacted`, Hermes' report as a notice.
- On the phone: start a side chat and chat in a bot thread.

## 5. Stop [P1]

![Stop](../diagrams/chat-stop.svg)

| Turn | Stop does |
|---|---|
| bb's own, running | interrupts it (≤ 1 s, S0-S4 §S4d) |
| bb's own, queued or waiting for Conduit | drops it; it never reaches Hermes |
| Conduit's, forwarded into the gateway | interrupts it (S8 step 8) |
| Conduit's own (dashboard) | nothing: banner "Running outside bb" |
| any outside turn waiting on an approval | Stop interrupts bb's card (bb's own thread stop, T1.14); the approval can then be answered only in the other app |
| CLI, TUI or Desktop | bb stops watching; banner "Running outside bb" (never an app's name: Hermes records no per-turn source). The reply still shows when the turn ends (D27 narrowed) |

AC: Stop on a CLI turn leaves it running in Hermes; its reply appears in bb when done.

## 6. The Bot Chat shared with Conduit [P1]

![bb and Conduit share one Bot Chat](../diagrams/shared-bot-chat.svg)

- One conversation: each model call sees every earlier turn from both apps (S8 E2). Conduit keeps working after any bb action (E10).
- **Conduit's own turns:** your message appears at once; the reply when the turn ends. They don't stream (S8 step 6).
- **Conduit sends while bb's turn runs:** Hermes queues it; it streams live in bb after bb's turn, tagged `[Outside bb]`.
- **bb sends while Conduit's turn runs:** bb's turn shows "Waiting for another Hermes process…", then streams. Conduit's turn then shows after bb's, though Hermes stores it first (P1 dogfood). bb can't show Hermes' order here: bb places your bubble when you send and only appends turns after it, and Conduit's own turn has no live events, so bb sees it only from the store when its wake runs, after bb's turn (02 flow 6). The model's context has Hermes' order.
- **No Bot Chat yet:** bb creates it on your first message, never at setup (S8 step 2).

![What bb does when Conduit holds the chat](../diagrams/shared-wait.svg)

- **Conduit holds a chat the gateway hasn't adopted:** your message stays queued in bb with the banner "Open in another Hermes app: sends when it's free". bb retries; it never creates a second chat or takes over (S8 step 3).
- Conduit's other chats that bb mirrors follow the same rules (D44).
- **Hermes restarted during bb's turn:** the turn fails "Hermes restarted: resend?"; Conduit isn't blocked (S8 step 9, E11b).
- Accepted (D50): sends from both apps within ~50 ms, and rotating compaction, can confuse Hermes' order; no message is lost (S8 §Failure cases).

AC (two-client harness, then the real app):
- Alternate Conduit, bb, Conduit, bb → one transcript in order in both apps.
- Conduit holds an unadopted chat → bb waits with the banner; sends after Conduit lets go; one Hermes chat.
- On the phone: a bb message in the bot thread, then a Conduit message in the Bot Chat → both in one conversation (D19).

## 7. Mirroring and import [P1 for bound threads; P2 for every chat]

![Which outside chats show up in bb](../diagrams/outside-sessions.svg)

- **What mirrors** (D42, D49): every visible chat of an enabled bot from CLI, TUI, Desktop and Conduit, plus its Bot Chat. Everything else stays in Hermes (README confirm item 5).
- **Import** at switch-on (README confirm items 1–2):
  - chats active in the last 30 days with no bb thread, oldest first, each replayed hidden, then shown read: no unread, no push;
  - your messages are your bubbles tagged `[Outside bb · Oct 12] …` (never an app's name); bb's own earlier messages carry no tag;
  - title: Hermes' title, else your first message cut to 60 characters;
  - archived in Hermes → archived in bb. Hermes' pin is never copied.
- **Live:** new outside turns appear in their thread within ~3 s (A13); a new outside chat becomes a new thread, unread and with no push. Its first turn arrives as an import (what Hermes has stored so far, the rest when the turn ends); later turns stream.
  - CLI, TUI and Desktop turns stream (A19); Conduit's own turns arrive in two steps (§6).
  - A turn whose user message Hermes hides (e.g. a Conduit Pulse report) shows the reply only.
  - Each turn shows once across re-lists and compaction (A8).
  - A `/retry` shows as Hermes' own view does: the retried message again, then the new reply (owner default).
  - Images in outside messages: text only.
- **Reply from bb** in any mirrored thread: continues that Hermes session (D44); a legacy Conduit chat is adopted on that first send (D16).
- **Title** follows Hermes' title until you rename the thread in bb. bb renames, pins and archives stay in bb (D38 Later).
- bb deletes a mirrored thread → never re-imported (Q1). Deleted in Hermes → the thread stays; sends fail "Deleted in Hermes".
- Activity in a thread you archived: bb refuses sends into an archived thread (A49), so it stays archived and unchanged; its turns come in when you unarchive it.
- A recalled `[Outside bb] …` line sent from bb is refused: "Remove the [Outside bb] tag to send." (D15)

AC:
- Imported count == the switch row's count == `e2e/eligibility`; a re-run imports 0.
- After import: 0 unread, 0 pushes, 0 Hermes revisions changed.
- 0 cron, one-shot, ACP, chat-app or empty chats in bb.
- A CLI turn streams in bb; a Conduit turn shows the message, then the reply.
- 3 re-lists during one outside turn → 1 bubble; a compaction adds no repeated turn; a `/retry` adds exactly one turn: the retried message and its new reply.

## 8. Notifications [P1]

- Outside activity marks the thread unread; its reply sends no push.
- Approvals and `clarify` push, from any turn bb sees.
- bb-started turns follow bb's normal rules. Import and setup are silent.
- Accepted noise: hidden-prompt turns such as Pulse (~7 a day, R6 C6) mark unread too. Finer rules are Later (D26, D33).

AC: a CLI turn → dot, 0 pushes; an outside approval → 1 push; first import → 0 pushes, 0 dots.

## 9. bb tooling [P1]

- `bb thread tell|read|wait|stop|archive` work on Hermes threads.
- `bb thread spawn --project proj_personal --provider hermes --option profile=<bot>` makes a side chat (A18; the CLI needs the project). No `profile` → `default` if it is on, else the turn fails listing the enabled bots. On another machine → "Hermes runs on <machine>: add `--machine <machine>`" (bb refuses the spawn's first message, with or without `--model`).
- An enabled bot runs these same commands through its skill (§2; 02 §bb access).

AC: `bb thread tell <hermes-thread> "ping"` gets a reply; from an enabled bot's chat, "list my bb threads" runs `bb-hermes thread list`.

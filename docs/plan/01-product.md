# 01 — Product behaviour

One section per flow, each ending with testable acceptance criteria (AC). The phase is in brackets (04). "Qn default" = a plan default (README §Plan defaults); Dn = a decision.

## F1 Entry points [P1]

- **Hermes rail panel** (`navPanel`, Hermes SVG icon):
  - bot threads with unread dots;
  - "New <Profile> chat" per visible profile, plus an optional project select;
  - recent Hermes chats; "Older Hermes chats" (P6, F5);
  - a connection line ("$HERMES_HOST offline").
- **Home composer** (type-first, R2 S1): "Send to Hermes · <Profile>" rows in bb's own send menu (`ComposerCustomization{scopes:["new-thread"], sendMenu}`).
  - Attachments and voice stay. Spike in P1 (A27); fallback: the verified home-section message box (S1-S3 §S3b).
  - Hidden on a project home that has no $HERMES_HOST folder ($WORK_HOST work projects, R2 S4).
- **⇧⌘H** (`app.commands.register`): an empty chat in the last-used profile.
- Not used: the sidebar-footer disclosure (S7 §3).
- **Sidebar:**
  - Hermes threads are ordinary rows; pinned threads (bots included) sit under "Pinned" (S7 §4).
  - Hermes icon on rows (D22): a row-metadata badge with the Hermes SVG and the profile, "Hermes · Alex" (`experimental_threadRowMetadata`). The user turns on the row-metadata option once. If the T1.4 spike fails (A28), rows have no glyph.
  - The provider icon and the rail use the same SVG.
- **Hidden from bb's pickers:** New Thread picker and Settings → Providers (S1-S3 §S3a). No machine picker anywhere (S7 §5).
- **bb tooling** works on Hermes threads: `bb thread tell|read|wait|stop|archive`.
  - `bb thread spawn --provider hermes [--option profile=<p>]` makes a normal Hermes chat in the default profile (A18).
  - Started on a host without Hermes ($WORK_HOST), the turn fails with "Hermes runs on $HERMES_HOST: add `--machine $HERMES_HOST`".
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

- **Type-first** (home send menu):
  - the chat is created with the first message;
  - the title is that message cut to 60 characters (server-set, so it never syncs to Hermes);
  - Hermes' own title replaces it later.
- **Empty chat** (rail, ⇧⌘H; S7 §2):
  - the title "New <Profile> chat" is always set;
  - an agent-only init publishes the chip and model list, muted, then `markRead`;
  - 5–8 s to a usable composer.
- Composer: bb's own, with text, attachments, voice, the **Profile** chip, bb's model chip and reasoning.
  - **Profile:** visible profiles only (`todoist` hidden). Labels are handles; `default` shows as "Hermes" (11 §2).
  - **Model:** the profile's `model.options` minus hidden models; default = the profile's current model. Validated against the last-known list; never blocks a turn (R2 S9).
  - **Reasoning** (D17): Hermes levels per model (`capabilities.reasoning`, `can_disable_reasoning`; 11 §1). `default` = the profile's level.
  - **Attachments:** images and files go to `prompt.submit.attachments`. A model without image input gets a warning and the text still goes (R2 M2).
  - **Voice:** ASSUMED to be client-side dictation into text; checked in P1 dogfood.
  - Hermes slash commands and `/compact`: F14.
- **Project** (optional; $HERMES_HOST projects only): from the home's project or the rail's select. None = a personal chat.
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
  3. Its first Hermes prompt is visible text: a handoff block (the old transcript from the store, ≤ ~25 kB) plus the message (11 §7). bb shows the message plus "Continued from <old thread>".
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

## F4 Bots and Conduit co-use [P3]

- One pinned thread per Bot Mode bot: Hermes, Alex, David, Neo. Each is bound to the profile's `Bot Chat` (11 §3); no "Bots" section (S7 §4).
- Title = the capitalised handle (11 §2). Bot titles never sync in either direction (R1 S5). Archive is bb-only (Q2 default).
- `todoist` is in hidden profiles by default. Every live profile is a Desktop bot (11 §2), so bb's rule decides.
- History is imported (F5); then the thread is live.
- Shared with Conduit and Desktop:
  - bb turns show there;
  - Conduit turns show in bb as soon as Hermes writes them. A turn with no live events is rendered from Hermes' store (02 flow 4).
- Compaction keeps the bound id (11 §3). A re-minted Bot Chat → the thread rebinds.
- Bot Chat handed off to a messaging lane (R1 S13) → banner "Replies here also post to <platform>".

AC:
- Setup creates exactly 4 pinned threads; a re-run creates 0.
- A Conduit message to Alex appears in bb ≤ 5 s after Hermes writes the reply, including when the wake fires mid-turn (R1 M5).
- A bb message shows in Conduit.
- After a bb rename, the Hermes row is still `Bot Chat` and the bb title stays.

## F5 Imported threads [P2; Discord P5]

- **Scope** (deny-list, R2 M3): every session with ≥ 1 message active in the last 30 days, except:
  - cron and one-shot (toggles, off);
  - `acp` in `source` or `created_source` (D12);
  - Bot Chats (F4) and subagents (nested);
  - bb-created and tombstoned sessions.
  - Discord is held back until P5.
  - Tags come from the real source values (`[CLI]`, `[TUI]`, `[Desktop]`, `[Conduit]` if distinguishable, A5); unknown → `[Hermes]`.
- **Pre-migration sessions** (D16):
  - render read-only from Hermes' store;
  - Hermes adopts the session (`session.resume`) only when the user first sends from bb;
  - `importPreview` counts them separately.
- **First import:**
  1. `importPreview` shows counts by profile, source and legacy; the user confirms.
  2. The import runs serially, oldest first.
  3. Each thread is hidden while it replays, then shown, marked read and released. No pushes.
  - An import cut off by a restart is redone (R3 S2).
- **Placement:** cwd at or inside a $HERMES_HOST project root → that project; else personal.
- **Rendering** (S1-S3 §S1b):
  - each user message is the user's bubble, tagged with source and date: `[CLI · Oct 12] …` (R2 S10);
  - reply and tools follow, collapsed;
  - title = Hermes title, else the first message cut to 60 characters (R2 S2);
  - item times are import time (Q7 default);
  - replayed lines enter prompt history (accepted).
- **Lineage:** a compressed session is one thread. Compaction clones and `/retry` rewrites render once (`message_uid`, R1 M2).
- **Subagents:** a delegation item in the parent's turn, openable as a sub-thread (`parentThreadId`); live while it runs.
- **Later:**
  - new eligible sessions become threads, then mirror (F6);
  - turning a source on, or raising the window, backfills (R2 S6);
  - turning a source off stops new imports only.
- **Older Hermes chats** (P6, R2 S6): a rail list of sessions outside the window, with "Open in bb" (import on demand).

AC:
- Imported count == `e2e/eligibility` (same filter constants, per profile home, R3 S6); `(profile_home, lineage_root)` unique.
- 0 ACP, 0 empty, 0 cron, 0 one-shot imported.
- A re-run creates 0 threads.
- After import: 0 unread, 0 pushes, 0 hosted bridges.
- 0 Hermes writes (`revision` unchanged on every imported session).
- A session with a compaction and a `/retry` imports as 1 thread, with no repeated turns.

## F6 Live mirroring and source tags [P2]

- Outside activity in a bound session mirrors into its thread: spinner, streaming text, tools, then unread.
- An outside user message is the user's own bubble, tagged `[CLI]`, `[TUI]`, `[Desktop]`, `[Conduit]`, `[Discord]`, `[Hermes]` (S7 §8).
  - It lands in prompt history (D15).
  - A turn with no user line (Pulse, subagent results) mirrors the reply only.
  - Images in outside messages: text only in v1.
- Each outside turn is shown once, even across re-lists, compaction and `/retry` (R1 M1–M2).
- Queued sends merged with a mirror are still sent to Hermes (R1 M6).
- **Notifications** (D26):
  - no push for outside turns the user started (CLI, Desktop, Conduit, Discord);
  - push for approvals, clarify and turns the user didn't start;
  - unread is still set, and cleared when Hermes shows the turn read (R2 S3).
- Typing in bb during a mirror → queued behind the outside turn (S1-S3 §S2c).
- **Stop during a mirror** (D27): interrupts that Hermes turn, fenced by its admission and generation. With no live events (legacy writer), it stops watching only.
- Approvals and clarify from an outside turn show in bb, even while a bb turn waits behind it (R1 S1). The first answer anywhere wins (08 §4).

AC:
- Outside start → visible in bb ≤ 3 s (A13).
- 3 re-lists during one outside turn → 1 bubble.
- Streamed text == final text when attaching mid-turn (R1 S2).
- Back-to-back outside turns render as 2 turns.
- Turns made while the bb server or daemon was down appear in order after reconnect.

## F7 Discord replies and echo [P5]

- A bb reply in a thread bound to a live Discord session posts to that Discord conversation (08 §4, A10).
- `bb_tools` first posts "$OWNER_NAME (via bb): <text>" (`pre_llm_call` + `ctx.post_message`, 11 §4).
  - Agent-sent input (`bb thread tell` from another agent) is labelled "<thread title> (bb agent)" if bb marks it (A21); otherwise this is a documented limitation (R2 S11).
- Rolled-over session (daily 04:00 / 24 h reset) → the reply stays in bb and Hermes, with "Not posted to Discord: this conversation rolled over" (D23).
- Children spawned from a Discord-bound thread don't notify the parent, so nothing leaks to Discord (R1 S12).

AC (throwaway Discord thread, user-approved):
- Echo, then reply, in order; the echo isn't re-ingested (A11).
- A Discord message appears in bb as `[Discord] …` + reply.
- A rolled-over session posts nothing and shows the notice.

## F8 Approvals, clarify, interrupt, steer [P1]

- **Approval card:**
  - the command or diff;
  - only Hermes' choices (`once|deny`, plus `session|always` for commands);
  - a deadline: edit 60 s, command 300 s.
- **Clarify:** a bb user question (choices, multi-select, free text, skip) with a 600 s deadline. Native, so `AskUserQuestion` isn't injected (10 Q5).
- **Timeout** → Hermes decides; the card closes "Timed out in Hermes". Answered elsewhere → "Answered elsewhere".
- **Never auto-approved:** one declared permission mode that never auto-answers (A2, D17).
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

## F9 Two-way state sync [P2]

| bb action | Hermes effect | Hermes action | bb effect |
|---|---|---|---|
| pin / unpin | `sidebar{pinned}` | pin in Desktop/Conduit | `threads.pin/unpin` |
| archive / unarchive | `archive{archived}` | archive | `threads.archive/unarchive` |
| user rename | `rename{title}` (`"[bb] "` stripped) | rename, auto-title | `threads.update{title}` |
| open (read) | `sidebar{unread:false}` | read elsewhere | `markRead` |
| delete (Q1 default) | none; tombstone | delete | archive + "Deleted in Hermes"; sends refused |

- Server-set titles (placeholders, fallbacks, Hermes titles) never go to Hermes (R2 S2).
- Bot threads: titles never sync; archive is bb-only (Q2 default). ACP threads are untouched.
- $HERMES_HOST unreachable: changes are applied on reconnect by diffing against the last synced values. If both sides changed, Hermes wins (R1 S14).

AC:
- Every row works both ways with one Hermes revision per user action.
- No Hermes title starts with `[bb] `; a duplicate title gets `" (2)"` in Hermes only.
- A pin made during an outage reaches Hermes ≤ 10 s after reconnect.

## F10 Notifications [P2]

- Each bound thread gets the Settings default level (`inherit`, D7) via `threadNotifications.set` (S1-S3 §S3c), overridable per thread.
- Outside turns the user started run at `input-only`, so approvals and clarify still push (D26).
- Imports and init turns: silent. bb-started turns: normal bb behaviour.

AC:
- A Conduit chat turn: 0 bb pushes, unread set.
- A Pulse turn: 1 push.
- An outside approval: 1 push.
- First import: 0 pushes.

## F11 bb tools in Hermes [P4]

- The `bb_tools` Hermes plugin adds toolset `bb`: `bb_thread_spawn`, `bb_thread_tell`, `bb_thread_list`, `bb_thread_read`, `bb_thread_wait`. Each wraps `bb thread … --json`.
- Enabled per profile. Works in every session of an enabled profile **except cron**: always off there (D18).
- **Discord-origin sessions:** spawn and tell ask for a Hermes approval. Elsewhere they run without asking (D24).
- From a bb-bound session the tools act as that thread: children are spawned under it.
- `tell` may target any thread (D2 interop), except its own bound thread (loop).
- **Arguments** (allowlist):
  - spawn takes `prompt`, `title`, `provider` (fixed list), `model` and `project`;
  - no permission-mode argument;
  - `project` targets any bb project. Work ($WORK_HOST) projects only from bb-bound and Conduit sessions (Desktop counts as Conduit if A5 can't tell them apart); never from Discord, cron, CLI or one-shot (D28). Personal projects follow the normal rules.
- `bb_thread_wait` is capped below Hermes' 420 s tool limit.

AC:
- In neo: "spawn a Codex thread that lists ~/src" → a child of neo's thread; `bb_thread_wait` returns its result.
- Cron sessions and non-enabled profiles have no `bb` tools.
- A $WORK_HOST `project` from a Discord or CLI session is refused; from a bb-bound session it works.
- `tell` to its own thread is refused.

## F12 Settings v1 [P0–P2, P6]

| Setting | Default | Phase |
|---|---|---|
| Hermes root (required; unset = no Hermes access, R3 M3) | unset; `~/.hermes` on live | P0 |
| Connection health: gateway, Hermes version, drift result, worker last sync, $HERMES_HOST online, bb and SDK versions | — | P0 |
| Default profile; hidden profiles | `default` ("Hermes"); `todoist` | P1 |
| Hidden models per profile | from `hermes-host/config/bb-models.json`, `custom:mlx-main` = `mlx-main` (11 §1) | P1 |
| Import exclusions (deny-list) | cron, one-shot | P2 |
| Import window | 30 days | P2 |
| Default notification level, outside activity | `inherit` | P2 |

AC: each setting applies to the next action without a reload; `bb-models.json` is no longer read.

## F13 ACP retirement and the stack after v1 [P6]

- **Parity gate** (D25), run in this phase: F1–F3 (reasoning included), F8, F9 and F14 (slash commands, fork) pass on live, plus 1 week of daily use without falling back to ACP. Service tier is not required.
- `bb provider disable acp-hermes-agent`: the 18 threads stay viewable and sends fail (07 §1; A7). Their sessions are never imported.
- Then, only after the user confirms the listed ids and a `state.db` backup is taken (R3 S10), delete:
  - the empty ACP probe sessions (137 on 2026-11-04; ~125 more per 30 days until ACP is disabled);
  - the spike leftover `local-a6fec510…`.
  - Sessions bound to the 18 ACP threads are excluded.
- Optional, user-approved (R2 S8): retire `ai.hermes.webui` (`:8787`, tailnet `:8446`, `HERMES_WEBUI_*`) through nix-config, and the hermes-host bb adapter (Q8).

AC:
- The 18 threads render; a send shows a clear error.
- No Hermes ACP entry in any picker.
- 0 empty ACP probes after cleanup.

## F14 Slash commands and fork [P1] (D25)

Both are unverified on the canonical socket. The protocol check runs in P0 (T0.12) so that a gap shows early.

- **Slash commands:**
  - bb's command menu lists the profile's Hermes commands (A31: a canonical catalog, or only the legacy `commands.catalog`);
  - a picked command runs in Hermes (A32: `prompt.submit` text or a dedicated method);
  - `/compact` is bb's manual compaction (`supportsManualCompaction`), mapped to Hermes `session.mutate compress` (A33);
  - text that isn't a listed command goes to the model as-is.
- **Fork:** bb "Fork" on a Hermes thread → a Hermes branch (A34: `session.mutate branch`; the api_server fork route needs `API_SERVER_KEY`, a credential D1 rules out) → a new bb thread bound to the branch, with the same profile and project.
  - Checkpoint fork (from an earlier turn) needs Hermes to branch at a message.
  - If only tip works, we declare `fork:"tip"`: bb then offers forking at the latest turn only, with no fork from an earlier message.

AC:
- A listed command runs, and its output shows in the thread.
- `/compact` compacts the Hermes session (`context.compacted` in bb; same thread).
- A fork is a new thread whose first reply knows the forked context. The source session is unchanged.
- Checkpoint fork (if declared) starts from the chosen turn.

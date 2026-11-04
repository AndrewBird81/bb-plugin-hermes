# 01 — Product behaviour

One section per flow. Each ends with testable acceptance criteria (AC). Phase in brackets (04).

## F1 Entry points [P1]

- **Hermes rail panel** (`navPanel`):
  - bot threads with unread dots;
  - one "New <Profile> chat" button per visible profile, plus an optional project select;
  - recent Hermes chats;
  - a connection line ("$HERMES_HOST offline" when the worker is down).
- **Home page section** (`homepageSection`): a row of "New <Profile> chat" buttons. On a $HERMES_HOST project's home they create project chats.
- **⇧⌘H** (`app.commands.register`): a new chat in the last-used profile.
- Not used: the sidebar-footer disclosure, which duplicates the home row (S7 §3).
- Sidebar: Hermes threads are ordinary rows; pinned threads (bots included) show under "Pinned" (S7 §4).
  - No row glyph: hidden providers get none, and per-thread icons don't exist (S7 §4). Conflicts with D2 "Hermes icon" (open Q10).
- Hidden from bb's New Thread picker and from Settings → Providers (`experimental_visibility:"installed"` + health `not_installed`, S1-S3 §S3a). No machine picker anywhere (S7 §5).
- bb tooling works on Hermes threads: `bb thread tell|read|wait|stop|archive`.
- `bb thread spawn --provider hermes [--option profile=<p>]` from the CLI or another agent makes a normal Hermes chat, in the default profile unless one is given (ASSUMED A18).
- Navigation: our UI opens threads with `useBbNavigate`. Server `threads.open` moves every connected client, phones included (S7 finding 3), so it is a fallback only.

AC:
- New Thread picker and Settings → Providers list no Hermes entry.
- Rail panel, home row and ⇧⌘H each open a new Hermes chat; no machine or harness picker anywhere.
- Opening a chat from our UI doesn't move the user's other clients.
- `bb thread tell <hermes-thread> "ping"` runs a Hermes turn; the reply appears in the thread.

## F2 New Hermes chat [P1]

- A "New <Profile> chat" button opens an **empty chat** at once (S7 §2):
  - title "New <Profile> chat", always set, or the sidebar shows the marker;
  - an agent-only init turn publishes the Profile chip and the model list;
  - notifications are muted during the init and restored after; `markRead` after it;
  - about 5–8 s from click to a usable composer, with "Starting thread…" meanwhile.
- The user then works in bb's own composer: text, attachments, voice, the **Profile** chip and bb's model chip.
  - Profile: visible profiles only (`todoist` hidden by default). Labels are the handle, with `default` shown as "Hermes" (11 §2).
  - Model: the chosen profile's `model.options{profile}` (11 §1), minus hidden models. Default = the profile's current model.
- **Project** (optional; $HERMES_HOST projects only): taken from the home page's project or the rail's project select. None = personal chat.
- The Hermes session is created on the first message, so an abandoned chat leaves nothing in Hermes (S7 finding 7).
- Hermes' working folder:
  - project chat: the project root, via the `project-checkout` environment (S7 §5) → `session.create{cwd}` (11 §6);
  - personal chat: the profile's own `terminal.cwd` (default `~/src`, alex the vault, neo `~`; 11 §6).
- Title: from Hermes' session title once it has one. bb can't generate one for an init-first chat (409, S7 finding 4). Fallback: the first message, cut to 60 characters (A14).
- The chat is a normal Hermes session, so it also shows in Hermes Desktop and other clients.

AC:
- For each visible profile, a new chat's first reply comes from that profile (`session.info.profile_name`).
- Abandoning an empty chat adds 0 rows to that profile's `session.list`, leaves 0 unread and sends 0 pushes.
- In a project chat, an approved `pwd` returns the project root; in a personal chat, the profile's `terminal.cwd`.
- The sidebar never shows marker text as a title.

## F3 Composer chips and profile handoff [P1]

- **Profile chip** (`bb/session-options`, `id:"profile"`, `category:"mode"`):
  - in every Hermes composer next to bb's model chip;
  - always lists every visible profile, because a pick is the switch control;
  - bb refuses values the bridge didn't publish (HTTP 400) and saves a pick immediately (S7 §1a, finding 2).
- **Model list follows the profile** (S7 §1c):
  - `models.scope:"workspace"` plus a bridge-published `bb/provider-model-catalog` on start, resume and every profile change;
  - personal chats each have their own folder, so each has its own list;
  - project chats share the project path, so two profiles in one project overwrite each other's list (S7 finding 1, inferred; open Q9).
  - Mitigations:
    - the bridge validates every turn's model against the profile's list and maps an unoffered model to the profile's default, with a warning "Using <default>: <model> isn't available for <Profile>" (S7 finding 6);
    - the bridge republishes the catalog after each turn.
  - No profile-namespaced model ids: the closed chip would be ambiguous (S7 §1b).
- Model change mid-chat: applies from the next turn (`session.mutate model` while idle; 11 §1).
- **Profile pick, empty chat:** applies at once. The server sends an agent-only init turn; the chip and models update in ~250 ms (S7 §1c).
- **Profile pick, chat with messages: handoff** (verified end to end, S7 §1d):
  1. A new chat opens in the chosen profile, same project, titled "<Profile> chat (from <old title>)". Our UI navigates the user's current window (ASSUMED A17); otherwise `threads.open`.
  2. The old chat keeps its profile; its chip reverts.
  3. On the new chat's first message, Hermes gets visible text: a handoff block (trimmed `session.export{format:"md"}` of the old session, up to ~25 kB) plus the message (11 §7). bb shows only the message plus a "Continued from <old thread>" line.
  4. A send that races the pick is refused: "This chat stays on <old>. A <new> chat is opening." (S7 §1d).
- Bot threads: the chip shows the bot's profile; a pick hands off like any chat.
- Limitations (bb UI, can't be hidden):
  - bb's model picker also offers "Handoff to new thread", including other harness tabs (Codex, Claude, Pi).
  - bb's own handoff to a new Hermes thread drops the profile: the new thread starts in the default profile, with visible "Continue from @thread:…" text (S7 §1d).

AC:
- The chip appears on new, imported and bot threads and lists every visible profile.
- In two personal chats on different profiles, each model list matches its profile.
- A model not offered for the profile never reaches Hermes; the turn uses the default and says so.
- After a handoff, asking "what were we just discussing?" in the new chat gets a correct answer.
- The old Hermes session is unchanged (`revision` the same); no Hermes session ever changes profile.

## F4 Bots and Conduit co-use [P3]

- One pinned thread per Bot Mode bot: Hermes, Alex, David, Neo. Each is bound to its profile's `Bot Chat` (`profiles.list` `canonical_session`, 11 §3). Title = the capitalised handle (no names are set, 11 §2).
- Pinned threads show under "Pinned", so there is no "Bots" section (S7 §4).
- `todoist` is hidden: it is in hidden profiles by default. Every live profile is a Desktop bot (11 §2), so bb's rule decides.
- History is imported like F5; then the thread is live.
- Same conversation as Conduit and Desktop:
  - bb turns appear there as normal turns.
  - Conduit turns run through the legacy dashboard, so bb sees them only once they finish (08 §4). They appear as a finished turn: `[Conduit] …` bubble plus reply.
- Bot Chat compaction (`/new` → `/compact`) keeps the bound id (11 §3). If the title lookup ever returns a new id (Bot Chat deleted or re-minted), the bot thread rebinds and carries on.
- Rename and archive stay bb-only for bot threads (open Q2). Pin and read sync.

AC:
- Setup creates exactly 4 pinned bot threads; re-running it creates 0.
- A Conduit message to Alex appears in bb's Alex thread ≤ 5 s after the turn finishes.
- A bb message to Alex shows in Conduit's Alex chat.
- After renaming a bot thread in bb, the Hermes row is still titled `Bot Chat`.

## F5 Imported threads [P2; Discord P5]

- **Scope:** sessions with ≥ 1 message, active in the last 30 days, from CLI, TUI, Desktop and Conduit. Discord joins in P5.
- **Excluded:**
  - cron and one-shot (Settings toggles, off);
  - any `created_source=acp` or `source=acp` row: ACP threads and probes (D12, 09 M6);
  - Bot Chats (F4) and subagent sessions (nested, below);
  - sessions bb created; tombstoned sessions.
- **First import:**
  - `importPreview` shows counts per profile and source; the user confirms; then the import runs once, serially, oldest first.
  - Each thread is hidden while it replays, then shown, marked read, given the default notification level, and released. No pushes.
- **Placement:** cwd at or inside a $HERMES_HOST project root → that project (`project-checkout` environment, S7 §5); else personal.
- **Rendering** (S1-S3 §S1b):
  - each Hermes user message is the user's bubble with its source tag (`[CLI] …`, `[Desktop] …`);
  - the assistant reply and tools follow, each turn collapsed as "Worked for 0ms";
  - title = Hermes title;
  - times are import time (open Q7);
  - replayed lines enter bb prompt history (accepted cost).
- **Lineage:** a compressed session is one thread (lineage root).
- **Subagents:** a delegation item in the parent's turn, openable as a bb sub-thread (`parentThreadId`). Live while the subagent runs.
- **After first import:** new eligible sessions become threads as they appear, then mirror live (F6).
- **Source toggles:** turning a source on backfills that source within the window. Turning it off stops new imports; existing threads stay.

AC:
- Imported thread count equals the read-only eligibility query (`03` §dogfood); unique `(profile_home, lineage_root)`.
- 0 ACP, 0 empty, 0 cron, 0 one-shot sessions imported (toggles off).
- Re-running the import creates 0 threads.
- After import: 0 unread, 0 pushes, 0 hosted Hermes bridge processes.
- A session with 1 compression continuation imports as 1 thread containing both segments.

## F6 Live mirroring and source tags [P2]

- Outside activity in a bound session mirrors into its bb thread: spinner, streaming text, tools, then unread and a notification at the thread's level.
- Outside user message = the user's own bubble with a tag: `[CLI]`, `[TUI]`, `[Desktop]`, `[Conduit]`, `[Discord]`. A turn with no user line (e.g. Conduit Pulse) mirrors the reply only.
  - The bubble is a visible tagged `threads.send` plus an agent-only marker. It renders as the user's bubble, in order (S7 §8).
  - It also lands in bb prompt history; the user accepted that (D15).
  - Origin per row: ASSUMED A5. Unknown origin → `[Hermes]`.
- An outside session not yet bound but eligible → imported (F5), then mirrored.
- The user types in bb during a mirror turn → queued in Hermes behind the outside turn and answered after it (S1-S3 §S2c).
- Approvals and clarify raised by an outside turn show in bb too; the first answer anywhere wins (08 §4).

AC:
- Outside turn start → visible in bb ≤ 3 s (`sessions.changed` or `state.db` stat 0.5–2.5 s, 11 §8; wake ~50 ms, S1-S3 §S2a). ASSUMED budget; measure in P2.
- Tag and text exact; bb's own messages never appear twice.
- Outside turns made while the bb server or host daemon was down appear in order after reconnect.

## F7 Discord replies and echo [P5]

- A bb reply in a thread bound to a live Discord session posts to that Discord conversation (08 §4).
- The `bb_tools` Hermes plugin first posts "$OWNER_NAME (via bb): <text>" there (`pre_llm_call` + `ctx.post_message`, 11 §4). The reply follows.
- The session has rolled over (daily 04:00 / 24 h idle reset): the reply stays in bb and Hermes, with a notice "Not posted to Discord: this conversation rolled over" (open Q3).
- Discord approvals: Discord buttons and the bb card both work; the first answer wins.

AC (throwaway Discord thread, user-approved):
- A bb message produces the echo, then the reply, in that order. The echo is not re-ingested as a user turn (ASSUMED A11).
- A Discord message appears in bb as `[Discord] …` plus the reply.
- A rolled-over session posts nothing to Discord and shows the notice.

## F8 Approvals, clarify, interrupt, steer [P1]

- Hermes approval → bb approval card:
  - shows the command or file diff;
  - offers only Hermes' choices (`once|deny`; commands may add `session|always`);
  - shows a deadline: edit 60 s, command 300 s (S0-S4 cheat-sheet 10).
- Hermes `clarify` → bb user question: choices, multi-select, free text, skip; 600 s deadline. Native, so bb's `AskUserQuestion` tool isn't injected (10 Q5).
- Timeout → Hermes decides (deny or skip); the bb card closes as "Timed out in Hermes".
- Answered on another surface → the bb card closes as "Answered elsewhere".
- **Never auto-approved:** no bb permission mode answers for the user (ASSUMED A2).
- Stop → Hermes interrupt; the turn ends "interrupted" (271 ms observed, S0-S4 §S4d).
- Send while bb's own turn runs → Hermes steer. Send while idle or during a mirror turn → queued prompt.

AC (isolated Hermes, `approvals.mode: manual`, quoted throwaway paths):
- `deny` leaves the target untouched; `once` runs it once.
- A double answer is handled silently (`already_resolved`).
- Timing out shows the closed state; the clarify answer is used by the model (S0-S4 §S4c).
- Stop ends the turn ≤ 1 s.

## F9 Two-way state sync [P2]

| bb action | Hermes effect | Hermes action | bb effect |
|---|---|---|---|
| pin / unpin | `sidebar{pinned}` | pin in Desktop/Conduit | `threads.pin/unpin` |
| archive / unarchive | `archive{archived}` | archive | `threads.archive/unarchive` |
| rename | `rename{title}` (`"[bb] "` stripped) | rename / Hermes auto-title | `threads.update{title}` |
| open (read) | `sidebar{unread:false}` | read elsewhere (`last_read_at`) | `markRead` |
| delete (open Q1) | none; tombstone | delete | archive + "Deleted in Hermes"; sends refused |

- Latency: ≤ 3 s each way while $HERMES_HOST is awake. bb-side changes made while it sleeps are queued and applied on wake.
- Exempt: bot threads for rename and archive (Q2); ACP threads (untouched).

AC:
- Every row works in both directions with one change per user action (no ping-pong, `revision` +1).
- No Hermes title ever starts with `[bb] `.
- A bb pin made with $HERMES_HOST asleep reaches Hermes within 10 s of wake.

## F10 Notifications [P2]

- Outside activity: each bound thread gets the Settings default level (`inherit|all|input-only|muted`; default `inherit` = normal, D7) via push-notifications `threadNotifications.set` (S1-S3 §S3c). The user can change it per thread as usual.
- bb-started turns: normal bb behaviour. Imports: silent. Bots: same default.

AC:
- At `inherit`, one push per mirrored outside turn; at `muted`, none.
- First import sends 0 pushes.

## F11 bb tools in Hermes [P4]

- The `bb_tools` Hermes plugin adds toolset `bb`:
  - `bb_thread_spawn`, `bb_thread_tell`, `bb_thread_list`, `bb_thread_read`, `bb_thread_wait`;
  - each wraps `bb thread spawn|tell|list|read|wait --json`.
- Enabled per profile; available in every session of an enabled profile, Discord and cron included (11 §5).
- Called from a bb-bound session: it acts as that thread (children are spawned under it).
- Called from an unbound session: list, read and tell work; spawn creates a top-level thread (ASSUMED A12).
- `bb_thread_wait` is capped below Hermes' 420 s tool limit.
- Discord-origin sessions: spawn and tell ask for a Hermes approval (open Q5).

AC:
- In neo (enabled): "spawn a Codex thread that lists ~/src" → a child thread of neo's bb thread; `bb_thread_wait` returns its result.
- A profile without the plugin has no `bb` tools.

## F12 Settings v1 [P0–P2, P6]

| Setting | Default | Phase |
|---|---|---|
| Connection health (read-only): gateway reachable, Hermes version and capabilities (`runtime.describe`), worker last sync, $HERMES_HOST online | — | P0 |
| Default profile | `default` ("Hermes") | P1 |
| Hidden profiles | `todoist` | P1 |
| Hidden models per profile | seeded from `hermes-host/config/bb-models.json`, with `custom:mlx-main` = `mlx-main` (11 §1) | P1 |
| Import sources | CLI, TUI, Desktop, Conduit, Discord on; one-shot, cron off | P2 (Discord P5) |
| Import window | 30 days | P2 |
| Default notification level for outside activity | `inherit` | P2 |

AC: each setting changes the next relevant action without a reload; `bb-models.json` is no longer read.

## F13 ACP retirement [P6]

- Gate (parity): F1–F3, F8 and F9 pass on live, and the user does 1 week of daily Hermes work in bb without falling back to ACP. Fork, reasoning levels, service tiers and slash commands are not included (open Q6).
- `bb provider disable acp-hermes-agent`: the New Thread picker loses it. The 18 threads stay viewable; sends fail (`provider_disabled`, 07 §1). ASSUMED A7: disabled-provider threads still render.
- Their Hermes sessions are never imported (F5 exclusion).
- The 137 empty ACP probe sessions plus spike leftover `local-a6fec510…` are deleted only after the user confirms the listed ids.

AC:
- The 18 threads open and render.
- A send to one shows a clear error.
- 0 Hermes ACP entries in pickers.
- The probe count is 0 after confirmed cleanup.

# bb-plugin-hermes — v1 plan

Status: written 2026-11-07 from D1–D50. Building starts here.
- The old plan, the scope reset and reviews R1–R6 are in [`archive/`](archive/README.md): reference only.
- Pictures: the [interactive site](https://andrewbird81.github.io/bb-plugin-hermes/), or the SVGs embedded below and in `01`–`02`.
- Citations: research `rNN §n`, spikes `S… §…` (`S8 step n` = step n of S8 §Recommended protocol for bb), archived reviews `R… C…`/`M…`, Hermes source `path:line` at `c314285f07`. `ASSUMED` items have an ID and a verify step (04 §Assumptions to verify).

![What runs where](../diagrams/architecture.svg)

## Goal

A public bb plugin that any Hermes user installs to:
- chat with their Hermes bots in bb;
- see every chat of an enabled bot as a bb thread that keeps updating (D42);
- share each bot's one Bot Chat with Hermes' other apps, Conduit included, with no fork or takeover (D44).

Nothing is hard-coded to one setup (D46). Bot names are examples.

## v1 scope

In:
- **Connect:** one setting picks the bb machine that runs Hermes; the Hermes folder defaults to `~/.hermes`. Health shows connection and version support (01 §1).
- **One switch per bot** (D43, D48): on = chat, mirroring and full bb access through a plugin skill; off = absent, threads archived (01 §2).
- **Each bot's pinned thread is its Bot Chat** (D44), shared with Conduit per S8's rules (01 §3, §6).
- **Chats from bb:** pick a bot, model and reasoning; live replies; approvals, `clarify`, Stop, steer, attachments; the bot is fixed per chat (01 §4–§5).
- **Full mirroring** (D42): CLI, TUI, Desktop and Conduit chats of enabled bots; last 30 days imported at switch-on; replies from bb continue the same Hermes session (01 §7).
- **Notifications:** outside activity marks unread; approvals and `clarify` push (01 §8).
- **Hermes icon** on rows (D22) and in the composer.

Later (out of v1):
- Owner-specific: work/personal boundary (D28), Discord approvals (D24), per-bot restrictions (`approvals.deny` globs or a hook, r12 §4), privacy filter for tool results (D36), ACP harness retirement and probe cleanup (D12, D25).
- Extras: switching bot mid-chat and "Continue in bb" (D3, D39); pin/archive/rename pushed to Hermes (D38); Hermes slash commands, manual compaction and fork (D25); a project per chat (D4); subagent sub-threads (D6); import and notification settings (D26, D33); hidden models; a home-composer send-menu row and a keyboard shortcut.
- Chat-app sessions (Discord, Telegram, Slack…), DMs included (D49).
- Operations: the daily Hermes update check (it fetches into its own clone, never the live checkout), the post-update canary, the daily audit, soaks between phases (D20); the import circuit breaker (D41).
- Profiles with their own gateway, outside the host's `served_profiles` (S8 §Per-profile reach).
- Upstream: S8's two race bugs (D50).
- Community marketplace listing.
- Several Hermes installations, one per machine (owner direction, 2026-11-09). Until then, no new single-machine assumption where a per-machine shape costs the same.
- The Hermes icon before each Hermes row's title, as Pi rows have. bb's thread list draws it only for providers in bb's provider list (the New Thread picker and Settings → Providers), so it needs Hermes listed there, reversing D2. The phone layout's Recent list already shows it. Deferred by the owner (2026-11-09).

## Decisions that bind v1

| # | Rule |
|---|---|
| D1 | Plugin code on the Hermes machine reaches chats only through the gateway: tickets from `<folder>/gateway.sock`, canonical `hermes-gateway-v1`, and Hermes' REST projection with a `native-http` ticket (same trust model, R6 C3). No Hermes config edit, network credential or new port |
| D2 | Every Hermes chat bb shows is a real bb thread: Hermes icon, bb-side pin/archive/rename, no machine or harness picker, provider hidden from bb's pickers, works with `bb thread tell/spawn/…` |
| D7 | Outside activity mirrors live with progress. An outside user message is the user's bubble tagged `[Outside bb]` (never an app's name). Notifications follow the v1 rule (01 §8) |
| D11 | Approvals and `clarify` become bb interactions. Never auto-approve |
| D14 | Delegated build: one writer per seam in its own jj workspace; a gate per phase; Claude-family subagents in the background |
| D15 | Tagged outside messages may enter bb's prompt history; bb refuses a send that starts with the `[Outside bb]` tag |
| D16 | A legacy (not gateway-owned) row is adopted only by the first bb send; no Hermes mutation for it before (A23). Plus S8's wait-and-retry |
| D17 | Reasoning in v1. One permission mode, `auto`, declared and tested never to answer an approval (A2) |
| D19 | P1 gate: on the phone, start a chat and chat with a bot from bb; the bot thread then continues in Conduit (S8 §Plan changes) |
| D22 | Hermes icon on rows: a row-metadata badge (A28) |
| D27 | Narrowed: Stop works on bb's own turns and on Conduit turns forwarded into the gateway. Other outside turns show "Running outside bb" |
| D30 | Narrowed: one setting picks the Hermes machine; the folder defaults to `~/.hermes` |
| D42 | Full mirroring: every session of an enabled bot started outside bb appears as a bb thread and keeps updating. No "Continue in bb" step, no P2-lite |
| D43 | One switch per bot. On = chat in bb **and** full access to operate bb, through a plugin-owned skill (S8 §Secondary option 1). Restrictions later. Every bot starts off |
| D44 | Each enabled bot's pinned bb thread **is** its profile's Bot Chat, mirrored both ways. No fork, split, copy, read-only view or takeover; the same for Conduit's other mirrored chats |
| D45 | hermes-webui is out of scope |
| D46 | v1 = basics for a general Hermes user installing a public plugin |
| D47 | The lean v1 scope is accepted with its defaults (archived `scope-reset.md`) |
| D48 | Switching a bot off archives its bb threads; on unarchives them and mirroring resumes |
| D49 | No Discord or other chat-app sessions in v1, DMs included |
| D50 | Leave `compression.in_place` as is (Q24, S8's open question 5); don't file the race bugs (Q25); plugin code lives in this public repo |
| D51 | bb's native New Thread, with the Bot chip, is the way to start a chat. The rail panel is gone (owner, 2026-11-09: "it's not providing any value") |
| Q1 default | No cross-delete. bb delete → tombstone (mirrored chats and side chats; a bot thread is re-created instead), never re-imported. Deleted in Hermes → the thread stays; sends fail "Deleted in Hermes" |
| Q7 default | Imported bubbles carry the outside tag and date (`[Outside bb · Oct 12]`), never an app's name; oldest first; item times are import time |

Superseded, one line each:
- D3 profile chip and handoff → the bot is fixed per chat; handoff Later.
- D4 optional project → Later.
- D5 one pinned thread per bot → kept by D44, bound by title; "hide `todoist`" → per-bot switches.
- D6 Discord and subagent import → D49; subagent sub-threads Later.
- D8, D23, D39 Discord replies, rollover notice, read-only threads and Continue in bb → D49.
- D9, D38 state sync (two-way, then bb → Hermes push) → Later.
- D10, D18, D37, TS.1 native bb tools, then Neo's skills copied to other profiles → D43.
- D12 ACP retirement → Later. ACP sessions stay out by the source list (01 §7).
- D13 settings v1 (default and hidden profiles, sources, hidden models) → connect setting + per-bot switches.
- D20 drift checks → on-connect version check only; daily check, canary and audit Later.
- D21 keep-awake → owner-specific; v1 handles an offline Hermes machine (02 flow 10).
- D24, D28, D36 Discord approvals, work rule, privacy filter → Later.
- D25 slash commands and fork → Later.
- D26, D33 auto-read of the user's own outside turns → one v1 rule (01 §8); refinements Later.
- D29 server git credential → dropped: the repo is public (D50).
- D31, D35 Bot Chat pin, bb-only session per bot → D44, with no Hermes pin.
- D32 deny-list additions → moot: v1 uses a source allow-list.
- D34 go/no-go, success metric, kill criteria → dropped (D47): phases run in order; the owner can stop at any point.
- D40 no history reader before the go/no-go → v1 needs one (02 §History reader). S8 step 6 still says "REST, D40": read it as 02 §History reader.
- D41 deny-list both columns, breaker → the allow-list checks both columns and fails closed; breaker Later.
- Q2 bot titles, Q4 Discord threads, Q8 hermes-host adapter, Q9 project model lists → moot.

## Glossary

| Term | Meaning |
|---|---|
| bot | A Hermes profile served by the host's gateway. Shown by its Bot Mode handle, else the profile name; `default` shows as "Hermes" (r11 §2) |
| Bot Chat | A profile's one session titled exactly `Bot Chat`, hidden in Hermes' lists. Desktop, Conduit, Bot Mode DMs from other bots and bb all write it. Discord DMs never do (r12 §2). Identified by title, never by a stored id (`apps/desktop/src/AGENTS.md:63-86`) |
| bot thread | The bot's pinned bb thread, bound to `(profile home, "Bot Chat")` |
| side chat | A chat started in bb with a bot: its own new Hermes session (Desktop calls these side-chats) |
| mirrored thread | A bb thread for a session started outside bb: CLI, TUI, Desktop or Conduit |
| outside turn | A turn not sent from bb |
| Conduit | A phone app that reaches Hermes through the dashboard's legacy chat socket, as remote Desktop and dashboard chat do (S8 §How Conduit and Desktop share). bb's UI never says "Conduit" (or any app) unless Hermes records it for that exact chat or turn; outside messages read `[Outside bb]` |
| canonical | `hermes-gateway-v1` on the gateway's `/api/ws` (r08 §1). CLI, TUI and local Desktop turns are canonical |
| legacy row | A session the gateway doesn't own yet, e.g. a Conduit chat (`source=desktop`, no `chat_id`); `session.resume` adopts it (r12 §6) |
| adoption | The gateway taking ownership of a legacy row; irreversible (R1 M7) |
| server part / host worker / bridge | Plugin code on the bb server / one long-lived process on the Hermes machine / one process per hosted thread on the Hermes machine |
| hosted | A thread with a live bridge process |
| history reader | Read-only access to Hermes chats through Hermes' REST projection (02 §History reader) |
| profile home | Hermes `profile_id` (home path) |
| lineage root / tip | A chat's logical id (`chat_id` owner), stable across compaction / its current physical session id |
| anchor | The `message_uid` of a turn's user message (or first reply message): the dedupe key |
| binding | A mapping-db row: bb thread ↔ (profile home, lineage root) |
| marker | Agent-only `<hermes-bb>{…}</hermes-bb>` input to the bridge; never rendered |
| wake | A server `threads.send` that starts a mirror turn in a thread |
| replay / mirror turn | A bb turn that renders past history / an outside turn; never `prompt.submit` |

## Files

| File | Content |
|---|---|
| `01-product.md` | What the user sees, feature by feature, with acceptance criteria |
| `02-architecture.md` | Components, contracts, protocol mapping, flows, invariants, bb access and security |
| `03-testing.md` | Test layers, strict fake Hermes, isolated bb and Hermes, phase gates |
| `04-delivery.md` | Layout, phases, tasks, assumptions, dev loop, release, rollout, rollback |
| `05-risks.md` | Top risks |
| `archive/` | Old plan (`README.md`, `BRIEF.md`, `01`–`05`), `scope-reset.md`, `reviews/` |
| [`../diagrams/README.md`](../diagrams/README.md) | Pictures with captions, and how to re-render them |

## For the owner to confirm

Settled by this plan; each is reversible:
1. **Import for a bot switched on later:** runs at every switch-on, for that bot's chats active in the 30 days before it, that have no bb thread yet. Older turns of a long chat (a Bot Chat) stay in Hermes, with a note at the top of the thread. Switching back on also catches up bound threads.
2. **Import count:** shown on the switch row before you turn it on ("Imports 12 chats from the last 30 days"). No separate confirm step: the switch is the consent, the import is silent, and switching off archives it all again.
3. **How CLI and TUI save chats:** neither writes `state.db`. Both run every turn in the gateway as canonical work (`hermes_cli/gateway_agent.py:1-8`, `hermes_cli/gateway_session_store.py:1-14`, `ui-tui/CANONICAL_GATEWAY.md:1-9`). Only Conduit's own dashboard turns are saved outside the gateway. So CLI, TUI and Desktop turns can stream live in bb; Conduit's appear in two steps.
4. **History reader:** Hermes' REST projection over a `native-http` ticket, Desktop's own path (R6 C3). `node:sqlite` read-only only if REST lacks a field (T0.5).
5. **Which outside chats mirror:** an allow-list, CLI, TUI, Desktop and Conduit, visible sessions plus the Bot Chat. ACP, API server, `a2a`, tool, subagent, cron, one-shot, chat-app and hidden sessions stay out.
6. **The skill reaches existing chats:** after writing or deleting the skill, the worker runs `hermes -p <profile> sessions refresh-prompts`. A continuing session (the Bot Chat) otherwise keeps its old system prompt (`hermes_state_prompt_refresh.py:1-8`). Cost: one prompt-cache miss per continuing session of that bot.
7. **`/new` and `/reset`** become a compaction in every Hermes thread, not only bot threads: a bb thread keeps one Hermes chat.
8. **Entry points:** the pinned bot thread, bb's New Thread with the Bot chip (D51), and `bb thread spawn`. The home-composer row and the shortcut are Later.

Flagged gold-plating, kept because a decision requires it: live streaming of outside CLI/TUI/Desktop turns (D7; one mirror mode and A19 could go); the source-tag refusal (D15).

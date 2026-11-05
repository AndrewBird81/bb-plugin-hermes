# Scope reset: v1 for a general Hermes user

**Status:** proposal, 2026-11-04, awaiting the user's OK (Q22–Q25 below).
- Decisions D42–D46 are recorded in `README.md` but not yet applied to `01`–`05`.
- The lean rewrite starts from this file plus S8 (`docs/spikes/S8-conduit-shared-conversation.md`). The old plan becomes reference material and the source of the Later list.
- Evidence for the parent's checks: `docs/research/12-verification-log.md` (cited `r12 §n`).
- Pictures of this proposal, with captions: [`../diagrams/README.md`](../diagrams/README.md). Four are also embedded in their sections below. The rewritten plan embeds them and keeps them current.

## User decisions

- **D42, full mirroring (was Q18).** In the user's words: "Sessions started outside bb, including Conduit, should automatically appear as bb threads without requiring 'Continue in bb.'"
  - So there is no P2-lite, and R6's message-share metric is not adopted.
- **D43, one switch per bot (was Q19).** One setting per bot on the plugin's settings page.
  - On, the bot is available to chat with in bb **and** has full access to operate bb.
  - Restrictions come later.
  - Not hard-coded to Neo, and not every bot by default.
  - This is a design decision, not approval for any live change.
- **D44, one shared conversation (was Q20, plus the user's clarification).**
  - Each enabled bot keeps one pinned bb thread, and that thread **is** the profile's single Bot Chat, mirrored both ways.
  - Replies from bb and from Conduit stay in that one conversation:
    - no fork, split, copy or read-only view;
    - no takeover that stops Conduit from continuing.
  - The same holds for Conduit's other chats that bb mirrors.
  - Coordinate only as much as needed (S8).
- **D45, hermes-webui (was Q21).** Leave it alone; it is not part of this work. Its usage findings are in r12 §3.
- **D46, scope.** v1 covers the basics for a general Hermes user who installs a public bb plugin.
  - Deferred: the user's work/home split, edge-case permissions, path restrictions, and any elaborate multi-client policy.
  - D42–D44 stay.

## Proposed v1 (Q22)

![What runs where (proposed v1)](../diagrams/architecture.svg)

- **Connect:**
  - one setting picks the bb machine that runs Hermes; the Hermes folder defaults to `~/.hermes`;
  - health shows whether Hermes is connected and whether its version is supported.
- **Settings:** one switch per bot (D43), and the page says what turning it on grants.
- **Chats from bb:**
  - pick a bot, a model and a reasoning level;
  - replies stream live;
  - Hermes' approvals and questions (`clarify`) appear in bb;
  - Stop, steer and attachments work;
  - the bot is fixed for the whole chat.
- **Full mirroring (D42):**
  - every session of an enabled bot appears in bb and keeps updating: CLI, TUI, Desktop, Conduit;
  - the last 30 days are imported once;
  - cron and one-shot sessions stay out.
  - Discord: Q23.
- **Shared conversation (D44):** a reply from bb continues the same Hermes session, Bot Chats included, following S8's rules.
- **Notifications:** outside activity marks the thread unread. Approvals and `clarify` send a push.
  - This simplifies D26/D33 to one rule. Auto-reading the user's own outside turns becomes a later refinement.
- **Hermes icon** on thread rows and in the composer.

## Later (backlog, out of v1)

- **Specific to this user's setup:**
  - the work/personal boundary (D28) and Discord approvals (D24);
  - per-bot restrictions, e.g. `approvals.deny` globs or a hook (r12 §4);
  - the privacy filter (D36);
  - retiring the ACP harness (D12, D25), including deleting its 137 empty sessions.
- **Extras:**
  - switching bot mid-chat (handoff, D3) and "Continue in bb";
  - pushing pin, archive and rename to Hermes (D38);
  - Hermes slash commands and fork (D25);
  - a project per chat (D4);
  - subagent sub-threads (D6);
  - import settings, and finer notification rules (D26, D33).
- **Operations:**
  - the go/no-go and kill criteria (D34);
  - the daily Hermes update check (D20). When it returns, it fetches into its own clone, never the live checkout (parent default, already told to the user);
  - the post-update canary and the daily audit;
  - the 7-day soaks between phases.
- **Upstream:** S8's two Hermes race bugs (Q25).

## Defaults to confirm with Q22

- **Repo:** keep this repo private as the design archive, and publish the plugin from a clean public repo.
  - These docs name tailnet hosts, paths, profiles and session ids.
  - With a public repo, D29 (`gh auth setup-git` on the bb server) isn't needed.
- **No privacy filter in v1 (D36 deferred):** mirrored threads copy tool results into bb, Conduit health and location included.
- **No go/no-go (D34 dropped):** phases run in order, and the user can stop at any point.
- **The per-bot switch.** Parent defaults, not yet shown to the user:
  - every bot starts off;
  - a bot that is off is absent from bb entirely: no chat, no mirroring, no access;
  - switching a bot off removes the plugin's skill and wrapper (below);
  - Neo's own bb skills (`~/src/hermes-config`) are left untouched.

## Shared conversation: rules for bb (S8 §Recommended protocol)

![bb and Conduit share one Bot Chat](../diagrams/shared-bot-chat.svg)

![What bb does when Conduit holds the chat](../diagrams/shared-wait.svg)

1. **Bind by title.** The bot thread is `(profile home, "Bot Chat")`, resolved by title on each send and re-list, as Hermes Desktop does.
2. **Create lazily.** If no Bot Chat exists, create it on the user's first message, not at setup. `session.create` returns an existing Bot Chat if one appeared meanwhile.
3. **Wait, never fork.** On `runtime_coordination_required`, Conduit holds a chat the gateway hasn't adopted yet.
   - Keep the send queued and retry with backoff.
   - Show "Open in Conduit: sends when it's free".
   - Never create a second chat, and never take over.
4. **Send through the gateway queue.**
   - Use one `submission_id` per message, and never resend automatically.
   - Adoption on the first bb send stays (D16). Conduit keeps working afterwards (S8 E10).
5. **Mirror Conduit's own turns from history.** The user message appears at once and the reply when the turn ends; they don't stream.
   - A Conduit message forwarded into the gateway during a bb turn streams live.
6. **Stop:**
   - works on bb's own turns, and on Conduit messages forwarded into the gateway;
   - doesn't work on a turn Conduit is running itself: the button reads "Running in Conduit".
7. **After a gateway restart:** run `prompt.resolve_unknown` for bb's own unknown turns at once, then offer "Hermes restarted: resend?". Parent default, already told to the user.
8. **Never reset a bot thread.** `/new` and `/reset` in a bot thread become a compaction.
9. **Accepted for v1:** two rare Hermes race bugs (Q25). Neither lost a message:
   - both apps sending within about 50 ms;
   - a compaction that rotates the session id.

## bb access for an enabled bot (S8 §Secondary)

![What the per-bot switch does](../diagrams/bot-switch.svg)

Parent default, already told to the user:
- The host worker writes one wrapper, `<plugin data>/bin/bb-hermes`. It sets `BB_SERVER_URL` only when the bb server is remote, then runs `bb`.
- For each enabled bot, it writes a plugin-owned bb skill that calls the wrapper to `<profile>/skills/bb-plugin-hermes/`, with a marker file.
- It needs no `config.yaml` or `.env` edit and no restart, and survives Hermes and profile updates.
- Switching a bot off deletes its skill, and the wrapper once no bot is on.
- The skill is general, not Neo's. Neo's setup is an example only (r12 §4).

## Pending user answers

| # | Question | Recommended | Alternative |
|---|---|---|---|
| Q22 | The v1 scope above, with its defaults | Accept | Adjust the lists |
| Q23 | Discord. The user proposed dropping Discord, except that a direct DM with a bot goes to that bot's thread | Mirror no chat-platform sessions (Discord, Telegram, Slack…), with no exception. A DM is a separate Hermes session with its own context, and nothing routes it into the Bot Chat (r12 §2). Bot-to-bot messages already land in the Bot Chat | Mirror DMs as separate read-only threads. Making a DM the same conversation as the bot thread would need a Hermes change |
| Q24 | Optional (S8 open question 5), the user's own Hermes config: `compression.in_place: false` in `default` (r12 §5). With bb and Conduit both writing the Bot Chat, a rotating compaction can interleave rows | Leave it in v1 | Set it to `true`, Hermes' default |
| Q25 | File S8's two race bugs upstream (S8 open question 1)? That is public | Only with the user's OK | Don't file |

## What the rewrite changes

| Old | New |
|---|---|
| D35 (bb-only session per bot) | D44: the bot thread is bound to the Bot Chat by title, restoring D5's binding. Remove "Bot Chat sharing with Conduit and Desktop" from Out. Fix the glossary entry for Bot Chat |
| D37, TS.1, D18, D24, D28 | D43: the switch plus the plugin-owned skill. Restrictions go to Later |
| D13 "hidden profiles" | The per-bot switches (parent reading) |
| D34 go/no-go | Dropped, if Q22 is accepted |
| D39 (Discord read-only, Continue in bb) | Per Q23 |
| D16 | Keep adoption on the first bb send; add S8's wait-and-retry |
| Flow 4 (mirror) | Conduit turns: the user row at send, the reply at the end. A foreign admission on bb's subscription renders live, so fix the "only our admission" filter |
| Flow 10 (reconnect) | `prompt.resolve_unknown`, also added to `contract/used-surface.json` |
| Protocol mapping | `session.mutate compress` needs `expected_generation`; S8's Stop rules |
| Assumptions | Add A-S8a–d (S8 §Plan changes) |
| T3.7 and the webui approval | Removed (D45) |
| D29 | Not needed, if the plugin is published publicly |
| D40 (no history reader before the go/no-go) | v1 needs one for the 30-day import and for Conduit's own turns (D42). Choose Hermes' REST projection or `node:sqlite`. S8 still cites "REST, D40" |
| D27 (Stop on mirrored turns) | Stop works only on bb's own turns and on Conduit turns forwarded into the gateway. A turn Conduit runs itself shows "Running in Conduit" |
| D26, D33, 02 flow 4 (auto-read your own outside turns) | v1: all outside activity marks the thread unread; only approvals and `clarify` send a push |
| D30 (two settings: Hermes host and root) | One setting picks the Hermes machine; the folder defaults to `~/.hermes` |
| D36 (privacy filter in 02's bridge) | Later |
| D6 (Discord as read-only threads) | Per Q23, with D39 |
| 02 flow 8 and `turn/start` (bot chat created with `title:<handle>`, D35) | D44: find the Bot Chat by title; create it on the first message |
| S8's "Q5" | S8's open question 5, now Q24 |

Not settled in any doc. Decide these in the rewrite (found while drawing `docs/diagrams/`):
- When the 30-day import runs for a bot switched on later.
- What happens to a bot's bb threads when the bot is switched off.
- Whether v1 keeps 02's step where the user confirms import counts.
- How CLI and TUI chats reach saved chats. The diagrams assume they write them directly; confirm in source.

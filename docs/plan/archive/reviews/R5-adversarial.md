# R5 — Adversarial review

Read-only, 2026-11-04. Hermes `c314285f07`, bb 0.48.1, SDK 0.6.104.

Labels: VERIFIED (checked by me; command or file:line given), SUSPECTED (inferred), ASSUMED (not checked). Counts come from `sqlite3 -readonly` on all five `state.db` files unless noted.

## Verdict
- **Build a smaller v1, then decide.**
  - v1: P0, P1 without handoff, on-demand "Open in bb" import, bb→Hermes state sync, ACP retirement. About 39 of 68 tasks.
  - Then decide on mirror, bots, Discord and `bb_tools` from 4 weeks of usage and upkeep data.
- **Why: the costly half serves little observed demand.** Last 30 days, visible user messages (VERIFIED):
  - about 21 via bb ACP;
  - about 29 outside bb: Discord 15, CLI 8, Desktop/Conduit 6 (2 of those in Bot Chats).
  - Across all 455 Hermes sessions ever: 1 pin, 11 archives, 0 read marks.
- **Single biggest risk: silent semantic drift.** Core surfaces are weeks old on a canary that averages 389 commits a day, and the TypeScript store reader re-implements Hermes' display rules. The drift check sees structure, not meaning, so breakage shows as duplicate or missing turns, not errors (C2).
- **Runner-up:** the work boundary (D28) can already be bypassed (C3).
- **Confidence:** high on the measurements. Medium on the verdict: it flips if the user expects most Hermes use to move into bb (the steelman for D2 and D7).

## Top challenges (ranked by impact)

### C1. Scope outruns demand (README Goal/Scope; 04 P2–P5)
- **Claim:** every Hermes session is live, two-way and bot-aware in bb.
- **Challenge:** P2–P5 (28 tasks, 5 of the plan's 11 gated live approvals) serve about one outside message a day.
- **Evidence (VERIFIED):**
  - The deny-list import set is about 19 sessions.
  - Discord: 8 sessions in 30 days.
  - Bot Chats: default and david idle since 2026-08-22.
  - Subagent sessions: 1, ever (r04 §6).
- **Steelman:** usage is low *because* ACP is poor, and Conduit is two days old.
- **If right:** P2–P5 carry most of the risk (C2, C3) and most of the upkeep, for about 29 messages a month.
- **Effort is not the problem.** The user's own Code Review Workspace plugin shipped 1,356 commits and 28 tags in 10 weeks (VERIFIED, `git log`).
- **Recommendation: change.** Ship the smaller v1 with an explicit go/no-go and kill criteria.

### C2. Young foundations on a fast canary; the drift check can't see meaning (D20; 02 store rules; 05 R1–R3)
- **Claim:** the drift check plus the fail-safe keep Hermes churn safe.
- **Churn (VERIFIED, `git log`):** 11,665 commits in 30 days. Contract file: 171 commits; `session_controls.py`: 112.
- **Age of what the plan rests on (VERIFIED):**
  - canonical methods first declared 2026-10-07 (`a03c71c31a`);
  - `message_uid` 2026-09-29; `ctx.post_message` 2026-10-18; `admission_author` 2026-09-11;
  - `SCHEMA_VERSION` went 18 → 32 between 2026-07-05 and 2026-10-17.
- **The user's updates (VERIFIED, reflog):** 12 between 2026-08-05 and 11-03. The last one spanned 3,963 commits:
  - 0 canonical method changes;
  - 24 component schemas changed; the 8 the plan reads only gained fields, apart from one unused field dropped;
  - 87 changed lines in `session_ingress.py`, 84 in `hermes_state_messages.py`.
- **Legacy methods (VERIFIED):** `model.options`, `commands.catalog` and `slash.exec` sit in the contract's legacy `methods`, not `x-canonical-methods`.
- **Gaps:**
  - The drift check covers methods, columns, symbols and two function hashes. It misses new row kinds, a moved author field, adoption rules and event order. Those fail silently, so the fail-safe never trips.
  - The manual check "before `hermes update`" reads the *installed* checkout, so it can't see the incoming version (SUSPECTED, from the 03 §9 wording).
- **Estimate (SUSPECTED):**
  - the schema check flags on about every other update;
  - 1–3 h a month of triage, plus a 0.5–2 day semantic fix every 1–2 months;
  - bb adds a second treadmill: 7–13 stable releases a month (VERIFIED, `npm view bb-app time`) against about a dozen `experimental_*` APIs;
  - the plugin becomes a brake on `hermes update`.
- **If right:** upkeep is a standing cost, and the worst failures are silent.
- **Recommendation: change.**
  1. `contract:check --incoming`: `git fetch`, then check the contract, schema and symbols on `origin/main` via `git show`.
  2. A semantic canary after each update: scripted create, compact, `/retry` and steer on isolated Hermes, diffed against golden reader output.
  3. A daily `audit` RPC in health: Hermes anchors vs bb `turns` per binding (duplicates, gaps).
  4. An upkeep budget in the kill criteria.

### C3. bb tools: the boundary is on the wrong axis, and bypassable (D10, D18, D24, D28; 02 flow 15)
- **Claim:** D24 approvals, D28 checks and the argument allowlist contain `bb_tools`.
- **Spawned children can read work threads (VERIFIED):**
  - from this $HERMES_HOST thread, `bb thread list --machine $WORK_HOST` returned 185 threads;
  - a Hermes-spawned child gets the project's remembered permission mode (`bb thread spawn --help`: `--permission-mode accept-edits|auto|full`, omitted = project default) plus the bb CLI;
  - D28 checks only Hermes' own target. So spawn → the child reads $WORK_HOST → `bb_thread_wait` hands the text back.
- **neo can already cross it, without `bb_tools` (VERIFIED):** `BB_SERVER_URL` is in `profiles/neo/.env` (key name only). Its skills `bb-start`/`inquire`/`reply`/`review` start work threads ("Work or personal, per dev-setup") and approve or deny.
- **D24 gates by surface, but injection rides on content in any session.** No approval on (VERIFIED):
  - `api_server` (connected, `gateway_state.json`);
  - david's `a2a` (configured);
  - Bot Mode `message_agent`, which lands in another bot's Bot Chat as a CLI turn (`tools/bot_mode_dm.py:1-13`).
- **"$WORK_HOST project" is undefined for 4 of 26 projects** with checkouts on both hosts (VERIFIED, `bb project list --json`).
- **Desktop "Approvals: off" bypasses plugin approvals too** (`tools/approval.py:1017-1021`, VERIFIED).
- **Worst plausible incident:** an injected or bot-DM'd turn in a non-Discord session spawns a coding agent at the remembered (possibly `full`) mode. It reads $WORK_HOST threads, or runs commands Hermes' smart approvals would have stopped. Hermes relays the result to Discord or Conduit.
  - Prevented: no. Detected: only by log review.
- **If right:** the boundary needs a different axis, or should be declared advisory.
- **Recommendation: ask (Q2, Q3).** Minimum if `bb_tools` stays:
  - approval for spawn and tell unless the turn author is `bb:`;
  - force `--permission-mode auto` on Hermes-spawned children;
  - dual-host projects count as work;
  - decide neo's terminal path explicitly.

### C4. Architecture: strongest alternatives (02 Components, Contracts)
- **Claim:** the chosen design is the simplest fit. **If right** (the alternatives win): two changes cut private surface (reader, bindings); the rest holds.

| Plan element | Strongest alternative | Its cost | Recommendation |
|---|---|---|---|
| D1 Local: one bridge per hosted thread, plus a host worker | Keep bb's ACP provider for chats started in bb; build only the sync. Hermes' ACP adapter is a canonical client in the same repo, so it moves with the gateway (`acp_adapter/gateway_server.py`) | No profile chip (bb #2787 open, low priority); no clarify (`source:acp`, S0-S4 T3); no archive or rename | Keep D1 |
| TypeScript reader on the private `state.db` | Hermes' own reader in its venv: `SessionDB(read_only=True)`, `get_messages_as_conversation`, `display_projection`. `session.history` uses these (`gateway/session_tui_ops.py:130-132`); the ACP adapter lists sessions this way (`acp_adapter/catalog.py:18-19`). Import takes 0.13–0.31 s (VERIFIED) | A Python helper process and a private Python API. But it is co-versioned with the installed Hermes, and drift fails loudly instead of misrendering | Change: spike it in T0.4 beside `node:sqlite` |
| Mirror: a tagged `threads.send` per outside turn | Catch-up on open or send (one wake for all new turns), or a plugin activity panel | Loses the live spinner and unread; a panel breaks D2 | Keep it if a mirror ships; defer the mirror (C1) |
| `bb_tools` plugin in 4 profiles | neo-style skills + terminal (already exist), plus a hook that tells the model its bound thread id | Less structure; Hermes' command approvals apply instead of the D24 hooks | Ask (Q3) |
| `bindings.json` file contract | `bb_tools` resolves the binding per call with `bb plugin rpc call hermes …`; it already shells out to `bb` | One more CLI call per tool call (0.1–0.3 s, ASSUMED) | Change: no file, no version skew, no live-write bugs like R4 M2 |
| Upstream Hermes | A PR: canonical `session.history` on cold rows without adoption, returning `message_uid` and author; per-session change events | 34,360 open PRs (VERIFIED, `gh api`); core merges its own same-day; outside odds unclear | Try in parallel; never depend on it |
| Upstream bb | A native Hermes provider, or an ACP profile picker | Not on a roadmap (#2787 "Priority: Low", VERIFIED) | Keep the provider and the sync separable |

### C5. Hidden irreversible Hermes writes (D16, D31)
- **Claim:** reading never writes Hermes; legacy rows are adopted only on the first bb send (02 invariants).
- **State sync claims legacy rows** (SUSPECTED: code read, not run):
  - `session.mutate` on an unrouted pre-migration row inserts a `gateway.history_control.v1.<sid>` claim bound to the caller (`gateway/session_mutations.py:174-183` → `hermes_state_mutation_binding.py:74-98`, `claim=True`).
  - So syncing pin, archive, rename or read on a legacy import writes ownership: the write D16 avoids.
  - Scope (VERIFIED): up to 8 unrouted rows in the 30-day import window. Hermes clients already made 3 such claims in `default` (`state_meta`), so the impact is probably benign.
- **D31** writes `pinned:true` into a hidden canonical Bot Chat for a bb-only cosmetic. The effect on Desktop and Conduit is untested.
- **If right:** state sync needs a legacy exemption.
- **Recommendation: change.** No Hermes writes for `legacy` bindings until adopted (add to A23). Pin bots in bb only.

### C6. Testing realism and gates (03 §5 and gates; 04 Rollback)
- **Claim:** the strict fake and the phase gates catch real failures. **If right** (they don't): silent defects pass; add snapshots, soak and the audit.
- **The fake is circular:** its `state.db` follows the reader's own model. Use recorded snapshots only (isolated Hermes after scripted scenarios) for store-reader tests.
- **The strict fake must validate the legacy `methods` list too:** the plan's legacy calls aren't in `x-canonical-methods` (VERIFIED).
- **No soak:** rare events get one deliberate try: compaction (no Bot Chat ever compacted, r11 §3), the 04:00 rollover, a gateway restart. From P2 on: 7 days with a clean audit before the next phase.
- **Live approvals differ from tests:** live runs `approvals.mode: smart` in every profile (VERIFIED configs); tests use `manual`. Live dogfood needs a command smart mode escalates.
- **Roll forward only: acceptable.** `bb plugin disable hermes` is an instant kill switch. The Hermes half rolls back separately (4 profiles; `reload-plugins` also reloads Conduit).
- **Other incident classes:** data loss (bindings) is prevented by procedure (`VACUUM INTO`), not code; Discord spam is mostly prevented (markers never submit; `submission_id` dedupe), with a residue from agent `tell`s; deletes are prevented (no cross-delete; cleanup confirmed and backed up); adoption only partly (C5).

### C7. Not considered by the plan (05 R21; README Goal)
- **Claim:** privacy and value are covered. **If right** (they aren't): the user must accept the data copy and set a success metric.
- **Privacy domain:** imports and mirrors copy turns, tool results included, to $BB_SERVER_HOST (`/home/node/.bb`, VERIFIED `bb status`).
  - This includes Conduit phone tools (`conduit_health`, `conduit_location`; r04 §3D) and Home Assistant and Todoist data. R21 names the copy but only mitigates logs.
  - Render sensitive tool results by name only, or the user accepts.
- **Read state is dead:** Hermes `last_read_at` is unset on all 455 sessions (VERIFIED). Hermes→bb read sync never fires, and under D26 every user-started outside turn leaves a dot only bb can clear.
- **No success metric** anywhere, so nothing decides whether P2+ paid off (see Kill criteria).
- **Hermes is building its own hub:** Desktop remote, the Webapp, and an Android app (PR #148690, merged 2026-11-04, VERIFIED).
  - Hermes merged 404 `NousResearch/bb/*` branches in 120 days (VERIFIED). If those are bb-made branches (SUSPECTED), its maintainers use bb, and a native integration is plausible.

## Challenges to the user's decisions
| # | Steelman | Counter-argument | Recommendation |
|---|---|---|---|
| D2 every session a bb thread | One inbox; bb tooling on all | "Every" = ~19 imports, daily Discord rollovers, a permanent hidden-provider workaround | Keep identity; on-demand import first |
| D3 chip + handoff | Matches the user's model; S7 verified | Rare action; 3 tasks + A17 + race refusal on the P1 critical path | Keep chip; lock after first message; handoff later |
| D5 bots on Bot Chat | Shared with Conduit; one tap | 2 Bot Chat messages in 30 days; Conduit's legacy writer forces polling; D31 | bb-native pinned home thread per profile (Q5) |
| D6 30-day import; nested subagents | "All my threads" | Fine at ~19 sessions; subagents: 1 ever | Keep window; on-demand list first; defer nesting |
| D7 outside messages as user bubbles | Reads as one conversation (S7 §8) | Misattributes non-user authors; ↑ recall can resend `[Discord] …` into a Discord-bound thread | Keep; `message.dispatch` hook refuses sends starting with a source tag |
| D8 Discord replies + echo | Discord channel stays readable | Only the user is allowed on Discord (A39); echo rests on a 17-day-old API + a private contextvar | Drop the echo; Discord sessions read-only in bb (Q4) |
| D9 two-way pin/archive/rename/read | Consistent clients | Hermes side ever: 1 pin, 11 archives, 0 read marks (VERIFIED); costs conflict logic, " (2)" titles, legacy claims | bb→Hermes only (Q4) |
| D10 native bb tools everywhere | Structured; children nest | Duplicates neo's skills; widest security surface (C3) | Ask (Q3) |
| D15 tags in prompt history | Accepted cost (S7 §8) | Same resend risk as D7 | Keep, with the dispatch hook |
| D22 row-metadata icon | Cheap; degrades gracefully | Experiment flag | Keep |
| D23 rollover notice | Honest | Moot if Discord replies are deferred | Keep if Discord ships |
| D24 approval only if Discord-origin | Little fatigue | Wrong axis: content carries injection; api_server, a2a, bot DMs bypass (C3) | Approval unless author is `bb:` (Q2) |
| D25 slash + fork before retirement | ACP parity | Slash rides legacy methods (VERIFIED); fork feasible via `branch{through_message_id}` (`hermes_state_mutations.py:58-68`); usage unknown (0 persisted slash messages, but ACP intercepts them) | Keep as the P6 gate; drop F14 from P1 exit |
| D26 no push for user-started | Avoids double push | Dots never auto-clear (C7) | Also `markRead` user-started outside turns |
| D27 Stop interrupts outside turn | bb as control center | Stop pressed to clear a stuck spinner can kill a long Discord task | Keep (low volume) |
| D28 work boundary | Protects work data | Bypassed by children and neo; dual-host undefined (C3) | Ask (Q2) |
| D29 `gh auth setup-git` on server | Small increment: server `gh` already holds a `repo`-scope token used by everything there (Code Review Workspace `docs/guide.md:31,840,870`, VERIFIED) | Only this plugin would need a server git credential; the user's other plugins are public repos (VERIFIED `gh repo view`); `~/.gitconfig` persistence in the container unknown | Prefer public code in the existing `bb-plugins` monorepo via `--subdirectory`, docs private; else keep D29 + `git ls-remote` in health |
| Q1 no cross-delete | Safe | — | Keep |
| Q2 bot titles never sync | Bot Mode needs the exact title | — | Keep |
| Q4 thread per Discord session | Simple identity | Daily fragments (~8/month) | Keep |
| Q7 import-time stamps | bb can't backdate | — | Keep |
| Q8 commit adapter, delete at P6 | Avoids loss | — | Keep |
| Q9 one model list per project | Rare | Silent wrong-model risk (S7 finding 6) | Keep, with warning |

Q3, Q5 and Q6 became D23–D25 (rows above).

## Challenges to parent-triage decisions
| # | Call | Challenge | Recommendation |
|---|---|---|---|
| D16 | Legacy read-only until first send | Sync mutations still claim legacy rows (C5) | Extend: no Hermes writes for `legacy` |
| D17 | Reasoning in P1; one permission mode | Modes are only `accept-edits`, `auto`, `full` (`bb-plugin-sdk.d.ts:4348-4352`, VERIFIED); which one "never auto-answers" is unstated | Name it; test in T1.2 |
| D18 | `tell` to any thread | Rationale stretches D2 (bb tooling reaching Hermes threads); R1 M10's descendants rule still satisfies D10 | Wrong call: descendants or `bb:` turns only |
| D19 | Phone in P1 gate | — | Keep |
| D20 | Drift check on version change; manual pre-update check | Pre-update check sees the old version (C2) | Fix with `--incoming` |
| D21 | Keep-awake already on | — | Keep |
| D30 | Host + root settings | Good; also keeps machine names out of code, enabling public code (D29) | Keep |
| D31 | Push bot pin into hidden Bot Chat | Hermes write for a bb cosmetic (C5) | Wrong call: pin in bb only |
| D32 | Deny `a2a`, `tool`; `[API]` tag | — | Keep |
| D33 | User-started by source/author | Desktop/Conduit admissions carry no author, only `display_v1` (VERIFIED): the split is by source in practice | Keep; say so |

## Assumptions most likely to fail
| Assumption | Status now | Why it matters |
|---|---|---|
| A19 viewer gets another client's live events | Never observed (S4f sent no prompts) | Core of the live mirror |
| A30 plugin slots on bb mobile | Unverified | D19 gate |
| A31 canonical slash catalog | VERIFIED false as worded: only legacy `commands.catalog`/`slash.exec` (`session_controls.py:219-221`) | D25 rides legacy methods |
| A5 Conduit distinguishable | VERIFIED no: no `conduit` source in any DB; desktop admissions hold only `display_v1` | D28/D33 fold Conduit into Desktop |
| A23 adoption only on first send | Contradicted by mutation claims (C5), SUSPECTED | D16 |
| A35 project host decides "$WORK_HOST" | 4 dual-host projects (VERIFIED) | D28 |
| A4 `turn_author` persists | Untestable from current data: no admission carries it yet; no client sends it (VERIFIED) | Dedupe of bb's own turns |
| Unlisted: Hermes `last_read_at` reflects reads | VERIFIED false (0 of 455) | F9, D26 |
| A8 `message_uid` stable | VERIFIED backfilled (0 NULL); 227 of 998 recent `default` rows inactive | Dedupe needed and feasible |
| A34 checkpoint fork | VERIFIED in code (`through_message_id`) | Low risk |
| A36 SQLite binding | VERIFIED: daemon Node v24.21.0 `node:sqlite` `readOnly` works (temp WAL db) | Low risk |

## Smaller-v1 option
- **In:**
  - P0 as planned (12 tasks).
  - P1 without handoff (17): chats; chip locked after the first message; models, reasoning, attachments, approvals, clarify, Stop/steer; titles, projects, reconnect; phone gate; slash + fork (D25).
  - bb→Hermes pin/archive/rename for sessions bb created (2).
  - A "Hermes sessions" rail list with "Open in bb" (4): static import of one session from the store; a bb send adopts it. Discord sessions open read-only.
  - ACP retirement and docs (4).
- **Out, behind the go/no-go:** live mirror and wakes; Hermes→bb sync; bulk import and notification policy (D26, D27); subagent nesting; bots on Bot Chat; `bb_tools`; Discord replies and echo; handoff; webui retirement.
- **User loses:**
  - live view and unread for Discord/CLI/Conduit turns (opened on demand instead);
  - Bot Chat sharing with Conduit; replying into Discord from bb;
  - native bb tools (neo's skills remain); Hermes-side pins shown in bb.
- **User keeps:** everything ACP does today, plus profiles, clean model lists, archive/rename, clarify, attachments, no probe sessions, and every Hermes session on demand.
- **Size:** ~39 tasks vs 68. Drops the WAL watcher, wake atomicity, three mirror modes, the D24/D28 hooks, private echo symbols and Bot Chat co-writing.

## Kill criteria
- **Usage:** 3 weeks after P1, bb-started Hermes messages per week below the ACP baseline (~10/week: 19 visible in 14 days, VERIFIED) → stop at P1.
- **Upkeep:** either → freeze features; consider a retreat to ACP + skills:
  - over 4 h/month, averaged over 2 months;
  - the plugin delays a `hermes update` by over 7 days, twice.
- **Silent drift:** the audit finds duplicates or gaps in more than one week of a month → live mirror off; on-demand import only.
- **Security:** $WORK_HOST data reached outside a `bb:`-authored turn, or an unapproved destructive child action → disable `bb_tools`; re-decide Q2.
- **Obsolescence:**
  - bb ships Hermes profiles or a canonical provider, or Hermes exposes uids and authors publicly → migrate within one release;
  - Hermes moves Conduit to canonical → delete the polling mode.
- **Exit cost (SUSPECTED, ~1 h):**
  - Reversible: `bb plugin disable hermes`; `plugins disable` + remove `bb_tools` in all 4 profiles and their config entries; `<hermesRoot>/bb_tools/`; the server git helper (D29).
  - Irreversible but benign: adopted legacy rows and history claims, Bot Chat pins, " (2)" titles, synced pins/archives/renames, deleted ACP probes (backed up).
  - bb: Hermes threads stay, read-only. Never `remove` without the `VACUUM INTO` copy.

## Questions for the user
1. **Scope**
   - **Smaller v1, then go/no-go (recommended).** Pros: ~39 tasks; far less upkeep and risk; decided on data. Cons: no live mirror, bots or Discord until the data says so.
   - **Full plan with a go/no-go after P1.** Pros: vision intact. Cons: P2 starts by default.
   - **Full plan as written.** Pros: everything. Cons: most upkeep and risk, for ~1 outside message a day.
2. **Work boundary**
   - **Real, enforced by author (recommended):** approval unless `bb:`; children forced to `auto`; dual-host = work; neo's terminal path decided. Pros: closes the child bypass. Cons: prompts when neo acts from Discord or Conduit.
   - **Advisory:** drop the D28 code; document it. Pros: simplest; matches neo today. Cons: any Hermes surface can reach work data.
   - **As planned.** Pros: no change. Cons: a false sense of safety.
3. **bb tools route**
   - **neo-style skills + terminal + bound-thread context (recommended).** Pros: exists today; Hermes approvals apply. Cons: less structured.
   - **`bb_tools` as planned.** Pros: structured; children nest. Cons: a second path with other rules; private symbols; installs in 4 profiles.
4. **Sync and Discord**
   - **bb→Hermes only; Discord sessions read-only in bb (recommended).** A "Continue in bb" chat can reuse the handoff code later. Pros: no conflict, echo or rollover code. Cons: Conduit pins don't show in bb; no replying into Discord from bb.
   - **As planned.** Pros: full parity. Cons: the most code, on the newest APIs.
5. **Bots**
   - **bb-native pinned home thread per profile (recommended).** Pros: no co-writing; no writes into hidden sessions. Cons: not shared with Conduit.
   - **Bind to Bot Chat as planned.** Pros: shared with Conduit. Cons: polling mode, D31 and rotation, for 2 messages a month today.

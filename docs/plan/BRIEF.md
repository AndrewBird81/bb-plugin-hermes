# Brief: write the bb-plugin-hermes implementation plan

## Objective

Write a complete, vetted-ready implementation plan in `docs/plan/` for bb-plugin-hermes. bb-plugin-hermes is a bb plugin that makes Hermes Agent a first-class citizen in bb: every Hermes session becomes a real bb thread, with profiles, bots, live mirroring and two-way sync.

Planning only:
- No plugin code.
- No live bb or Hermes changes.
- Never push. Commit with `jj commit -m` in this workspace.

## Read first (main repo: `~/src/bb-plugin-hermes`; this workspace has the same docs)

- `docs/design/00-architecture-draft.md`: the decisions log and evidence summary. **Source of truth for decisions.**
- `docs/spikes/S1-S3-bb-mechanics.md` and `docs/spikes/S0-S4-hermes.md`: verified behaviour.
- `docs/research/01-bb-plugin-sdk.md`, `07-bb-spike-prep.md` (bb), `08-hermes-spike-prep.md` (canonical protocol), `09-architecture-review.md` (pitfalls), `04-user-setup-and-bots.md` (the user's setup).
- Others in `docs/research/` as needed.
- Spike code you may cite:
  - `~/src/bb-plugin-hermes-wt/spike-hermes/src/hermes/` (canonical client, connectors, fixtures);
  - `~/src/bb-plugin-hermes-wt/spike-bb/` (plugin skeleton, fake Hermes).
- **Still running.** The parent will tell you when these land; integrate them then:
  - S7, bb side: `~/src/bb-plugin-hermes-wt/spike-bb/docs/spikes/S7-bb-profile-entry-sync.md` (profile/model picker variants, empty-thread new chat, entry points, project-bound chats, host-worker sync channel, redeploy).
  - H2, Hermes side: `~/src/bb-plugin-hermes-wt/spike-hermes/docs/research/11-hermes-profiles-tools.md` (per-profile models, bot metadata, Bot Chat rotation, Discord echo, bb-tools plugin, cwd, cross-profile handoff, `sessions.changed` coverage).

  Until they land, write the recommended design and mark the dependent items `PENDING S7` or `PENDING H2`.

## Decisions (all user-confirmed; don't relitigate, flag conflicts)

- **Architecture: Local.**
  - The harness (bridge, one process per hosted thread) and a sync watcher (host worker) run on $HERMES_HOST. They reach the Hermes gateway via `~/.hermes/gateway.sock` and canonical `hermes-gateway-v1`.
  - No Hermes config change, network credential or new port. The dashboard is not used by bb.
  - If Hermes moves, that machine becomes a bb machine.
- **Every Hermes session is a real bb thread:**
  - Hermes icon; pin, archive and rename like any thread.
  - No machine or harness picker; the provider is hidden from bb's standard picker.
  - Threads interoperate with bb tooling (`bb thread tell/spawn`, …).
- **Profile picker in the harness:**
  - A Profile chip in every Hermes chat's composer, next to the model picker, plus one in "New Hermes chat". The model list follows the profile.
  - Changing the profile in a chat with messages **hands off to a new chat** in that profile, carrying the context.
- **Optional project** per Hermes chat ($HERMES_HOST projects only); Hermes works in that folder.
  - Imported sessions whose cwd matches a bb project land in that project; the rest are project-less (personal).
- **Bots:**
  - Bot Mode bots Hermes, Alex, David and Neo each get one pinned thread bound to the profile's canonical `Bot Chat`, which Conduit and Desktop also use.
  - Hide `todoist`.
- **Import:**
  - Non-empty interactive sessions (CLI, TUI, Desktop, Conduit) and Discord conversations; first import covers the last 30 days.
  - Subagent sessions are nested: a live delegation item in the parent, openable as a bb sub-thread.
  - One-shots and cron are off (settings toggles).
- **Outside activity** is mirrored live, with progress, unread and normal notifications.
  - Outside user messages render as the user's own bubble with a source tag, e.g. `[Discord] …`.
- **Discord:**
  - Replies from bb post to Discord.
  - The user's bb message is echoed first ("$OWNER_NAME (via bb): …") by the Hermes plugin. Feasibility: H2.
- **Two-way sync** of pin, archive, rename and read.
- **bb tools for Hermes:** a small Hermes plugin with native tools wrapping the `bb` CLI (spawn, tell, list, read, wait threads).
  - Enabled per profile; works in every session of an enabled profile.
  - The editor-MCP route is rejected: it loses `clarify` and only covers sessions bb creates.
- **Hermes approvals and `clarify`** become bb interactions. Never auto-approve.
- **Retire `acp-hermes-agent`** once at parity. Its 18 threads stay viewable and read-only; never re-import their sessions.
- **Settings v1:**
  - connection health;
  - default profile and hidden profiles;
  - import sources and window;
  - hidden models per profile;
  - default notification level for outside activity.
- **Execution style (later):** delegated to agents.
  - One writer per seam, each in its own jj workspace.
  - Every phase ends with a verification gate.
  - Claude-family subagents run in the background.

## Deliverable: `docs/plan/`

Write these files:

- `README.md`: goal; in and out of scope; decisions log (date, source); glossary; file index; **open questions for the user**, each with a recommended answer.
- `01-product.md`: user-facing behaviour, flow by flow. Each feature ends with testable **acceptance criteria**. Cover:
  - entry points;
  - New Hermes chat (profile, optional project, model);
  - the composer chips and profile handoff;
  - bots and Conduit co-use;
  - imported threads (scope, ordering, how history renders);
  - live mirroring and source tags;
  - Discord replies and echo;
  - approvals and clarify, with Hermes' timeouts (edit 60 s, command 300 s, clarify 600 s);
  - two-way state sync, including a proposed **delete** policy (recommend; mark as an open question);
  - notifications;
  - bb tools in Hermes;
  - Settings v1;
  - ACP retirement.
- `02-architecture.md`:
  - components and where each runs;
  - the mapping db schema (keys: profile home plus lineage root; bb-created ids from `request_id = "bb:<threadId>"`);
  - the protocol mapping table: bb bridge methods and deltas ↔ canonical methods and events;
  - sequence flows for:
    - new chat;
    - turn with approval/clarify/interrupt/steer;
    - import;
    - wake + mirror (idle and hosted);
    - user input during mirror;
    - Discord reply + echo;
    - profile handoff;
    - state sync in both directions;
    - Bot Chat rotation;
    - compression continuation;
    - reconnect (gateway restart; `events.since`);
    - bb or daemon restart;
    - $HERMES_HOST asleep;
    - Hermes tool → bb CLI;
    - redeploy of the per-thread bridge;
  - invariants and dedupe rules;
  - security (no network creds, private transcripts, CLI env in Hermes, never auto-approve).
- `03-testing.md`:
  - unit tests;
  - the bridge conformance kit plus our own bridge-opened-turn tests;
  - recorded live fixtures;
  - a fake canonical Hermes server;
  - e2e on an isolated bb (`~/.bb-spike` recipe);
  - Hermes plugin tests;
  - a contract-drift check against the daily Hermes canary;
  - a live dogfood checklist;
  - the gates per phase.
- `04-delivery.md`:
  - repo layout;
  - phases, each **independently usable**, with exit criteria and the verify command or check (suggested order: foundations → new chats from bb → sync, import and mirror → bots → Discord → bb tools in Hermes → settings, polish and ACP retirement; reorder if the evidence says so);
  - a work breakdown into delegatable tasks with dependencies and parallel seams;
  - dev loop, release and install (live bb installs plugins from git tags; the Hermes plugin is symlinked or installed with `hermes plugins install`);
  - rollout, rollback and data cleanup. The 137 empty ACP probe sessions plus one spike leftover are deleted only with user confirmation.
- `05-risks.md`: risk register (likelihood, impact, mitigation, early detection). Include:
  - Hermes canary churn and private-symbol use;
  - experimental bb SDK APIs (`experimental_*`; host is 0.6.104, main is 0.6.120);
  - process count from per-thread bridges;
  - host-worker lifetime;
  - concurrency limits;
  - import timestamps;
  - notification noise;
  - Conduit co-writing Bot Chats (bb sees those turns only after they finish);
  - Discord echo feasibility;
  - duplicate bindings;
  - $HERMES_HOST sleep;
  - privacy.

## Style (the user's rules: "I came here to lead, not to read")

- Bullets and tables, never essays. Normal English fragments are fine. No filler.
- Exact identifiers and paths. Never invent abbreviations.
- Cite evidence inline as `(S1-S3 §S2a)` or `(08 §1)`. Label anything unproven `ASSUMED`, and give each assumption a verify step in a phase.
- Simplicity first: no features beyond the decisions; no speculative config. Flag gold-plating you notice in the decisions.
- Keep the total around 1,000 lines or less across all files.

## Stop and ask (end your turn with the question)

- A decision conflicts with verified evidence.
- A requirement looks infeasible.
- A choice would change the user experience in a way the decisions don't cover.

## Final message

At most 8 bullets:
- what's in each file;
- the top 3 risks;
- the open questions;
- the PENDING items still waiting on S7/H2.

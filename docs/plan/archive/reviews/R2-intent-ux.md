# R2 — Intent and daily-driver UX review

Reviewer angle: user intent and daily-driver UX. Read-only. Evidence labels: VERIFIED = checked against docs, spikes, SDK 0.6.104 types or Hermes source @ c314285f07; SUSPECTED = inferred, not run.

## Verdict
- Ship-ready? No. The architecture is sound. But four parts of the request are dropped or quietly diluted: reasoning effort, attachments, "all my hermes threads", and the Hermes icon. All four have cheap fixes.
- Biggest problem: v1 leaves bb's always-visible **Reasoning** control as a silent no-op. That is a regression against the ACP harness the user drives daily, which breaks "work just like a regular hermes harness thread".
- Confidence: high on the Must-fix items (each checked against source or a screenshot); medium on the UX traps marked SUSPECTED.

## Must fix

- **M1 Reasoning effort is visible but does nothing** — README §Scope "Out", Q6; 01 F13 gate.
  - Plan fails if bb shows a reasoning picker for Hermes threads that the bridge ignores.
  - VERIFIED: SDK `ProviderCapabilities.reasoningLevels` is required and "Non-empty" (`bb-plugin-sdk.d.ts:20462-20464`), so bb always draws the control.
  - VERIFIED: screenshot `s3a-thread-model-picker.png` shows "Reasoning: Medium" and the chip reads "Hermes profile default Medium" on a Hermes thread.
  - VERIFIED: the ACP harness has native `reasoning_effort` none→max (01 §research l.47, 180). Hermes accepts `reasoning` on `session.create` and `session.mutate model{reasoning}` / `reasoning{effort}`, and `model.options` gives per-model `capabilities.reasoning` and `can_disable_reasoning` (11 §1).
  - Fix: move reasoning into P1 (T1.5b):
    - `turn/start` reasoning → `session.create{reasoning}`, then `session.mutate reasoning{effort}` while idle;
    - publish per-model levels from `capabilities`;
    - map bb's `default` to "profile level";
    - add an AC: "a High pick reaches Hermes; `session.info` shows it".
  - Same pattern, SUSPECTED: `permissionModes` is also required and non-empty. Declare a single mode so no dead permission chip shows.
  - Revise Q6: reasoning (and /compact, S4) is in scope for ACP retirement. Fork, service tiers and the full slash catalog stay deferred.

- **M2 Attachments and images are promised but not implemented** — 01 F2 ("text, attachments, voice"); 02 §Protocol mapping; 04 work breakdown.
  - Plan fails if a pasted screenshot never reaches Hermes.
  - VERIFIED: bb prompt input types are `text|image|localImage|localFile` and "the bridge decides what to forward" (01-bb-plugin-sdk l.122). Hermes `prompt.submit` takes `attachments` (08 l.62).
  - VERIFIED: no row in the plan's mapping table, no task, no test and no AC mention images or files (grep of `docs/plan`: none).
  - Fix:
    - add a mapping row: `image`/`localImage`/`localFile` → `prompt.submit.attachments`, shape recorded in a fixture;
    - add task T1.12 and an AC: "a pasted image is described correctly by each profile's default model";
    - state what happens when the model can't take images (MLX): send a `provider.warning`, never drop it silently.
  - Voice: ASSUMED to be client-side dictation into text. Add a one-line check to dogfood P1.
  - Mirrored `[Discord]`/`[Conduit]` images: v1 renders text only. Say so in F6.

- **M3 "All my hermes threads" relies on a source allow-list that misses real sources** — 01 F5 Scope; F12 "Import sources"; 03 §10 eligibility query ("sources in the toggles").
  - Plan fails if real sessions carry `source`/`created_source` values outside {cli, tui, desktop, conduit, discord}. They do:
    - VERIFIED: the root DB has `local` 13, `api_server` 9 and `oneshot`/`cron`; david has `a2a` 2 (04 l.250-252);
    - VERIFIED: canonical creates are stored as `source=local, created_source=cli` (S0-S4 §S4b);
    - VERIFIED: `session.create` sources are `{cli,tui,gui,acp,tool,oneshot}` (08 l.58), so Desktop may be `gui`;
    - VERIFIED: Bot Chats are created with `source:"bot_peer_dm"` (04 l.134);
    - Conduit has no source value of its own ("Conduit-originated chats may record `source=desktop`", 04 l.201, INFERRED there; A5 ASSUMED).
  - The 03 eligibility query uses the same allow-list, so the gate passes while sessions go missing.
  - Fix:
    - switch to a deny-list: exclude acp (either field), cron, oneshot, empty, bb-created, tombstoned, Bot Chats and subagents; import everything else;
    - tag unknown origins `[Hermes]` (already F6's fallback);
    - run the 03 eligibility query as the same deny-list;
    - in T2.1, build the source → tag table from real `source`/`created_source`/`origin_json.platform` values;
    - keep the "Conduit" toggle only if A5 shows it is distinguishable; otherwise fold it into "Desktop/Conduit".

- **M4 Q10 drops the explicit "hermes icon" ask without trying the SDK surfaces that could deliver it** — README Q10; 01 F1 "No row glyph".
  - Plan fails only if no per-row surface exists. One does:
    - VERIFIED: `app.experimental_threadRowMetadata({id, useData, component})` draws a per-row item ("keep it to an icon and a few characters"; `bb-plugin-sdk.d.ts:22783-22834, 24642`). Caveat: it shows only with the `threadRowMetadata` experiment on and Organize → Rows → Metadata enabled;
    - VERIFIED: the provider icon already renders inside Hermes threads. The model chip shows the provider glyph (`</>` fallback in `s3a-thread-model-picker.png`), so T0.6's SVG puts the Hermes logo in every Hermes composer;
    - VERIFIED: the plan says "Hermes shows via the rail icon", but S7 §3 used the generic `Bot` icon.
  - Avoid `experimental_setThreadRowStatus`: it "replaces every indicator except runtime, unread-error, waiting-for-input" (`:22722-22727`), so it would hide unread dots.
  - Fix:
    - add a P1 spike task: a row-metadata item with the Hermes SVG plus the profile name ("Hermes · Alex"); bot avatars come from `profiles.get_asset` (11 §2);
    - make the rail icon the Hermes SVG;
    - rewrite Q10's recommended answer as: keep the provider hidden; Hermes icon on rows via row metadata, plus composer chip and rail. The user must turn on the metadata row option once.

## Should fix

- **S1 Starting a chat is slow and click-first** — 01 F1/F2; S7 §2.
  - Trap: click "New Alex chat", wait 5–8 s on "Starting thread…", then type. A daily driver wants type-then-send.
  - VERIFIED: S3b's home section had a message box that spawned with the first message, which gives no init turn, no title 409 and no muted-init dance (S1-S3 §S3b).
  - VERIFIED (API exists, untested): `ComposerCustomization{scopes:["new-thread"], sendMenu:[…]}` can add "Send to Hermes · <Profile>" rows to bb's own root composer, keeping attachments and voice (`bb-plugin-sdk.d.ts:24890-24959`). `PluginComposerScope.new-thread` carries `projectId`.
  - Fix:
    - make type-first the primary path: send-menu rows on bb's home composer (spike in P1), fallback the S3b message box;
    - keep "empty chat" for the rail and ⇧⌘H;
    - spawn with the real first message, so bb's title generator works (fixes S2's first half).

- **S2 Titles: placeholder and fallback titles can leak into Hermes and block its auto-title** — 01 F2 Title, F9 rename row; 02 flow 8.
  - SUSPECTED. Flow 8 pushes any bb title diff to Hermes `rename`. A spawn title ("New Alex chat") or the 60-character fallback set by the server reaches Hermes as a user title. Hermes then won't auto-title (A14), and its UNIQUE titles produce "New Alex chat (2)" (02 §invariants).
  - Fix:
    - only user-initiated bb renames sync to Hermes;
    - server-set titles are written to `synced` before `threads.update`;
    - AC: "Hermes auto-title replaces the placeholder; no Hermes title equals `New <Profile> chat`".
  - Imports: F5 says "title = Hermes title" but gives no fallback for untitled sessions. VERIFIED: the spawn `titleFallback` holds marker text (S1-S3 §S1a gotcha). Add the 60-character first-message fallback and the marker AC to F5.

- **S3 Notification noise from the user's own conversations elsewhere** — 01 F10; 05 R8; see Question U1.
  - Trap: chatting with Alex on Conduit or a bot on Discord pushes the same phone twice per reply (Conduit/Discord and bb). VERIFIED in the plan's own text (R8).
  - SUSPECTED read-sync race: a mirror turn's `thread.idle` sets bb unread after Conduit has already marked the session read. Flow 9 only reacts to a *change* in `last_read_at`, so the bb dot sticks.
  - Fix: reuse the init trick around user-originated mirror turns:
    - set `input-only` before the wake, restore after idle;
    - `markRead` if Hermes `last_read_at` ≥ the turn's final row;
    - turns with no user line (Pulse, subagent results) and approvals still notify.

- **S4 Work life on $WORK_HOST is undefined** — 01 F1 home row, F11; 04 A18.
  - Trap 1: on a **$WORK_HOST** project's home, what do the "New <Profile> chat" buttons do? F1 only defines $HERMES_HOST projects. Fix: create a personal chat and say "Hermes can't open $WORK_HOST folders", or hide the row there.
  - Trap 2, SUSPECTED: a Codex thread on $WORK_HOST running `bb thread spawn --provider hermes` inherits $WORK_HOST's environment, so the bridge starts where `gateway.sock` doesn't exist. A18 is tested only on an isolated single-machine bb (03 §6 "Limit"), so this can't be caught there.
    - Fix: the bridge reports a clear `provider.error` "Hermes runs on $HERMES_HOST: add `--machine $HERMES_HOST`";
    - add a live two-host check to dogfood P1.
  - Trap 3: `bb_thread_spawn` has no defined `project` argument (none in 10 or 11). That argument is how Hermes reaches work repos on $WORK_HOST. Add `project` (any bb project) to the tool schema; see Question U4.

- **S5 $HERMES_HOST asleep: the in-thread UX is undefined** — 02 flow 14 (A9 ASSUMED); 05 R12 "optional keep-awake" (no task).
  - Trap: from $WORK_HOST or a phone, the user opens a Hermes thread and sends; the behaviour is unknown.
  - Fix:
    - define the target now: a thread-scoped composer banner "$HERMES_HOST is asleep: sends wait until it wakes" (`ComposerCustomization{scopes:["thread"], banners}`), and either queue or refuse;
    - make A9 decide which;
    - decide keep-awake explicitly (Question U2).

- **S6 Hermes sessions older than 30 days can't be reached** — 01 F5, F12.
  - The original ask was "see a list of all the hermes chat threads … and be able to open them". VERIFIED: the plan imports only the window. F5 defines backfill for source toggles but not for raising the window.
  - Fix:
    - raising the window backfills (one line);
    - optional, cheap: an "Older Hermes chats" list in the rail panel (`listSessions` without `since`) with "Open in bb", which imports on demand through the same serial queue.

- **S7 `/compact` and slash commands** — README Q6; 02 `initialize` caps.
  - VERIFIED: bb gates its compact affordance on `supportsManualCompaction` (`bb-plugin-sdk.d.ts:20450-20452`); Hermes has `session.mutate compress` (11 §3).
  - VERIFIED: canonical slash commands go through separate methods (`slash_exec`, `command_dispatch`, `command_catalog` in `gateway/session_controls.py:435-449`).
  - SUSPECTED: `prompt.submit` does not interpret slash commands, so `/compact` typed in v1 reaches the model as literal text.
  - Fix: declare `supportsManualCompaction` and map it to `compress` in P1. Note in F2 that other `/…` text goes to the model literally until a later `command.catalog` → bb `commands/list` task.

- **S8 Trimming the stack is not planned** — README §Scope, 04 §Rollout/§Data cleanup.
  - VERIFIED: the user wants to drop hermes-webui. It runs as launchd `ai.hermes.webui` on `:8787`, tailnet `:8446`; its store was untouched since 2026-09-06, and it is "mostly polling" (04 l.204, 05 l.9).
  - The plan never mentions webui.
  - Fix: add an optional, user-approved P6 step to retire `ai.hermes.webui`, its tailnet serve and `HERMES_WEBUI_*` secrets via nix-config. Name the hermes-host bb-adapter (Q8) in the same "stack after v1" list.

- **S9 A cold model catalog can stall the first send** — 01 F3 "validates every turn's model"; 04 A16.
  - SUSPECTED: a cold `model.options` takes 15.5 s (11 §1). After a gateway restart, the first turn waits on validation.
  - Fix:
    - the worker prewarms all visible profiles on connect and after `watch connected`;
    - validate against the last-known list and never block a turn on a refresh.

- **S10 Imported history loses its dates** — README Q7.
  - VERIFIED: every item is stamped at import time (S1-S3 §S1b), so a reader can't tell when something was said.
  - Fix (keep Q7's answer): put the original date in the replay tag, e.g. `[CLI · Oct 12] …`. S1-S3 suggests exactly this.

- **S11 Agent-driven sends are echoed as the user** — 01 F7; 02 mapping (`turn_author.name = <bb user name>`).
  - SUSPECTED: a Codex agent running `bb thread tell <discord-bound thread>` posts "$OWNER_NAME (via bb): …" to Discord.
  - Fix: if bb marks agent-originated input, set `turn_author.name` to "<thread title> (bb agent)". Otherwise document it as a limitation.

## Questions for the user

- **U1 Push for your own conversations elsewhere?** This conflicts with D7's "normal notifications". You'd get two pushes per Conduit/Discord reply.
  - Recommended: no push for outside turns you started (CLI/Desktop/Conduit/Discord). Push for approvals, clarify and turns you didn't start (Pulse, subagents). Unread dot still set unless read in Hermes.
- **U2 Is $HERMES_HOST always awake (plugged in, sleep off)?** Decides keep-awake and how much offline UX to build.
  - Recommended: enable bb's bundled `keep-awake` for $HERMES_HOST. Keep the offline banner (S5) for real outages.
- **U3 Do you start Hermes chats from bb on your phone?** Plugin rail and home slots are unverified on bb mobile; with Hermes hidden from the picker, the phone may have no way in.
  - Recommended: yes. Add a P1 dogfood check on the phone. Fallback: a pinned "Hermes" launcher thread, or ⇧⌘H-equivalent via bb's command palette.
- **U4 May Hermes (personal profiles) spawn and read threads in $WORK_HOST work projects?** This is a work/personal data boundary.
  - Recommended: yes from bb-bound sessions, with an explicit `project` argument. Never from Discord-origin sessions (extends Q5).
- **U5 (revised Q6) Is reasoning effort plus `/compact` required before ACP retirement?**
  - Recommended: yes (M1, S7). Fork, service tiers and the full slash catalog come later.
- **U6 (revised Q10) Is it OK to turn on bb's row-metadata option once, to get a Hermes icon and profile on every Hermes row?**
  - Recommended: yes (M4). Otherwise the plan's answer (no row glyph) stands.

## Checked and fine
- No machine or harness picker in any plan flow (S7 §5 DOM scan; S1-S3 §S3a). bb's "Handoff to new thread" to Codex/Claude/Pi stays visible: an honest documented limitation (R21).
- Profile picker: chip in every composer, in New chat and on bots; handoff matches D3 and was verified end to end (S7 §1d). The late-pick refusal covers the race.
- Bots: 4 pinned threads bound to `Bot Chat`; todoist hidden. Pinned versus a "Bots" section is correctly called a forced choice (S7 §4). Conduit turns show only once finished; disclosed (F4, R9).
- Progress indicators: mirror turns spin and move the row to the top, then set unread (S1-S3 §S2a, screenshots). bb turns are native.
- Pin, archive, rename and read both ways (F9) with echo suppression; Q2's bot exemption keeps Bot Mode intact (11 §3).
- bb tooling interop: `bb thread tell|read|wait` on Hermes threads plus Hermes-side `bb_tools` (F1, F11) covers "threads interact with each other".
- Settings v1 matches D13 exactly; no extra settings (gold-plating check passed).
- Search: imported and mirrored turns are real bb turns with visible text, so bb search covers them (S7 §2 "prompt history and search contain only visible text").
- Plan Q1 (no cross-delete), Q3 (rollover notice), Q4 (thread per session, ~8/month), Q5 (approval for Discord-origin spawn/tell), Q8 and Q9 (catalog clash mitigation): recommendations fit the user's intent.
- Q7: accept, plus S10's dated tag.
- Gold-plating: subagent sub-threads and the Discord echo are already flagged as droppable. Nothing else found beyond D1–D15.
- Local transport instead of the dashboard matches the user's later "Local sounds better" (D1). Hermes off $HERMES_HOST is out of scope, per the user.

## Verification notes
- Verified by reading: plan files; S1-S3, S7 and S0-S4 sections cited; research 01, 04, 05, 08, 09, 11; SDK 0.6.104 `bb-plugin-sdk.d.ts`; Hermes `gateway/session_controls.py`; screenshot `s3a-thread-model-picker.png`.
- Not run: any spike. Row-metadata rendering, the composer send menu on the home composer, cross-host spawn and phone slots are untested.

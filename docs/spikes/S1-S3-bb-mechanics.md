# S1–S3: bb mechanics spike (import, mirror, UX)

Date 2026-11-04. Isolated bb `bb-app@0.48.1` (SDK 0.6.104) on $HERMES_HOST, `--data-dir ~/.bb-spike`, ports 48886/48887. Fake Hermes inside the bridge. Nothing ran against the live bb server or live Hermes (one caveat in [Safety](#safety)).

Labels: **VERIFIED** = observed on the isolated bb (screenshot, `bb thread log`, bridge log or server event log). **PARTIAL** = some of it observed, the rest inferred. **SKIPPED**.

Evidence:
- Screenshots: `docs/spikes/img/`.
- Bridge wire log: `docs/spikes/logs/bridge-log.ndjson`. `options` are trimmed; `ms` is epoch ms.
- Server lifecycle events (`thread.active/idle`, `message.*`): `docs/spikes/logs/server-events.json`.
- Code: `server.ts`, `host.ts`, `app.tsx`, `src/bridge.ts`, `src/fake-hermes.ts`, `src/protocol.ts`.

## Summary

| # | Result | One line |
|---|---|---|
| S1a | VERIFIED, with a catch | The marker stays invisible. History renders as one collapsed "Worked for 0ms" turn: user lines become "System Message" cards. **Re-announcing `thread/identity` mid-turn leaves the thread stuck `active`.** |
| S1b | VERIFIED | Looks like a normal chat: real user bubbles. It costs prompt-history entries and one active→idle cycle per turn. **Recommended.** |
| S1c | VERIFIED | `thread/resume` carries the bound `providerThreadId` after `bb thread stop` and after a bb restart. A duplicate handle is accepted at start and leaves an orphan that later fails with 409. |
| S2a | PARTIAL | Wake → bridge `turn/start` in 24 ms. Live spinner on home and sidebar, no stray bubble, unread afterwards. Push delivery not observable (no devices). |
| S2b | VERIFIED | A bridge-opened `turn.open` on a hosted idle thread works without any send: `thread.active` 126 ms after the trigger. |
| S2c | VERIFIED | A user send during a mirror turn arrives as `turn/steer` (UI default and CLI `--mode steer`). `--mode queue` waits and then arrives as `turn/start`. |
| S2d | SKIPPED | S2a was not noisy enough to need it. |
| S3a | VERIFIED | `experimental_visibility:"installed"` + health `not_installed` hides Hermes from the New Thread picker **and** from Settings → Providers. The thread page keeps follow-ups and the model picker. The profile appears once the bridge publishes `bb/session-options`. |
| S3b | VERIFIED | A homepage section with a profile select spawns into the personal project / personal workspace on a fixed host. No machine picker anywhere. The profile shows locked (single value). |
| S3c | VERIFIED | `markRead` and `threadNotifications.set` work. Archive/unarchive reach the bridge even when unhosted. **Rename reaches it only while hosted**, and with a `"[bb] "` prefix. |

## New facts that change the plan

1. **Identity must not change mid-turn.** Emitting `thread/identity` with a new handle inside the first turn persists it, but the thread stays `active` forever. Only `bb thread stop` recovers it; a bb restart turns it into `error`. Two patterns work:
   - (a) know the binding at `thread/start`: a server-side cache read by `deriveProviderOptions(threadId)`, filled before a `sendAt` fires;
   - (b) announce the new identity **right after the first `turn.boundary`**.
   - (b) is simpler, needs no `sendAt`, and was verified end to end: d and h resume with the bound id. Evidence: `s1a-identity-midturn-stuck-active.png`; `bb thread log` of `$BB_THREAD_20` (stuck) vs `$BB_THREAD_04`/`$BB_THREAD_24` (fine).
2. **One bridge process per hosted thread**, plus short-lived maintenance processes for health, archive and unarchive. `/hosted` on each control port showed distinct pids, each hosting one thread. 07 assumed one process per artifact. Consequences:
   - each hosted thread holds its own Hermes connection (ticket per connect);
   - a bridge-side feed subscription (S2b) is naturally per session;
   - **`bb plugin reload` does not replace running thread processes.** They keep the old artifact until stop or idle release (pids 72040/72043 were still alive after 6 later reloads). Deploys need a "stop hosted Hermes threads" step.
3. **`sendAt` is coarse, and sends overtake a pending spawn.**
   - The due sweep fired 6.7–11 s after a 1.5 s `sendAt`.
   - `threads.send` issued while the spawn was still `pending` dispatched **before** the spawn's own message (`$BB_THREAD_02`: turns ran 2, 3, 1).
   - Without `sendAt`, `queue-if-active` keeps order: 3 turns in ~190 ms (`$BB_THREAD_24`).
4. **Duplicate handles are not refused at start.** Importing the same session twice gave two live threads with one `providerThreadId`. After release, the newer one's follow-up fails with `HTTP 409: This thread's only provider session belongs to another thread, so bb will not resume it.` It becomes an orphan. Dedupe must happen in our mapping db before spawn.

None of these changes the architecture in `00-architecture-draft.md`. (1), (3) and (4) change recipes; (2) changes the bridge's connection model and the deploy procedure.

## S1 import

Setup:
- Canned session `hermes:$HERMES_SESSION_FAKE`: 3 user turns, 2 tool calls, 1 reasoning block, plus clones `-b`…`-l`, one per run.
- Server RPC `import` (`bb plugin rpc call hermes import`) spawns into `proj_personal` with `environment {type:"host", hostId, workspace:{type:"personal"}}`, `providerId:"hermes"`, `title`, `sessionOptions.profile`, `pluginMetadata` and an agent-only marker `<hermes-bb>{json}</hermes-bb>`.

### S1a — one turn, `input.provider` replay

- **Marker invisible: VERIFIED.** No user bubble, no marker text in the timeline (`s1a-import-provider-idle.png`). The bridge receives it intact with `visibility:"agent-only"` in `turn/start.input` (bridge log).
- **Rendering: VERIFIED.**
  - With bb's default "Collapse finished turns", the whole import is one row "Worked for 0ms" followed by the last assistant message only.
  - Expanded (`s1a-import-provider-expanded.png`), each user line is a "ⓘ System Message" card: the text is truncated with "…" and expands on click. Tools show as "Ran 1 tool" or "Ran tool hermes:calendar_update {…}". The reasoning block is folded into the tool group.
  - This does not read as a chat.
- **Identity:**
  - Placeholder at `thread/start` plus re-announce mid-turn → stuck `active` (`s1a-identity-midturn-stuck-active.png`).
  - Identity at start, via a `deriveProviderOptions` cache + `sendAt`: idle.
  - Re-announce after the boundary: idle. See fact 1.
- **Title kept: VERIFIED.**
- Gotcha: the spawn DTO's `titleFallback` contains the marker text (`"<hermes-bb>{\"op\":\"bind\"…"`). It isn't rendered while `title` is set.
- Duration: 1 turn, ~0 ms bridge time. Events: one `thread.active` → `thread.idle` pair.

### S1b — history as real turns

- **Rendering: VERIFIED** (`s1b-import-turns.png`). Right-aligned user bubbles, assistant text below each. It reads as a normal bb chat.
- The marker stays invisible: every turn carries visible text plus an agent-only replay marker. Each turn shows "Worked for 0ms" with its tools collapsed.
- **Prompt history: VERIFIED polluted.** `bb thread history` lists turns 2..n ("Move the dentist…", "Thanks!"). The spawn input (turn 1) is not recorded.
- **Notifications and unread: VERIFIED.**
  - Each turn is a `thread.active`/`thread.idle` cycle (3 for 3 turns, `server-events.json`). push-notifications sends turn-finished on `thread.idle` for visible threads (07 §2), so a visible import could push n times.
  - Mitigation, verified: spawn with `visibility:"hidden"`, replay, then `update({visibility:"visible"})` + `markRead`. The result is read (`lastReadAt > latestAttentionAt`) and visible. That hidden threads get no push is from the source, not observed.
- **Timestamps:** every item is stamped "now". `createdAt`/`updatedAt` = import time. Sidebar order = import order. Same for S1a.
- **Duration:**
  - With `sendAt`: ~11.7 s (sweep-bound).
  - Without `sendAt`, `queue-if-active` fired back-to-back: ~190–280 ms for 3 turns.

**Recommendation: S1b.** Recipe (verified on `$BB_THREAD_23`):
1. Dedupe against the mapping db.
2. `spawn({visibility:"hidden", title, sessionOptions:{profile}, pluginMetadata, input:[userText0, agentOnly(bind)]})`, without `sendAt`.
3. Immediately send `threads.send({mode:"queue-if-active", input:[userText_i, agentOnly(replay i)]})` for i = 1..n−1.
4. The bridge answers each turn from history and never calls Hermes. It announces `thread/identity = <profile>:<root>` **after the first `turn.boundary`**.
5. Wait for an empty queue and idle, then `update({visibility:"visible"})` + `markRead`.

Accepted costs:
- n−1 prompt-history rows;
- "now" timestamps (put the original time in the text if it matters);
- "Worked for 0ms" labels.

For very long sessions, consider replaying only the last N turns.

### S1c — rebinding and collision

- `bb thread stop` + follow-up → `thread/resume{providerThreadId:"hermes:…-f"}` (identity set at start) and `"…-d"` (identity after the boundary). **VERIFIED.**
- Isolated bb restart (SIGINT to the launcher, relaunch) + follow-up → `thread/resume` with `"…-e"` and `"…-d"`. **VERIFIED.**
- The stuck-active thread became `error` ("Thread interrupted because the host daemon disconnected").
- Collision: see fact 4. Verified on `$BB_THREAD_16` vs `$BB_THREAD_11`. The older thread keeps working; the newer is an orphan.

## S2 mirror

### S2a — wake via `threads.send(queue-if-active, [agent-only marker])`

- Latency (bridge log vs server `sentAt`):
  - wake `send` → bridge `turn/start`: **24 ms**;
  - first delta (`input.provider` of the external user line): **+26 ms**;
  - the fake script's first text: +1.5 s;
  - `thread.active` fired 23 ms after the send.
  - End-to-end "external start → visible" in production = feed latency + ~50 ms.
- Home page: the sidebar row shows a spinner and moves to the top during the mirror (`s2a-home-during-mirror.png`), then an unread dot (`s2a-home-after-mirror.png`). **VERIFIED.**
- **No stray bubble: VERIFIED.** The wake marker is not rendered (`s2a-thread-during-mirror.png`).
- In the thread the external user line is a "System Message" card. Text streams and the tool shows "Running tool hermes:weather".
- After completion the turn collapses to "Worked for 10s" + the final text, so **the external user's line is hidden inside the collapsed group.**
- Read state: the send itself bumps `lastReadAt` to send time; `thread.idle` bumps `latestAttentionAt`, so the thread ends unread. `markRead` clears it.
- Notifications: `thread.idle` fires per mirror turn with `lastAssistantText`. Push delivery wasn't observable (no devices registered; `bb push-notifications status`: "Last send: Never"). `threadNotifications.set` (S3c) is the control.

### S2b — bridge-opened turn, no send

- **VERIFIED.** The control port tells the bridge to `turn.open` on hosted idle `$BB_THREAD_02`:
  - `thread.active` +126 ms, `thread.idle` +10.1 s;
  - unread afterwards; same rendering as S2a.
- Only works while hosted: other bridge processes answer 409 "not hosted".

### S2c — user sends during an open mirror turn

- UI composer Enter while active → `turn/steer{expectedTurnId}` (bridge log). CLI `--mode steer` → same.
- The bridge emits `input.accepted` into the open turn: the bubble is labelled "Steer". It answers after the external turn ends, before the boundary (`s2c-steer-and-queue-during-mirror.png`).
- CLI `--mode queue` → held ("message queued … dispatches when that clears"), then `turn/start` 66 ms after the mirror boundary.
- **Mapping:** `turn/steer` during a mirror turn → Hermes `prompt.submit` (queued), never `session.steer`. `turn/start` after it → a normal turn.

### S2d — SKIPPED

The wake noise is one active/idle cycle and one unread per external turn. Both are controllable (`markRead`, notification level), so the `backgroundTask` keep-alive wasn't needed.

## S3 UX

### S3a — picker visibility

- `experimental_visibility:"installed"` + `maintenance.health:true`, bridge `provider/health` → `not_installed`:
  - New Thread picker tabs are Codex/Claude/Pi only (`s3a-new-thread-picker-not-installed.png`);
  - `bb provider list` omits hermes;
  - **Settings → Providers omits Hermes entirely** (`s3a-settings-providers-not-installed.png`).
- With health `ready` it appears in both places (`s3a-new-thread-picker-ready.png`, `s3a-settings-providers-ready.png`).
- Health is cached. Flipping it took effect only after `bb plugin reload`, not within 60 s.
- Thread page with `not_installed`:
  - follow-ups work;
  - the model picker shows the Hermes tab "(current thread)" with "Hermes profile default", reasoning, and "Handoff to new thread" to other providers (`s3a-thread-model-picker.png`).
- **The profile option is not shown from `model/list` `sessionOptions` alone.** `bb thread options` said "The agent has not reported any session options".
  - It appears once the bridge emits `extension.state {extensionKind:"bb/session-options", payload:{options:[…]}}` on start/resume.
  - It renders as an "alex ▾" chip in the composer footer (`s3b-thread-profile-locked.png`).
- Gotchas:
  - `icon:"Sparkles"` isn't a valid bb icon, so it falls back to a `</>` glyph; ship an SVG.
  - With the provider visible, sidebar rows gain provider glyphs; hidden, they have none.

### S3b — our own entry point

- `homepageSection` "Hermes" (profile select, message box, "New Hermes chat") calls RPC `newChat`. That spawns into `proj_personal` with `environment {type:"host", hostId:<$HERMES_HOST>, workspace:{type:"personal"}}`, `providerId:"hermes"`, `model:"hermes-default"` and `sessionOptions:{profile}`, then navigates with `useBbNavigate().toThread` (`s3b-homepage-new-hermes-chat.png`, `s3b-new-chat-thread.png`).
- The bridge got `sessionOptions.profile:"alex"` in `thread/start.options` and replied as alex.
- **No machine picker** anywhere in the flow. The thread page shows a static "Personal workspace" label, a "New thread in this environment" button and "Open workspace in VS Code".
- The profile is **read-only after the first turn** because the bridge publishes a single-value select.
- The `navPanel` "Hermes" rail entry renders the same form (`s3b-navpanel.png`). The same screenshot shows the import read-state difference: g and h (visible imports) have unread dots, i (hidden import + `markRead`) has none.
- The bb title generator retitled the chat ("Start a new Hermes chat with Alex"). Pass `title` to suppress that.

### S3c — read, notifications, archive, rename

- `bb.sdk.threads.markRead` → `lastReadAt` > `latestAttentionAt`. **VERIFIED.**
- `sdk.plugins.callRpc({pluginId:"push-notifications", method:"threadNotifications.set", input:{threadId, level:"muted"}})` → `{own:"muted"}`; `threadNotifications.list` and `bb push-notifications thread` agree. **VERIFIED.**
- Archive and unarchive of an **unhosted** thread → bridge `thread/archive` / `thread/unarchive` with `hosted:false`, served by a fresh short-lived bridge process. **VERIFIED.**
- Rename of an **unhosted** thread → nothing reaches the bridge. Rename of a hosted thread → `thread/name/set{title:"[bb] Renamed while hosted"}`.
  - bb adds a `"[bb] "` prefix; strip it before `session.mutate rename`.
  - Unhosted renames need `sdk.subscribe("thread:changed")` diffing on the server.

## Recommended approach

- **Import:** the S1b recipe above, with:
  - hidden during replay;
  - identity after the first boundary;
  - no `sendAt`;
  - dedupe before spawn.
  Keep `deriveProviderOptions` empty: unnecessary.
- **Mirror:**
  - If the thread is hosted, the per-thread bridge process, already subscribed to its session, opens its own turn (S2b). Lowest latency, no send.
  - Otherwise the server wakes with `queue-if-active` + an agent-only sync marker (S2a), and the bridge resumes and replays from its cursor.
  - In both cases the external user line is an `input.provider` card.
  - Map user steers during a mirror turn to `prompt.submit`.
  - Set the per-thread notification level at bind time.
  - Accept the unread state, or `markRead` according to user policy.
- **UX:**
  - `installed` + `not_installed` health;
  - our homepage section / nav panel spawns with a fixed host + personal workspace;
  - profile via `sessionOptions` at spawn, plus a single-value `bb/session-options` from the bridge.
- **Ops:** after a plugin update, stop hosted Hermes threads (fact 2).
- **Open UX choice for the user:** external user lines render as collapsible "System Message" cards that hide when the turn collapses. Alternatives (07 §2): an extension item with presentation, or a prefixed agent line. Not spiked.

## SDK APIs actually used

- Server:
  - `bb.providers.register` (`experimental_visibility`, `maintenance.health`, `capabilities.supportsThreadArchive/Rename`, `models.scope:"host"`, `deriveProviderOptions`);
  - `bb.rpc.register` + `defineRpcContract`;
  - `bb.events.on` (`thread.active`, `thread.idle`, `thread.archived`, `message.queued`, `message.dispatched`);
  - `bb.sdk.projects.list({includePersonal:true})`, `bb.sdk.hosts.list`;
  - `bb.sdk.threads.spawn` (`visibility`, `sendAt`, `sessionOptions`, `pluginMetadata`, `title`, `environment`), `.send` (`queue-if-active`), `.wait`, `.update` (`visibility`), `.markRead`, `.get`;
  - `bb.sdk.plugins.callRpc` (push-notifications `threadNotifications.set/list`).
- Host: `experimental_defineHostEntry`, plus an `experimental_providerBridge` export.
- Bridge (`@get-bb/plugin-sdk/provider-bridge`):
  - `experimental_defineProviderBridge`, `createBridgeIo`, `runBridgeRequest`, `BRIDGE_REQUEST_METHODS`, `BRIDGE_NOTIFICATION_METHODS.threadIdentity`, `THREAD_DELTA_NOTIFICATION_METHOD`;
  - deltas: `session.reset`, `input.accepted`, `input.provider`, `turn.open`, `turn.boundary`, `item.open/close`, `item.textDelta/textClose` (`agentMessage`, `reasoningText`), `extension.state` (`bb/session-options`);
  - methods handled: `initialize`, `model/list`, `provider/health`, `thread/start|resume|stop|archive|unarchive|name/set|discard`, `turn/start|steer`.
- App: `definePluginApp`, `app.slots.homepageSection`, `app.slots.navPanel`, `useRpc`, `useBbNavigate().toThread`.
- CLI used for evidence: `bb plugin rpc call`, `bb thread log|history|options|stop|tell|archive|unarchive|update`, `bb push-notifications thread|status`, `bb provider list`.

## Gotchas (misc)

- `bb plugin build` with the live install's `bb` binary failed (`Cannot find module 'npm/package.json'`); the `bb` shipped inside `npx bb-app@0.48.1` works. The spike wrapper `~/.bb-spike-logs/sbb` unsets every `BB_*` variable and pins `BB_SERVER_URL=http://127.0.0.1:48886`.
- `bb plugin types --check` asks to move `@get-bb/plugin-sdk` to devDependencies. The provider docs say `dependencies` (bridge import). It is kept in `dependencies`; follow up before shipping.
- `capabilities.reasoningLevels` must be non-empty, or the plugin fails to load.
- `provider.env-resolved` timeline events record env values (PATH etc.), per 01 G11.
- `bb thread tell` defaults to `--mode steer`; on an idle thread it starts a turn (CLI prints "steered"/"updated").
- agent-browser screenshots in this setup sometimes return the previous frame. Every screenshot cited was checked against the DOM snapshot or retaken.

## Safety

- Every `bb` command used `~/.bb-spike-logs/sbb` (explicit `BB_SERVER_URL=http://127.0.0.1:48886`, `BB_*` unset). Nothing was installed, sent or archived on the live server.
- Caveat: on first start the isolated bb's bundled `provider-acp` ran one model-catalog probe of `acp-hermes-agent` (`hermes acp`, 9 models, per the server log) before I disabled `provider-acp`, `keep-awake` and `connect` about 20 s later. That probe may have created one empty `acp` session in live Hermes (the 09 M6 pattern). For future isolated runs, disable `provider-acp` before the first start, or start with `PATH` excluding `hermes`.
- The isolated bb is still running (`~/.bb-spike-logs/start.sh`, data in `~/.bb-spike`). Tear down: `kill -INT <bb-app pid>`, then `rm -rf ~/.bb-spike ~/.bb-spike-logs` after review.

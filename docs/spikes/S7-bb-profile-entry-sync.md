# S7: profile picker, entry points and sync channel (bb side)

Date 2026-11-04. Same isolated bb as S1-S3 (`bb-app@0.48.1`, SDK 0.6.104, ports 48886/48887, `~/.bb-spike`), fake Hermes in the bridge, a fake gateway socket (`scripts/fake-gateway.mjs`). Nothing touched the live bb server or live Hermes.

Labels: **VERIFIED** = observed (screenshot, bridge log, `bb thread log`, server event log). **INFERRED** = from docs or source, not run. **FAILED** = tried and it does not work.

Evidence:
- Screenshots: `docs/spikes/img/s7-*.png`.
- Logs: `docs/spikes/logs/s7-bridge-log.ndjson` (persistent) and `s7-fake-gateway.log` (connect/close times).
  - `s7-server-events.json` and `s7-sync.json` are in-memory server buffers, exported after the bb restart, so they hold only the post-restart sample.
  - Earlier numbers in this report were read live from the same RPCs (`events`, `syncStatus`).
- Code: `server.ts`, `host.ts`, `app.tsx`, `src/bridge.ts`, `src/host-contract.ts`, `src/s7-config.ts`, `scripts/fake-gateway.mjs`.
- Spike knobs live in `~/.bb-spike-logs/s7.json` (`catalog`, `lock`, `catalogState`, `syncKeepAliveMs`).

## Summary

| # | Result | One line |
|---|---|---|
| 1a | VERIFIED | The `profile` chip (category `mode`) shows every profile in an empty chat and a single value after the first message. bb itself refuses a value the bridge did not publish (HTTP 400). |
| 1b | VERIFIED, not recommended | `profile/model` ids with `routeProviderId: profile` render as "GPT-5.5 hermes", "GPT-5.5 mini alex"…: one flat list, profile as a grey qualifier, searchable. No section grouping. The closed chip shows only "GPT-5.5", which is ambiguous. |
| 1c | VERIFIED | The model list follows the profile per thread: `models.scope:"workspace"` (the personal-workspace cwd ends in the threadId) plus a bridge-published `bb/provider-model-catalog`. A chip change before the first message updates the list in about 1 s via a server-sent agent-only init turn. |
| 1d | VERIFIED | Handoff end to end: picking another profile in a chat with messages opens a new chat for that profile with that profile's models. The old chat keeps its profile. bb's own "Handoff to new thread" also appears, but it drops the profile. |
| 2 | VERIFIED | An empty Hermes chat works: an agent-only init turn, then bb's full composer (attach, voice, model and profile chips). Visible artifacts: "NEW / Provisioned thread", an unread dot (cleared by `markRead`), and a marker-text title unless we pass `title`. |
| 3 | VERIFIED | navPanel (bots, new chat per profile, recent), homepageSection, sidebar-footer disclosure, and a command-palette command with ⇧⌘H all work. |
| 4 | VERIFIED | Projectless chats sit in the sidebar's "Threads" list. **A pinned thread shows under "Pinned", not in its section.** A "Bots" section works for unpinned threads. Hermes rows show no provider glyph while health is `not_installed`. |
| 5 | VERIFIED | A project chat from our flow via the `project-checkout` environment: cwd = project root reaches `thread/start`, and the footer shows "Demo project · Project checkout · main". No machine picker. |
| 6 | VERIFIED | Host worker ↔ server: one long-lived socket, signal latency 0–4 ms, alive for 7+ min with 60 s keep-alive calls, recovers after `bb plugin reload` (~90 ms) and after a bb restart (~1.9 s). Without keep-alive calls the worker dies at exactly 5 min despite the open socket. |
| 7 | VERIFIED | Redeploy = rebuild, `bb plugin reload`, then `threads.stop` on every idle Hermes thread (28 threads in 0.16 s). The next turn resumes on the new artifact with the same `providerThreadId` and profile. |
| 8 | VERIFIED | (Added by the parent.) An external message sent as visible `[Discord] …` text plus an agent-only sync marker renders as the user's own bubble, before the mirrored reply, in order. It is recorded in prompt history (↑ recalls it). |

## Findings that change the plan

1. **A thread's model catalog is keyed by cwd, and personal-workspace cwds are per thread** (`…/environment-personal-workspace/host-data/workspaces/<threadId>`).
   - So `models.scope:"workspace"` plus `bb/provider-model-catalog` gives a per-thread model list that follows the profile. Verified on two threads side by side: `s7-1c-workspace-catalog-alex.png` vs `-hermes-thread.png`.
   - **Exception: project chats share the project path as their scope.** Two Hermes chats with different profiles in the same project would overwrite each other's list. INFERRED from the scope key (`provider-model-catalog-store.ts` keys on `cwd`); not reproduced.
2. **The profile pick is persisted at once, before any send.** A `thread/extensionState/updated` `bb/session-option-selections` event lands within a second of the click.
   - The server sees it via `experimental_thread.events` (debounced to ≤1/s) plus `threads.events.list`.
   - That gives the trigger for both "apply now on an empty chat" and "hand off on a chat with messages". No bridge hook is needed.
3. **`bb.sdk.threads.open` navigates every connected client** (`{delivered: 7}`). For handoff that means the user's phone and other windows jump too. Use it, but expect the jump; or open the chat from the UI when we have it (our own surfaces use `useBbNavigate`).
4. **An empty chat cannot be retitled by bb.** `experimental_regenerateTitle` fails with `HTTP 409: This thread has no task message to generate a title from`, because the first message is the agent-only init. Untitled, the sidebar shows the marker JSON (`s7-2-empty-chat-untitled.png`) and the title generator names the chat after it ("Initialize the Alex profile"). So spawn with a title ("New Alex chat"), then set it from Hermes' own session title once Hermes has one.
5. **The bb-side profile lock is real.** `bb thread options --set profile=hermes` on a locked chat fails with `Session option "profile" has no value "hermes". Available values: neo.` With the handoff decision we publish the full list instead (open mode), so the chip stays usable as the "switch profile" control.
6. **The thread's stored model can be invalid for its profile.**
   - A turn sent from the CLI on a Neo chat arrived with `model=gpt-5.5` (an earlier catalog's default), while the chip showed "Claude Haiku 4.7" (`s7-1d-e2e-1-pick-david.png` reply text).
   - The bridge must map an unknown model to the profile's default.
7. **Identity follows the profile.** `providerThreadId` is minted at `thread/start` (`david:bbnew_…`), but the profile can change before the first message (it became neo). Create the Hermes session, and announce identity, at the first real message, after the turn ends (same rule as S1).

## 1. Profile and model picker

### 1a. Profile chip: editable, then locked — VERIFIED

- Before the first message, the bridge publishes `extension.state bb/session-options {options:[{id:"profile", category:"mode", type:"select", value, values:[all 4]}]}` in the init turn.
  - The chip at the bottom right of the composer lists Hermes/Alex/David/Neo (`s7-1a-profile-chip-editable.png`).
- Picking Neo and sending the first message: the bridge gets `turn/start.options.sessionOptions = {profile:"neo"}` with the text. It applies it and republishes a single value.
  - After that, the chip menu shows only "Neo" (`s7-1a-profile-chip-locked.png`). `bb thread options` shows `* neo`.
- `sessionOptions` reaches the bridge only when the choice differs from what was last published (protocol). The bridge keeps the current profile itself (here `s7-threads.json` in the bridge `dataDir`; in production, Hermes' session row).

### 1b. Model ids namespaced by profile — VERIFIED

- The model picker has **no grouping field**. `routeProviderId` renders as a grey qualifier after the label (`ModelReasoningMenu.tsx` `qualifier={option.routeProviderId}`), in catalog order.
  - Search matches the qualifier: "alex" filters to Alex's models (`s7-1b-flat-models-qualifier.png`, `s7-1b-flat-models-search-alex.png`).
- The only other split is "More models" = `selectedOnlyModels`.
- Session-option values have a `group` field (`SessionOptionsMenu.tsx`), but that is for the chip, not the model list.
- Drawbacks:
  - 10 rows for 4 profiles;
  - the closed chip shows "GPT-5.5" with no profile;
  - the default model belongs to one profile, so an Alex chat opened on "GPT-5.5 hermes".
  - Not recommended as the profile picker.
- Not tried: a name prefix ("Alex · GPT-5.5", mode `flat-prefix` is implemented). It would fix the closed-chip ambiguity but double the label.

### 1c. Model list follows the profile — VERIFIED (option 1)

| Option | Result |
|---|---|
| `models.scope:"workspace"` + `bb/provider-model-catalog` from the bridge at start, resume and profile change | **Works.** Alex chat → GPT-5.5 mini / Claude Sonnet 4.7 (default preselected); Hermes chat → GPT-5.5 / Claude Opus 4.7 / MLX local, at the same time. |
| Same, after a chip change on an empty chat | The list goes stale (`s7-1c-chip-neo-models-stale.png`) until something republishes. Fix, verified: the server sees the selection event and sends an agent-only `{op:"init", profile}` turn. The bridge republishes, the list becomes Neo's with Claude Haiku 4.7 preselected (`s7-1c-chip-neo-models-follow.png`), about 250 ms after the event, then `markRead`. |
| `models.scope:"workspace"` alone | `model/list` only gets `cwd` for existing threads and project checkouts; it is absent for a new projectless thread. The bridge maps cwd → threadId → profile. It works, but the catalog is cached for 10 min, so it needs the published catalog anyway. |
| `models.scope:"host"` + published catalog | Not run. The server "updates that provider's host/workspace catalog" (protocol doc), so with host scope every Hermes thread on the host would get the last-published profile's models. INFERRED: do not use. |
| Session options per model | They can't filter the model list. Rejected. |

### 1d. Profile change on a chat with messages → handoff — VERIFIED end to end

The user decision makes this the target flow. Run on `$BB_THREAD_28` ("Neo: plan for today"):
1. The user opens the chip and picks David (`s7-1d-e2e-1-pick-david.png`).
2. The server's `experimental_thread.events` handler reads the new `bb/session-option-selections {profile:"david"}`. The thread has prompt history, so this is a handoff. It then:
   - spawns "David chat (from Neo: plan for today)" with `sessionOptions:{profile:"david"}`, `pluginMetadata.handoffFrom`, and an agent-only init;
   - clears the old chat's choice (`threads.update({sessionOptions:{profile:null}})`);
   - calls `threads.open`.
   About 35 ms server-side (`handoff` event).
3. The browser lands on the new chat. Chip: David; models: David's, GPT-5.5 preselected (`s7-1d-e2e-2-new-david-chat.png`).
4. First message from bb's composer → the bridge gets `model:"gpt-5.5", sessionOptions:{profile:"david"}`; the reply is from David (`s7-1d-e2e-3-first-message.png`). The old chat still reports `profile: neo`.

What the bridge receives if the user sends before the handoff lands:
- `turn/start` with `options.sessionOptions.profile = "<new>"`.
- The bridge refuses cleanly: it keeps the profile, republishes the snapshot (which clears the pending choice), and replies "This chat stays on alex. A neo chat needs a new thread (bb opens one for you)." (`s7-1d-refusal.png`).
- The server handoff still fires.

bb's own "Handoff to new thread" (model picker menu, `s7-1d-bb-handoff-menu.png`):
- It appears for our provider.
- The new thread's first `turn/start` carries visible text `"<typed>Continue from @thread:<old>"`, **no `sessionOptions`**, and reuses the old chat's cwd.
- So the profile is lost (it falls back to the default), and the thread is not `originPluginId: hermes`.
- If kept, the bridge must take the profile from the mentioned source thread.

Open design points:
- Our handoff carries no conversation context. Options: a visible "Continued from @thread:…" line like bb's, or an agent-only summary in the init.
- `parentThreadId` would nest the new chat under the old one (not tried).

## 2. Empty "New Hermes chat" — VERIFIED

- `threads.spawn({title:"New <Profile> chat", sessionOptions:{profile}, input:[agentOnly({op:"init", profile})]})`.
- The bridge answers with `input.accepted`, `turn.open`, `turn.boundary` and no items, plus the chip and catalog state.
- Result (`s7-2-empty-chat.png`):
  - the timeline shows only "NEW ─ Provisioned thread"; no "Worked for 0ms";
  - the composer is bb's own: attach, voice, model chip, profile chip.
- About 5–8 s from click to a usable composer (environment provisioning plus the first bridge process). The page navigates as soon as the spawn returns and shows "Starting thread…".
- Artifacts:
  - **Unread dot:** the init turn's `thread.idle` sets attention. Fixed by `markRead` after idle; verified `unread False`.
  - **Notifications:** `thread.idle` fires, so push-notifications would send a "turn finished" push for the init. Not observable here (no devices). Mitigation INFERRED: set the notification level to `muted` at spawn and restore it after the init, or spawn hidden and reveal (that delays the open).
  - **Title:** see finding 4.
  - The first real message is the second turn: prompt history and search contain only visible text (verified: one history row).

## 3. Entry points — VERIFIED

- navPanel "Hermes" (rail icon `Bot`) lists Bots (pinned Bot Chats with unread dots), "New <Profile> chat" buttons and recent Hermes chats, via one RPC `overview` (`s7-3-navpanel.png`).
- homepageSection: one row of four "New <Profile> chat" buttons under bb's own composer (`s7-3-homepage-section.png`).
- Sidebar footer: `app.experimental_sidebarFooter.register({kind:"disclosure"})` shows the four buttons above the footer (`s7-3-sidebar-footer-disclosure.png`).
  - The `action` kind's `onActivate` gets only `openPluginDetails`: no RPC, no navigation.
- Command palette and shortcut: `app.commands.register({id:"new-chat", title:"Hermes: new chat", defaultShortcut:{key:"h", mod:true, shift:true}})`.
  - It shows as "Hermes: new chat … Hermes [Experimental] ⇧⌘H" (`s7-3-command-palette.png`).
  - Pressing ⇧⌘H created and opened "New Hermes chat" (`s7-3-shortcut-new-chat.png`).
  - Gotcha: `run()` gets no RPC or navigation either. It triggers an `experimental_appOverlay` component (which has hooks) through a module-level `EventTarget`; the same trick serves footer actions.
- **Recommended set:**
  - the navPanel (home for bots and recents);
  - the homepageSection (one click from home);
  - the ⇧⌘H command (it defaults to the last-used profile).
- Skip the footer disclosure: it duplicates the homepage row in a cramped spot.

## 4. Sidebar — VERIFIED

- Projectless Hermes chats and project chats both appear in the "Threads" list (default organization). The project chat shows its project only in the composer footer.
- **Pinned beats sections:** four bot threads put in a "Bots" section and pinned all show under "Pinned", and the section header sits empty. Unpinned, two of them appear under "Bots" (`s7-4-sidebar-pinned-vs-section.png`).
  - Pick one: pinned (top of the sidebar, no label) or a "Bots" section (labelled, collapsible).
- Provider icon: Hermes rows show no glyph while health is `not_installed` (all screenshots). With health `ready` (S3) rows show a glyph, but the provider then appears in the New Thread picker. Per-thread icons are still not possible.

## 5. Project-bound chat — VERIFIED

- `bb project create --name "Demo project" --root ~/.bb-spike-logs/demo-project --machine $HERMES_HOST` (a git repo).
- From our RPC:
  - `environment:{type:"project-default"}` → bb chose **git-worktree**: cwd `…/worktrees/$BB_THREAD_07-1/demo-project`.
  - `environment:{type:"provider", environmentProviderId:"project-checkout", inputs:{}, machine:{type:"existing", hostId}}` → cwd `~/.bb-spike-logs/demo-project`.
  - `inputs: null` fails: `The "project-checkout" environment provider needs inputs, and the request carried none`.
- The bridge logged that cwd on `thread/start`. The footer shows "Demo project · Project checkout · main", plus the "Open workspace in VS Code" buttons. No machine picker anywhere (DOM scan: no machine/host control) (`s7-5-project-checkout-chat.png`).
- Catalog caveat: see finding 1 (project chats share the project-path catalog scope).

## 6. Local sync channel (server ↔ host worker) — VERIFIED

Setup:
- `scripts/fake-gateway.mjs` (unix socket `/tmp/hspike/fake-gateway.sock` + HTTP `/emit`).
- Host contract `ensureWatch({socketPath})` is idempotent and is also the keep-alive. Signals: `changed {seq,t0,tWorker,pid}` and `watch {state}`.
- Server: a `bb.background.service("sync-watch")` calls `ensureWatch` every `syncKeepAliveMs`, plus `experimental_onSignal` and `experimental_onWorkerExit`.

| Check | Result |
|---|---|
| Long-lived connection | One socket per worker process; the gateway log shows one client. |
| Change → server latency | 8 emits: worker→server 0–3 ms, end to end 0–4 ms (`s7-sync.json`). |
| Past the 5-min idle rule | With 60 s keep-alives (call RTT 2–11 ms), worker pid 50608 stayed up for **7.3 min** (437 s), still connected and signalling. |
| Without keep-alive | **FAILED as expected:** the worker was stopped at 300 s. |
| After `bb plugin reload` | The old worker's socket closes and the new generation's service reconnects: ~90 ms gap (gateway log `client-closed` → `client-connected`). Verified 6 times. |
| After a bb restart | Reconnected about 1.9 s after relaunch; signals at 1 ms. |

- Without keep-alive (`syncKeepAliveMs: 0`, one call only): the daemon stopped the worker **exactly 300 s** after it started, even though the socket was open. The gateway log shows `client-closed`, and pid 26188 is gone.
  - **No `experimental_onWorkerExit` fired** (idle stops don't emit, as documented), and the `watch disconnected` signal never arrived.
  - A later emit reached 0 clients. So the keep-alive (or a lease) is mandatory.
- After a bb restart: SIGINT to the launcher, relaunch at t0. The background service's first `ensureWatch` landed at t0+1.794 s and the socket connected at t0+1.873 s (**~1.9 s after relaunch**). The next emit arrived in 1 ms (pid 28661).
- Notes:
  - Signals are ephemeral. On reconnect the server must re-list (Hermes `sessions.changed` is already a bare "re-list" signal).
  - `experimental_retainWorker()` is the documented alternative to keep-alive calls. It is implemented behind `HERMES_SPIKE_LEASE=1` but not run (there is no way to set worker env here).

## 7. Redeploy — VERIFIED

Before: 10+ hosted bridge processes on `s7-build-1`. After rebuilding with `BUILD_ID = "s7-build-2"`:
1. `bb plugin build && bb plugin reload hermes`.
   - The server, app and host worker switch at once. **Hosted thread processes do not**: a message to `$BB_THREAD_08` still answered `build=s7-build-1`.
2. Server RPC `stopHosted`: `threads.stop` on every **idle** Hermes thread.
   - 28 threads; 27 stopped; 1 skipped (`error`); 0.16 s.
   - Active (mirror or user) turns are skipped so we never interrupt them. Retry those after they finish.
3. The next message → `thread/resume` with the same `providerThreadId` (`david:bbnew_$BB_THREAD_08`) and a new pid, `build=s7-build-2`. The profile is restored from bridge state (neo); the chip and catalog are republished.

Minimal procedure: reload, then stop idle Hermes threads, then retry the busy ones on `thread.idle`. Mirrored threads re-host on their next wake. Nothing is lost, because bb keeps the timeline and Hermes keeps the session.

## 8. External messages as the user's own bubble — VERIFIED

Server RPC `wakeVisible`:

```
threads.send({mode:"queue-if-active",
  input:[{type:"text", text:"[Discord] <text>"},
         agentOnly({op:"sync", visibleUser:true})]})
```

The bridge mirrors only the reply (no `input.provider`).
- **Bubble:** a right-aligned user bubble "[Discord] Can you also book the dentist reminder?", then "Worked for 10s" and the reply (`s7-8-visible-external-message.png`). No System Message card.
- **Ordering:** `client/turn/requested` (seq 40) → `turn/started` → reply items (46–52) → `turn/completed`. Two back-to-back sends (Discord, then Conduit) became two turns in order. The second was `queued` while the first ran.
- **Prompt history: recorded.** `bb thread history` lists "[Discord] …", and ↑ in the composer recalls it (`s7-8-prompt-history-arrow-up.png`). The user could resend it by accident. Accept it, or delete the entries (no SDK delete for prompt history found; INFERRED).
- It is still a bb turn: active → idle, unread, `thread.idle` (same as S2).

## Recommended approach (for the plan)

- **Profile:**
  - the chip in every Hermes chat (category `mode`), full list always;
  - on an empty chat a pick applies at once (server → agent-only init turn); with messages a pick hands off to a new chat (finding 2);
  - the bridge refuses a late profile change as a fallback.
- **Models:**
  - `models.scope:"workspace"` plus `bb/provider-model-catalog` published by the bridge on start, resume and profile change;
  - the bridge maps a model the profile doesn't offer to that profile's default;
  - open problem: project chats share one catalog per project path.
- **New chat:**
  - an empty chat with a title and an agent-only init, `markRead` after the init, notifications muted during the init;
  - entry points: navPanel, homepageSection, ⇧⌘H.
- **Bots:** choose "Pinned" or a "Bots" section; they don't combine.
- **Sync:**
  - the host worker holds the gateway socket and signals `changed`;
  - the server's background service calls `ensureWatch` every 60 s (keep-alive plus reconnect) and re-lists on every (re)connect.
- **Redeploy:** reload, then `stopHosted` (idle only), then retry the busy ones.
- **External messages:** a visible tagged text plus an agent-only marker; accept the prompt-history entries.

## SDK APIs used (new in S7)

- Server:
  - `bb.hosts.experimental_client` (`call`, `experimental_onSignal`, `experimental_onWorkerExit`), `bb.background.service`;
  - `bb.events.on("experimental_thread.events")`, `bb.sdk.threads.events.list` (limit ≤ 100), `threads.promptHistory`, `threads.open`, `threads.update({sessionOptions})`, `threads.experimental_regenerateTitle`;
  - `threadSections.list/create`, `threads.pin`;
  - `providers.register({models:{scope:"workspace"}, experimental_bridgeOptions})`.
- Host: `experimental_defineHostEntry({experimental_signals})`, `context.experimental_emitSignal`, `context.lifecycle.signal`.
- Bridge: `extension.state` `bb/session-options` and `bb/provider-model-catalog`; `model/list` with `cwd`; `turn/start.options.sessionOptions` and `.model`.
- App: `app.slots.navPanel`, `homepageSection`, `experimental_appOverlay`, `app.experimental_sidebarFooter.register({kind:"disclosure"})`, `app.commands.register({defaultShortcut})`, `useRpc`, `useBbNavigate`.

## Gotchas

- `src/protocol.ts` is imported by the app bundle. Anything using `process` there breaks the frontend ("frontend bundle failed to load: process is not defined"). Node-only config moved to `src/s7-config.ts`.
- `threads.events.list` refuses `limit` > 100 (`Thread event limit cannot exceed 100`).
- agent-browser in this setup lags a frame on screenshots and loses refs across renders. One-shot `script` runs were reliable.
- The bridge control-port fan-out (spike only) covers 10 ports. More than 10 bridge processes were hosted at once.

## Isolated bb

- Stopped after this spike; `~/.bb-spike` is kept. Restart:

  ```
  ~/.bb-spike-logs/start.sh   # unsets BB_*, runs: BB_SKIP_ONBOARDING=1 npx -y bb-app@0.48.1 --data-dir ~/.bb-spike --server-port 48886 --host-daemon-port 48887 --no-in-app-updates
  ```

  - Run it in the background with: `cd ~/.bb-spike-logs && nohup ./start.sh > launcher.log 2>&1 &`.
  - The CLI wrapper `~/.bb-spike-logs/sbb` pins `BB_SERVER_URL=http://127.0.0.1:48886`.
  - The fake gateway (needed for the sync service):

    ```
    node scripts/fake-gateway.mjs /tmp/hspike/fake-gateway.sock 48910
    ```

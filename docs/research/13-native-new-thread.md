# 13 — Native New Thread for Hermes, and the Hermes icon on rows

Date 2026-11-09. bb-app 0.49.0, SDK 0.6.132, on `main` v1.0.1 plus uncommitted spike edits. Isolated bb `~/.bb-hermes-e2e` with **two machines**: the bundled daemon `e2e-host` (primary, no Hermes; stands for $BB_SERVER_HOST) and a second host daemon `hermes-host` (the strict fake Hermes; stands for $HERMES_HOST). Headless Chrome for Testing in UTC.

Labels: **VERIFIED** = observed on the isolated bb (screenshot, CLI, bridge record, `bb.db` read-only), or read in bb's shipped code where marked "source". **INFERRED** = concluded, not run. **FAILED** = tried, doesn't work.

Source paths: `start-server.js` = `node_modules/bb-app/server/dist/start-server.js`; app chunks in `node_modules/bb-app/app/dist/assets/` (minified; function names as of 0.49.0); thread list = `server/dist/builtin-plugins/thread-list/dist/app.js`.

## Answers in brief

1. **Listing** has one rule: a provider is listed on machine M if it is `always`, or `installed` and its health on M isn't `not_installed`. The New Thread picker uses the selected machine. Settings → Providers, the sidebar icon and `bb provider list` use the primary machine. The Install banner and update badges exist only for providers with `maintenance.installation`, which Hermes doesn't have, so **no Install button ever shows**.
2. **Icon:** `experimental_visibility: "always"` is a one-line change. It shows the icon for every client, whichever machine is primary.
3. **Profile before the thread exists already works.** Our `model/list` sends the bot as a `category:"mode"` session option, and bb's New Thread draws it as a chip listing every switched-on bot. A native New Thread on `hermes-host` with Alex picked became an Alex side chat.
4. **Models can't follow the chip** before the thread exists: `model/list` gets no session options. They follow after the first message (S7 1c).
5. **No provider-side machine lock.** A new-thread composer banner can switch the draft to the Hermes machine with `setSelection` (VERIFIED). The dispatch refusal stays as a backstop.
6. **Projects work** with Project checkout on `hermes-host`. Bug found: after the first Hermes chat in a project, that project's New Thread loses the bot chip.
7. **SDK 0.6.133:** nothing relevant.
8. **Main new risk:** Settings → Providers gains a one-click **Disable**, which stops every Hermes turn, wake and import.

## Recommended design

1. Register `experimental_visibility: "always"` (`src/bridge/provider.ts`). Keep `maintenance.health`, answering per machine: `ready` where a fresh worker file is, `not_installed` elsewhere. Health then feeds only bb's onboarding and its "prefer a ready provider" default. Never set `maintenance.installation`.
2. Add a new-thread composer banner (`composer.customize({scopes:["new-thread"]})`). When the provider is Hermes and the machine isn't the Hermes machine, it shows "Hermes runs on <machine>. [Use <machine>]", which calls `setSelection`. Also switch automatically once, when the user picks Hermes. Don't switch at page load: it raced the draft restore.
3. Reword the dispatch refusal for the app: "Hermes runs on <machine>. Pick <machine> as the machine." It currently says "add `--machine …`", a CLI flag.
4. Off the Hermes machine there's no worker file, so `model/list` answers only the placeholder "The bot's model". On the Hermes machine, with no cwd, also put "The bot's model" first as the default. A first turn on another bot then uses that bot's own model, with no "isn't one of this bot's models" warning. The bot's real list appears in the thread after start.
5. Publish the bot option (every switched-on bot, value = this thread's bot) in the models of `bb/provider-model-catalog`. Otherwise project-scoped catalogs lose the chip (§6).
6. `onCreatedNow`: read the profile from the `bb/session-option-selections` event. The recorded `client/thread/start` params are empty, so today the side-chat binding only lands after the first turn.
7. Keep the rail panel's "New chat with <bot>" and `bb thread spawn`; they keep working.

## 1. Listing — VERIFIED (source + isolated bb)

Rule:
- `start-server.js:103526` lists `always` providers that aren't disabled.
- `:103542-103570` adds each `installed` provider whose `provider.health` on that host is `status !== "not_installed"`.
- Those answers are cached 5 min per host (`:237187`, `rememberInstalled`/`revalidateInstalled`); a plugin reload resets them.
- Host = the request's environment, else its `hostId`, else the primary host (`:103465`).

CLI matrix: each case was set with spike knobs, followed by a plugin reload and `bb provider list` (no flag, `--machine e2e-host`, `--machine hermes-host`).

| Registration | Health on `hermes-host` / `e2e-host` | Listed on primary (`e2e-host`) | Listed on `hermes-host` |
|---|---|---|---|
| installed (v1.0.1) | not_installed / not_installed | no | no |
| installed | ready / not_installed | **no** | yes |
| installed | ready / `unknown`, `unauthenticated`, `expired`, `unsupported_version` or `ready` | yes | yes |
| always | ready / not_installed | yes | yes |

Surfaces:

| Surface | Whose listing | What Hermes gets | Evidence |
|---|---|---|---|
| New Thread provider tabs | the selected machine (`system/executionOptions {hostId}`; plugin-frontend `KI`) | a Hermes tab where listed | `13-picker-other-machine-hidden.png` (per-machine: no tab on `e2e-host`), `13-new-thread-bot-chip.png` |
| Home composer "not installed / Install" banner | `hosts/<id>/provider-cli-status`, only providers with `maintenance.installation` (`start-server.js:192113-192117`; root-compose `G=Nt!==null&&(!Nt.installed\|\|…)`) | never | no banner on `e2e-host` with `always` + `not_installed`, nor with `unknown` |
| Settings → Providers | `providers.list` without host = primary (SettingsView `bi` → `xe()`); health isn't shown | a row with Disable / Make default | `13-settings-providers-listed.png` |
| Sidebar row icon | `experimental_useProviders()` = `providers.list` without host (thread list `XT`: `D=S?b.find(…)`; plugin-frontend `im`→`UI`→`HI`) | icon on every Hermes row | `13-sidebar-icons.png` |
| `bb provider list` | primary; `--machine` = that machine | as in the matrix | CLI |
| Model picker / "Handoff to new thread" | the thread's environment host, plus the thread's own provider (`includeRequestedRegisteredProvider`, `:103532`) | handoff target on machines where listed | S3a; source |
| Update badges ("Codex and Claude Code updates available") | provider CLI status again (index `n6`) | never | source |
| Health text (`statusMessage`) | `system/providerStates`: onboarding, and "prefer a ready provider" when none is remembered | not shown on any surface above | DOM check |

**A machine without Hermes**, Hermes listed (`13-new-thread-other-machine.png`):
- the Hermes tab and icon show;
- the model chip reads "The bot's model" (bridge placeholder);
- there's no bot chip and no Install banner, and bb adds no text.
- Submit shows a toast: "Failed to create thread · Blocked by the "hermes" plugin: Hermes runs on hermes-host: add `--machine hermes-host`." No thread is created and the draft is kept (`13-refused-other-machine.png`).
- The banner line in these screenshots is the spike's.

## 2. Icon options

| Option | Change | Result | Side effects |
|---|---|---|---|
| **A. `always`** (recommended) | one field | icon everywhere, independent of the primary machine and of probes. VERIFIED (CLI + same UI as B) | Hermes in New Thread on every machine. Settings row with Disable / Make default. bb's catalog prewarm calls `model/list` on every host (`:237093`); off the Hermes machine that's an instant placeholder |
| B. per-machine health `ready` / `unknown` | bridge health | same as A, VERIFIED (`13-sidebar-icons.png`) | depends on the primary host's bridge answering, with a 5-min cache. If the primary host is unreachable, only `always` providers list (`resolveSystemProviderInfosPlan`, `:103620`), so the icon blinks out |
| C. per-machine `ready` / `not_installed` | bridge health | Hermes only in `hermes-host`'s New Thread; **no sidebar icon** unless $HERMES_HOST is primary. VERIFIED | fails the goal |
| D. app only | — | no slot draws the row's provider icon. `experimental_threadList` replaces the whole sidebar (exclusive). Our row badge already draws the icon in the metadata line, behind the threadRowMetadata experiment (as in the screenshots) | — |

## 3. Native New Thread flow — VERIFIED end to end (fake Hermes)

1. Pick Hermes on `hermes-host`. bb asks `system/executionOptions {hostId, providerId:"hermes"}`, which runs `model/list {cwd?}` in a bridge maintenance process. Our `modelList()` answers models with `sessionOptions:[botOption(bot, enabled)]` (`src/bridge/composer.ts`, category `mode`).
2. bb splits `category:"mode"` options into the New Thread footer chip (plugin-frontend `kv`/`Mv`, `sessionOptionsControl`). The menu lists the switched-on bots: Hermes, Alex, Bob (`13-new-thread-bot-chip.png`). The choice is remembered per provider.
3. Submit sends `threads.create({…, sessionOptions:{profile}})` only if the user changed the chip. bb records it as `bb/session-option-selections` (event 1); the recorded `client/thread/start` params are `{}`.
4. Our `message.dispatch` hook passes (right machine). The personal workspace is provisioned on `hermes-host`.
5. The bridge gets `thread/start {cwd, options:{providerOptions, sessionOptions:{profile:"alex"}}}` → `resolveContext` (`src/bridge/context.ts:68`), then `turn/start`. A chip change before the first message also arrives in `turn/start.options.sessionOptions` (S7 1a). The bridge's thread record says `profile: alex`; the reply came back (`13-native-thread.png`).
6. Server: `threadInfo` → `kind: chat, Alex`. The binding came from the persisted-turn path, because step 3's params are empty (design item 6).

Edge cases:
- Untouched chip: no `sessionOptions` sent, yet the bridge still got the value the chip showed: `default`, or `alex` when `default` was off. VERIFIED (bridge records). The mechanism, bb filling option defaults from the catalog, is INFERRED.
- A bot switched off: it leaves the chip on reload, and a remembered choice falls back to the chip's default. VERIFIED.

Other candidates for a pre-thread profile choice:
- `bb/session-options`: thread-scoped, needs a running thread (S3a, S7).
- `deriveProviderOptions`: server-side, per command, after creation; no UI (SDK `PluginProviderOptionsContext`).
- Composer customization (new-thread scope): reads `selection`. `setSelection` covers project, environment, provider, model, reasoning, tier and permission, but **not session options** (app d.ts `ComposerSelection`, l. 23262).
- `experimental_NewThreadComposer`: bb's full composer in our slot. `onSubmit` gets `NewThreadRequest` including `sessionOptions`, and we spawn, so we could force placement. Its provider picker still needs Hermes listed on the selected machine. INFERRED.
- `homepageSection` / rail panel: today's own form (S3b).
- Codex, Claude and Pi: their pre-thread chips are the same catalog fields (`supportedReasoningEfforts`, `supportedServiceTiers`, per-model `sessionOptions`) plus `permissionModes`. bb has no other pre-thread channel (source: `system/executionOptions` response schema).

## 4. Models per profile

- `model/list` params are only `cwd`, `envVars` and `selectedModel` (`bb-plugin-sdk-provider-bridge.d.ts:4503`). The composer's catalog query key has no session options, so **the New Thread model list can't follow the chip**. VERIFIED (source).
- Projectless New Thread: no cwd, so the bridge answers the `default` bot's catalog (else the first switched-on bot's). This is the `''` scope row in `provider_model_catalogs`, VERIFIED read-only.
- After start, the thread's cwd is its own personal workspace, so its published catalog is per thread and follows the bot (S7 1c).
- The first turn on another bot: `chooseModel` swaps an unoffered model for the bot's own and adds the warning `unofferedModelText`. Design item 4 removes the warning. INFERRED.

## 5. Machine

- **No lock or hide** (VERIFIED from types):
  - `PluginProviderDeclaration` has no machine field (`bb-plugin-sdk.d.ts:21047`);
  - `requires` (projectCheckout, gitCheckout, gitRemote, projectless) belongs to environment providers;
  - `availability()` and `machineAvailability` rate an environment option per machine, not an agent provider;
  - `deriveProviderOptions` gets no host.
- **Works:** the spike banner called `useComposer().setSelection({environment:{type:"provider", environmentProviderId:"personal-workspace", machine:{type:"existing", hostId:<Hermes>}}})`. The machine switched, and Hermes' models and the bot chip loaded. VERIFIED.
- The automatic switch at page load applied only after several seconds: it raced the draft restore. Hence design item 2. VERIFIED.
- **Fallback:** the dispatch refusal. VERIFIED, needs rewording.
- **A bridge on another machine can't reach Hermes.** It needs `<home>/gateway.sock`, a unix socket, and a loopback `api_origin` (`src/hermes/control.ts:30-50, 102`). A relay through the bb server to our worker is conceivable but heavy. INFERRED.

## 6. Project

- Today `spawnPlacement` (`src/server/bots.ts:32`) always uses the personal project and the personal workspace on the Hermes machine.
- Native, with "No project": personal workspace per thread. VERIFIED.
- Native, in a project, with Project checkout on `hermes-host`: the chat is bound and replies; cwd = the project root. VERIFIED. The bot still runs in its own `terminal.cwd` (`ThreadContext.cwd = bot.cwd`). Worktree not tried: it would make a git worktree per chat.
- **Bug (VERIFIED):** the catalog scope for project threads is the project path, so it's shared. Our published catalog carries no `sessionOptions`, and after one Hermes chat in "Demo project" the `provider_model_catalogs` row for `…/demo13` had none. That project's New Thread then shows no bot chip (`13-project-no-chip.png`); projectless New Thread still does. Design item 5 fixes it. The model list is also the last project chat's bot's (S7 finding 1).

## 7. Newer bb — VERIFIED

- `@get-bb/plugin-sdk` 0.6.133: `dist/` is identical to 0.6.132.
- Its types drop the `timelinePush` experiment id and move a testing doc comment (`experimental_invalidateRpc`).
- `bb-app` 0.49.0 is still the latest (`npm view`).
- Nothing relevant; the repo was not upgraded.

## 8. Risks if Hermes is listed

- **Existing bot threads, side chats and mirrored chats:** they gain the row icon (VERIFIED for bot threads and side chats). Their flows are unchanged: same provider, same bridge. INFERRED for mirrors.
- **Disable in Settings → Providers:** every Hermes turn, including our wakes and imports, fails with "Provider "hermes" is disabled. Enable it in Settings → Providers to start a new turn." (`start-server.js:74067`). This is possible by CLI today; listing makes it one click. Health or diagnostics should name it.
- **Make default:** New Thread opens on Hermes on every machine.
- **Bot switched off:** not offered in the chip (VERIFIED). A stale catalog could still offer it; the bridge then refuses "<bot> is switched off…" (existing code).
- **The `default` bot "Hermes":** the chip reads "Hermes" next to the Hermes model chip, which is ambiguous. With `default` off, the chip shows the first switched-on bot and binds correctly (VERIFIED).
- **bb's "Handoff to new thread":** it drops the profile (S7 1d). Once listed, a Codex, Claude or Pi thread on $HERMES_HOST can hand off into Hermes: a chat with `default` and "Continue from @thread:…". Elsewhere the dispatch hook refuses it. INFERRED.
- **Titles:** bb's generator names native chats ("Create a new thread for bb" for "Hello from bb's New Thread"). `retitleNow` touches only our placeholder titles. There's no init turn, so no mute or markRead dance. VERIFIED.
- **Two Hermes entries:** provider-acp's "Hermes Agent" (`acp-hermes-agent`) can be listed beside ours wherever `hermes` is on PATH. It is a disabled row here; live not checked.

## Alternatives

- **B. Per-machine health, `ready` / `unknown`:** same UI as A, but the icon depends on a probe of the primary machine. Choose it only to keep hiding Hermes somewhere specific.
- **C. Per-machine only:** the cleanest New Thread, since Hermes appears only on $HERMES_HOST, but no sidebar icon. That fails the owner's goal.
- **E. Keep hidden, embed `experimental_NewThreadComposer` in the rail panel:** bb's full composer, including the bot chip if Hermes is listed on $HERMES_HOST, with placement forced in `onSubmit`. It only works in our panel, and there's no sidebar icon.
- **Today:** the rail panel and `bb thread spawn`, with no native entry and no icon.

## Questions for the owner

1. Listing: **(a) `always`, recommended**; (b) per-machine `ready` / `unknown`; (c) per-machine only, no icon.
2. New Thread on the wrong machine: **(a) banner with a button, plus a one-time switch when Hermes is picked, recommended**; (b) banner only; (c) bb's refusal toast only.
3. Projects: **(a) allow, recommending Project checkout, recommended**; (b) allow "No project" only (refuse in the dispatch hook); (c) allow any environment, worktrees included.
4. New Thread model default: **(a) "The bot's model" first, recommended**; (b) the `default` bot's list, as today.

## Method, setup and safety

- **Second machine:** `POST /api/v1/hosts/join-codes` on the isolated server, then `host-daemon/dist/daemon-bundle.mjs` with `BB_HOST_ENROLL_KEY`, `BB_HOST_ID`, `BB_CLI_DIR`, `BB_DATA_DIR` under `/private/tmp`, port 48888, the same clean env as `bb-e2e.sh` (no `hermes` on PATH, `TZ=UTC`). It was renamed `hermes-host`, and the plugin was connected to it.
- **Spike edits (uncommitted):**
  - `src/bridge/provider.ts`: visibility from a file;
  - `src/bridge/bridge.ts`: health per machine from a file, role = worker file present;
  - `src/app/spike-new-thread.tsx`: the new-thread banner;
  - a small CDP driver, because agent-browser lagged a frame here.
- **Isolated bb only, no live access:** live bb was read with `bb status` and `bb thread show` only, and live Hermes was not touched.
- **Cleanup:**
  - the second machine was removed and its data dir deleted;
  - bot switches and the connection were restored to `e2e-host`;
  - the demo project was deleted;
  - the stale `worker.json` on `e2e-host`, set aside during the run, was restored;
  - the fake, bb-app and Chrome were stopped.

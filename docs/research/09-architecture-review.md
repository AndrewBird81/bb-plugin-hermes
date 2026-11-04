# 09 — Independent review of `00-architecture-draft.md`

Method: I treated the draft as wrong until checked. Every claim was tested against research 01–06, and some were re-checked in source under `~/.hermes/hermes-agent` and `~/.hermes/plugins/conduit_push`. **V** = I read the source or file myself. **R** = taken from the research docs only. No live probes, no writes, no secrets read.

## Verdict
- **The direction is right; the transport is not settled.** These choices hold up: the canonical gateway as the session authority, a bb provider bridge, and our own new-chat UI. Option A, though, rests on a false precedent: Conduit does not relay through a companion plugin. A simpler first-party path exists that the draft never evaluated: the gateway's own listener (the "Webapp"). Merge verdict: **BLOCK building; OK to start the spikes once the Must-fix items are written into the spike plan.**
- **The draft never says where the bridge runs**, and that question decides A vs B. The bridge always runs on an enrolled host pinned by the thread's environment. So A's main advantage ("works wherever Hermes lives") disappears if that host is $HERMES_HOST. A then adds a tailnet hop, a root-equivalent token and a Python plugin, and gets nothing for them.
- **The biggest risk is import and mirroring, not transport.** The draft has no rule for duplicates (the existing ACP threads, and sessions bb itself creates coming back through the feed). It has no default for volume (alex cron runs). Its main notification mitigation depends on an API with no evidence it exists. S1–S4 test whether import and mirroring work, not whether they behave well at real volume.

## Must fix

- **M1. False precedent: "Conduit uses the same pattern" (Alternatives table, A pros).**
  - V: `conduit_push/upstream/contract.yml`, note "chats on the gateway's listener": Conduit's chat socket is either the dashboard's legacy `/api/ws` or the **gateway's own listener (Webapp)**. It tells them apart by `gateway.ready.session_authority`.
  - V: `connect_gateway` appears only in `bot_chat_adopt.py:152-167`, as a one-shot child process that resumes and then detaches a Bot Chat. It is not a relay.
  - Fix: delete the claim. Re-justify A on its own merits.

- **M2. Missing option E: the gateway listener with Webapp enabled.**
  - V: `gateway/webapp_listener.py:1-15`. `webapp.enabled` binds the gateway's single listener to a stable port (default 9120). `webapp.public_url` engages dashboard sign-in for proxy or tunnel access.
  - V: `gateway/run_api.py:1-13, 77-110`. That listener mounts the **full dashboard app with `session_authority` set**. This means canonical `/api/ws`, dashboard REST and dashboard plugin routes, all in the gateway process.
  - Result: a remote bridge gets canonical verbs and REST directly, with no relay. A feed plugin, if still needed, would run next to the authority (Conduit drives chats there via `gateway.session_controls.AuthorityConnection`, per contract.yml).
  - Costs:
    - A config change and gateway restart (drops live sessions).
    - The token is `<home>/webapp/session-token`, which rotates on sign-out (`browser_session_token`, `webapp_listener.py:229-241`).
    - The authority uses different request shapes for the same verbs (`submission_id`, `session.mutate`; contract.yml).
  - V: `webapp` is not in `~/.hermes/config.yaml` today.
  - Fix: add E to the table and spike it before writing any relay.

- **M3. State the bridge host, then re-rank A, B and E.**
  - Bridge on $HERMES_HOST: B (gateway socket over loopback) needs no network token, no `tailscale serve` and no Python. It shares fate with Hermes, which is already true: a sleeping $HERMES_HOST means Hermes is down anyway. The control-socket ticket handshake is documented (`gateway-internals.md:249-258`, `session-ticket`), so the TypeScript bridge can mint tickets itself.
  - Bridge on $BB_SERVER_HOST: the token has to reach the host daemon over host RPC, never via `experimental_contributeEnv`. That path leaks values in `provider.env-resolved` (01 G11, R).
  - The diagram's "host daemon" box is unlabeled. Fix: label it and record why.

- **M4. Plugin WebSocket routes are not authenticated by the dashboard gate.**
  - V: `hermes_cli/web_server_dashboard.py:926-963`. `PluginApiWebSocketGate` checks only Host/Origin/peer (`_ws_request_is_allowed`) and whether the plugin is enabled. It "refuses before the route's own credential check"; the HTTP auth middleware never sees an upgrade.
  - V: contract.yml, "dashboard websocket auth": every plugin socket must call `hermes_cli.web_server_chat._ws_auth_ok` itself.
  - 02 §5 and 03 §6 assumed plugin WebSockets sit "behind the same auth gate". **They do not.**
  - As drafted, `/feed` and `/gateway` would hand a full gateway relay to any tailnet peer whose Host header passes.
  - Fix: every companion WebSocket calls `_ws_auth_ok` and fails closed. Add a test that an unauthenticated upgrade gets 4401/1008.
  - Corollary (V, `web_server_chat.py:381-418`): WebSocket credentials are tickets (subprotocol or `?ticket=`). The bridge must mint one via `POST /api/auth/ws-ticket` (30 s, single use, 02 §4) before every (re)connect.

- **M5. `connect_gateway()` can start a second, unsupervised gateway.**
  - V: `hermes_cli/gateway_client.py:345-350`. With no endpoint it calls `ensure_gateway_runtime(home, idle_exit=True)`.
  - During a launchd gateway restart (ThrottleInterval 30, 04 §1), the relay could launch its own gateway, which then fights launchd's `gateway run --replace`.
  - Fix: discover the endpoint first and pass it in; never let the relay start a gateway. Conduit does exactly this (`bot_chat_adopt.py:139-167`).

- **M6. Duplicate threads: no dedupe rule.**
  - ACP twins: 18 `acp-hermes-agent` threads exist; their Hermes copies are 11 `source=local, created_source=acp` sessions (04 §4–5, R). Import would make a second thread for each. The ACP provider stays enabled, so this keeps happening.
  - Probe sessions: 137 empty `acp` probe sessions (04 §5). Our own `model/list` must not create sessions the way ACP discovery did.
  - Self round-trip: sessions our bridge creates will reappear in the feed. bb refuses a `providerThreadId` that another thread already announced (01 §2, R), so a racing import leaves an orphaned marker thread.
  - Fix:
    - Feed skips sessions bb created: tag them at `session.create` (`source`/`idempotency_key`), and only import after the bridge has announced its identity.
    - Explicit policy for `created_source=acp` (link, skip or migrate → user question).
    - Never import empty sessions.

- **M7. Volume and notifications: the mitigation rests on an unverified API.**
  - "Set notification levels per thread" (Known limitations): 01's thread mutation list (`update`: title, section, parent, model, reasoningLevel, visibility) has **no** notification control (V: grep of 01).
  - alex cron alone: 122 sessions in 30 days. Each would become a new thread, a bb turn, an unread badge and a notification (04 §6, R).
  - Import is a bb turn per thread, so ~85 non-empty sessions means a burst against concurrency limits and ~85 unread threads.
  - Fix: decide the defaults before S1 and S2:
    - Do not auto-import `cron`, `oneshot`, `subagent` or empty rows. Group or hide bot cron runs.
    - Import lazily and throttled.
    - `markRead` after each import (that API exists, 01 §4).
    - Verify notification control, or drop the claim.

## Should consider

- **Lineage key.**
  - Use Hermes' compression lineage (`get_compression_chain`/`compression.lineage` root; V `hermes_state_compression.py:884-901`). Do not walk `parent_session_id`: it also links `/branch`, subagents and delegations (03 §1), which would merge separate conversations into one thread.
  - Key on the **DB home**, not `profile_name`: david's DB holds rows tagged `todoist` (03 §4).
- **One lineage = one thread fragments Discord.**
  - `session_reset` rolls gateway chats daily or after 24 h idle (04 §2, R), so each Discord conversation becomes one thread per day.
  - Consider grouping by `origin_json.chat_id`/`thread_id` or parenting under one thread. Low volume today (~3 per 30 days), so this is P2.
- **Profile as a session option.**
  - bb has no "lock after first message". The footer select stays editable, so the bridge must refuse silently or swap the session (01 G9).
  - Models are host-scoped but credentials are per-profile `.env` (03 §4), so the picker will offer model×profile pairs that fail.
  - Simpler: choose the profile only in our new-chat UI and store it in `providerThreadId` plus pluginMetadata. If the session option stays, it should show the profile, not change it.
- **The relay is an open pass-through.** The token is already root-equivalent (02 §4), but the relay should still allowlist verbs: create, resume, `events.since`, `prompt.submit`, interrupt, steer, `approval.respond`, `clarify.respond`, title, archive. It should not forward `config.*`, `cron.*` or `profiles.configure`.
- **"Small Python plugin" understates the maintenance.**
  - Conduit keeps a CI contract watcher over ~40 upstream paths and a known-failure list: plugin sockets on a secondary profile return 501 since v0.22.3 (V, contract.yml `known_failures`).
  - The draft's relay imports private symbols (`_ws_auth_ok`, `connect_gateway`, discovery).
  - Prefer E or B, which use the documented `hermes-gateway-v1` wire protocol from TypeScript. If a plugin is needed, keep it to the feed only and never use `?profile=` on its sockets.
- **The relay must run in-process.** V: `web_server_dashboard.py:1018-1020`: "streaming and websockets need in-process". So 02's `plugins.isolation: host` fallback is impossible for the relay; it shares the dashboard event loop with Conduit. All handlers must be async-only.
- **One socket or five.**
  - Canonical `profile` on every call works only with a host-scoped grant. "A profile-bound ticket gets metadata alone" for sibling profiles (V, `gateway-internals.md:35`).
  - `connect_gateway` mints for `get_hermes_home()`. Conduit spawns a child process per profile `HERMES_HOME` (`bot_chat_adopt.py:129-139`).
  - The draft assumes one multiplexed connection.
- **Operational:**
  - `hermes update` orphans a dashboard with a random token. The launchd dashboard then crash-loops on EADDRINUSE and bb gets 401 until `bootstrap.sh service` (V, `bootstrap.sh:108-121`). The bridge should emit `provider/recovery authRequired` with that fix in the message.
  - `tailscale serve --bg` persists but is not declarative (V, `bootstrap.sh:183-197`). Add a health route that bb surfaces.
  - Any plist change drops all live sessions (04 §1).
- **Approvals.** `approvals.timeout: 60` (03 §3): a bb-started turn auto-denies if nobody is watching bb. Surface the deadline in the interaction, or accept it.
- **Bots.**
  - Exclude Bot Chats from general import (handle collision).
  - Hide the stale `todoist` profile (Bot Chat with 0 messages).
  - Bot Chat `/new` compacts, so it rotates ids. Resolve by lineage root, not by title alone.
- **Sidebar order.** "Import oldest first" breaks under concurrent turns and the first mirrored turn. Every wake bumps `updatedAt` anyway. Accept the bb order, or import serially and show the Hermes timestamp in the row metadata slot.

## Spike gaps
- **S0 (new): transport and auth.** Run end to end over `:8448`:
  - bearer → `ws-ticket` → plugin WebSocket;
  - an unauthenticated plugin WebSocket is refused;
  - the same on option E;
  - one connection drives two profiles (host-scoped vs profile-bound grant).
- **S5 (new): resilience.**
  - Kill the dashboard, the gateway and the bb host daemon mid-turn, separately. Confirm `session.events.since` recovers. The replay ring is 512 events/session (06 §2), so check a long turn.
  - Simulate `hermes update` token rotation and confirm the bb thread shows `authRequired`.
- **Dedupe (S1 extension):**
  - a bb-created session is never re-imported;
  - importing a session that has an ACP twin;
  - a handle collision leaves no orphan thread;
  - `model/list` creates zero Hermes sessions.
- **Volume (S1/S2 extension):**
  - import ~85 sessions: concurrency limit, unread count, notification count, order;
  - a cron run with the default filter applied;
  - whether any notification-level API exists.
- **S2 additions:**
  - user sends or steers while a mirror turn is open: the bridge must map it to `prompt.submit queued`, not `session.steer`;
  - mirror after the 30-min idle release;
  - wake input never appears in bb prompt history (01 G2).
- **S3 additions:**
  - archive/rename forwarded with no live runtime (01 §4, unverified);
  - the profile select is changed after the first turn;
  - the provider is picked on $WORK_HOST from the standard composer.
- **S4 additions:**
  - Bot Chat resume while Conduit holds its active-session lease. Bot Chats here are legacy `desktop`/`tui` rows that Conduit's adopt sweep may not have moved yet (V, `bot_chat_adopt.py:1-25`).
  - An approval answered in Discord while it is pending in bb.
- **S4 safety.** "Find out whether a viewer's reply is posted to Discord" posts into a real channel. Use a throwaway Discord thread, or get approval first.

## Questions the user must answer
1. Is "through the dashboard" a hard requirement, or just one way to get remote access with full fidelity? This decides A, B or E. My view: **E if remote access matters, B if not; A last.**
2. Which machine hosts the bridge: $HERMES_HOST or $BB_SERVER_HOST?
3. Is it OK for $BB_SERVER_TS to hold a root-equivalent Hermes credential (dashboard or Webapp token)?
4. Is it OK to enable `webapp.enabled` (config change plus a gateway restart that drops live sessions) for option E?
5. Import defaults: which sources, how far back? Should alex cron runs be hidden, grouped or shown?
6. The 18 `acp-hermes-agent` threads: link, ignore or migrate? Retire the ACP provider once this ships?
7. Should bb replies into a Discord-originated session post to Discord, or stay detached?
8. Bots: confirm Bot Chat = bot. Hide `todoist`?
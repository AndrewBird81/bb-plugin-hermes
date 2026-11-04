# bb-plugin-hermes — architecture draft (v0, 2026-11-04)

Status: ideation. Evidence: `docs/research/01..06`. Nothing here is decided until the user answers the open questions.

## Facts that shape everything

- **bb** (0.48.1, SDK 0.6.104):
  - A plugin can register a full agent provider. Its bridge (line-delimited JSON-RPC) **always runs in a host daemon on an enrolled machine**, never in the bb server. It can be a pure network client. (01 §2)
  - Every thread needs a project + environment. Use the personal project + a projectless environment provider pinned to one host. (01 §5)
  - **No import API:** a thread can't be created already bound to an existing session, history can't be written without a turn, and home-page status only moves while bb runs a turn. All three are worked around through bridge-opened turns. (01 G1–G3)
  - The standard New Thread composer always shows machine and provider pickers. Plugins can add their own UI (`navPanel`, `homepageSection`) that spawns threads with fixed values. (01 G4)
  - A profile maps onto a per-model `sessionOptions` select. With `category: "mode"` it sits in the composer footer. (01 §3)
- **Hermes** (0.22.6 canary @ c314285f):
  - One multiplexed gateway owns every session for all 5 profiles. Its **canonical WebSocket** (`hermes-gateway-v1`) is the only interface with full parity:
    - create or resume any session (Discord, cron and Bot Chats included)
    - multi-viewer events with `seq` replay
    - approvals and clarify
    - queue, steer, interrupt
    - `profile` on every call
  - Constraint: that WebSocket listens on an ephemeral loopback port, and its tickets come from `~/.hermes/gateway.sock` (same OS user only). (03 §2c)
  - **Dashboard** (`:9119`, tailnet `:8448`, Bearer token):
    - Has the REST endpoints we need: sessions across profiles, history, and PATCH for pin/archive/title/unread.
    - Its own `/api/ws` is the legacy dispatcher, so avoid it for writes.
    - Plugins can mount HTTP and WebSocket routes at `/api/plugins/<name>/`, in-process with Hermes internals. Conduit's plugin already does this. (02 §3–5)
  - **Bots** = Bot Mode: each bot is a profile with one hidden, permanent `Bot Chat` session. Conduit and Desktop show them; this setup has Hermes, Alex, David, Neo (plus a stale todoist profile). (04 §3)
  - ACP lists only sessions bb itself created. The API server can't attach to sessions owned by another client (returns 409). The webui runs its own session store on top of the API server. → None of these is the core transport. (03, 05, 06)

## Recommended shape (Option A)

```
bb server ($BB_SERVER_HOST)                          $HERMES_HOST
┌──────────────────────────────┐   HTTPS/WSS    ┌──────────────────────────────────────┐
│ server.ts                    │  Bearer token  │ Hermes dashboard (:8448 tailnet)     │
│  sync service: feed → threads│───────────────▶│  REST /api/profiles/sessions, PATCH  │
│  mapping db (profile,root)   │                │  companion plugin `bb_bridge`:       │
│  bots, settings, own UI      │                │   WS /feed     change feed (cursor)  │
└────────────┬─────────────────┘                │   WS /gateway  thin relay ───────────┼──▶ canonical gateway
             │ host RPC                          │                (connect_gateway)     │   (session authority)
┌────────────▼─────────────────┐   WSS          │                                      │
│ host daemon: provider bridge │───────────────▶│                                      │
│  turn/start → prompt.submit  │                └──────────────────────────────────────┘
│  events → thread/delta       │
└──────────────────────────────┘
```

- Mapping:
  - One Hermes session lineage = one bb thread. `providerThreadId` = `<profile>:<lineage-root>`, so compression continuations collapse into a single thread.
  - New chats from bb: `session.create{profile, model}`, then `prompt.submit` (queued by default), streamed as deltas.
  - Interrupt, steer, approvals, clarify, title and archive map 1:1 onto bridge methods.
- Import:
  - The sync service spawns a thread with an agent-only marker input plus pluginMetadata naming the session.
  - The bridge binds to the session and emits its history inside a bridge-opened turn, without prompting Hermes.
- External activity (Discord, cron, Conduit): the feed wakes the thread; the bridge resumes as a viewer and mirrors the turn live. The home-page progress indicator, unread state and notifications come for free.
- Bots: one pinned thread per bot, in a "Bots" section, bound to that profile's canonical `Bot Chat`. It is the same conversation Conduit and Desktop show.
- Profiles:
  - A `profile` session option for new chats; a "Profile default" model entry uses the profile's configured model.
  - Profile locked after the first message (sessions live in per-profile databases).
- Entry point: our own "New Hermes chat" UI with no machine picker. If possible, hide the provider from the standard picker (`experimental_visibility`, to verify).
- Companion Hermes plugin (Python, small): a pass-through relay to the canonical gateway, a change feed, and a health/capabilities endpoint. All protocol logic lives in the TypeScript bridge.
- Repo: bb plugin at the root; Hermes plugin in `hermes-plugin/bb_bridge/`.

## Alternatives considered

| Option | Pros | Cons |
|---|---|---|
| **A. Dashboard + companion relay (rec.)** | Connects through the dashboard as asked; works wherever Hermes lives; full fidelity; Conduit uses the same pattern | Small Python plugin to maintain; token on $BB_SERVER_TS; depends on the dashboard and on `tailscale serve` (not managed by nix) |
| B. Bridge on $HERMES_HOST, direct to the gateway socket | No Hermes-side code; no network token; simplest | Only works on the machine Hermes runs on; bypasses the dashboard; moving Hermes means rework. The bridge code is the same as A, only the connector differs |
| C. Dashboard only (legacy `/api/ws`) | No Hermes code | A second dispatcher writing sessions; no live view of Discord/cron turns |
| D. Extend ACP | bb already ships it | Only sessions bb created; replayed history isn't rendered; one process per profile; machine picker stays |

## Feasibility gates (spikes before building)

- S1 bb import: a plugin-spawned thread renders existing Hermes history (user, assistant, tools) without prompting Hermes. The marker input stays invisible, and the thread resumes after a bb restart.
- S2 bb mirror: the server wakes an idle thread; the bridge mirrors an external turn live; the progress indicator shows; no stray user message appears.
- S3 bb UX: the provider stays out of the standard picker (or is harmless there); our UI spawns threads on a fixed host and environment; the follow-up composer works with the profile option.
- S4 Hermes relay: through the companion plugin, resume a Discord, cron and Bot Chat session as a viewer and receive live events; send a queued prompt; round-trip an approval. Find out whether a viewer's reply is also posted to Discord.

## Known limitations (accepted unless the spikes say otherwise)

- Imported threads get bb timestamps from the moment they're imported. Mitigation: import oldest first, so the sidebar order matches Hermes.
- Each mirrored external turn counts as a bb turn, which counts against concurrency limits and triggers notifications. Mitigation: filter by source and set notification levels per thread.
- Per-bot icons aren't possible: icons are per provider. Use thread sections, titles, and optionally the experimental row-metadata slot.

# Pictures: proposed v1

**Interactive version:** [andrewbird81.github.io/bb-plugin-hermes](https://andrewbird81.github.io/bb-plugin-hermes/) has all 8 diagrams on one page, with detail cards. Tap any picture below to open its own interactive page.

These pictures show the proposed lean v1 from [`../plan/scope-reset.md`](../plan/scope-reset.md).
- Everything is proposed: the scope awaits the owner's OK (Q22–Q25).
- Bot names are examples.
- TBD marks items left for the plan rewrite.

Each chat with an enabled Hermes bot becomes a bb thread. bb sends through the Hermes gateway's queue, so bb and Conduit share one conversation.

## What runs where?

[![The bb app talks to the bb server, which hosts the plugin's server part. On the Hermes machine, a plugin bridge per chat and one host worker each connect to the Hermes gateway, which runs the bots and saves chats](architecture.svg)](https://andrewbird81.github.io/bb-plugin-hermes/architecture.html)

- The plugin has three parts: a server part on the bb server, and on the Hermes machine a host worker plus one bridge per open chat.
- The worker and each bridge have their own connection to the gateway. The bb server never touches Hermes files.

## How do the other Hermes apps connect?

[![Conduit on the iPhone reaches Hermes through the dashboard. Desktop talks to the gateway; CLI and TUI write saved chats](other-apps.svg)](https://andrewbird81.github.io/bb-plugin-hermes/other-apps.html)

- Conduit reaches Hermes through the dashboard. The dashboard runs Conduit's turn itself, or hands it to the gateway queue when the chat is busy.
- Desktop on the Hermes machine talks to the gateway directly. CLI and TUI chats land in saved chats.

## What happens in a chat from bb?

[![You send from bb; the bridge puts the message in the gateway queue; the bot runs it and the reply streams to bb. An approval or question shows as a card and a push; your answer continues the turn](chat-from-bb.svg)](https://andrewbird81.github.io/bb-plugin-hermes/chat-from-bb.html)

- You pick a bot, a model and a reasoning level. The bot stays fixed for the whole chat.
- Approvals and questions show as a card in bb and send a push. bb never approves for you.

## How does Stop work?

[![Tapping Stop in bb stops the running or queued turn, and bb shows it stopped. A turn Conduit runs itself can't be stopped from bb](chat-stop.svg)](https://andrewbird81.github.io/bb-plugin-hermes/chat-stop.html)

- Stop works on bb's own turns, and on Conduit messages the dashboard hands to the gateway queue.
- A turn Conduit runs itself can't be stopped from bb.

## How do bb and Conduit share one Bot Chat?

[![bb and Conduit both send into the same Bot Chat: bb through the gateway queue, Conduit through the dashboard. bb's turns stream live; Conduit's own turns show in bb once saved](shared-bot-chat.svg)](https://andrewbird81.github.io/bb-plugin-hermes/shared-bot-chat.html)

- The bot's pinned bb thread is its Bot Chat, found by title each time. Nothing forks or gets copied.
- Conduit's own turns show in bb in two steps: your message at once, the reply when the turn ends.

## What if Conduit holds the chat?

[![bb's send is refused while Conduit holds the chat; bb waits with a banner and retries; once Conduit lets go, the gateway adopts the chat and runs the turn](shared-wait.svg)](https://andrewbird81.github.io/bb-plugin-hermes/shared-wait.html)

- bb shows "Open in Conduit: sends when it's free" and retries. It never creates a second chat.

## Which outside chats show up in bb?

[![Chats from CLI, TUI, Desktop and Conduit are saved by Hermes; the plugin imports the last 30 days once and mirrors new activity into bb threads, marked unread. Discord and cron or one-shot runs stay out](outside-sessions.svg)](https://andrewbird81.github.io/bb-plugin-hermes/outside-sessions.html)

- In: every chat of an enabled bot from CLI, TUI, Desktop and Conduit. The last 30 days are imported once.
- Out: cron and one-shot runs. Discord and other chat apps are proposed out (Q23).

## What does the per-bot switch do?

[![The bot switch in the plugin settings makes the host worker write a bb skill into that bot's profile; the skill calls one bb-hermes wrapper, which runs bb](bot-switch.svg)](https://andrewbird81.github.io/bb-plugin-hermes/bot-switch.html)

- On: chat in bb, mirroring, and full access to bb. The bot's bb skill calls one `bb-hermes` wrapper on the Hermes machine.
- Off: the bot is absent from bb, and the worker deletes its skill. Every bot starts off (proposed).

## Still open

These are for the plan rewrite:
- How v1 reads Hermes history, for the 30-day import and for Conduit's turns. D40 predates full mirroring.
- When the 30-day import runs for a bot switched on later.
- What happens to a bot's bb threads when the bot is switched off.

Questions Q22–Q25 are in [`scope-reset.md`](../plan/scope-reset.md#pending-user-answers).

## Files

- **`*.svg`:** the pictures above. They follow the reader's light or dark theme.
- **`*.html`:** interactive versions with detail cards.
  - `overview.html` has all of them on one page.
  - Hosted at [andrewbird81.github.io/bb-plugin-hermes](https://andrewbird81.github.io/bb-plugin-hermes/). `.github/workflows/pages.yml` publishes this folder on every push to `main`.
- **Sources:** each diagram's `.json` file, and `overview.archify.md` for the overview page.
- **To change a picture:**
  1. Edit its `.json`.
  2. Re-render it with Archify (`finalize architecture <name>.json <name>.html`).
  3. Export the SVG again from the HTML (Export → SVG · Auto).

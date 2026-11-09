# Pictures: v1

**Interactive version:** [andrewbird81.github.io/bb-plugin-hermes](https://andrewbird81.github.io/bb-plugin-hermes/) has all 8 diagrams on one page, with detail cards. Tap any picture below to open its own interactive page.

These pictures show the v1 plan in [`../plan/README.md`](../plan/README.md), `01-product.md` and `02-architecture.md`. Where they disagree, the plan wins. Bot names are examples.

Each chat with an enabled Hermes bot becomes a bb thread. bb sends through the Hermes gateway's queue, so bb and Conduit share one conversation.

## What runs where?

[![The bb app talks to the bb server, which hosts the plugin's server part. On the Hermes machine, a plugin bridge per chat and one host worker each connect to the Hermes gateway, which runs the bots and saves chats; the worker reads history through the gateway's REST projection](architecture.svg)](https://andrewbird81.github.io/bb-plugin-hermes/architecture.html)

- The plugin has three parts: a server part on the bb server, and on the Hermes machine a host worker plus one bridge per open chat ([02 §Components](../plan/02-architecture.md#components)).
- The worker and each bridge have their own connection to the gateway. History reads go through Hermes' REST projection ([02 §History reader](../plan/02-architecture.md#history-reader)).

## How do the other Hermes apps connect?

[![Conduit on the iPhone reaches Hermes through the dashboard, which runs and saves its turns or hands them to the gateway when the chat is busy. Desktop, CLI and TUI send to the gateway, which saves every turn it runs](other-apps.svg)](https://andrewbird81.github.io/bb-plugin-hermes/other-apps.html)

- Conduit reaches Hermes through the dashboard. The dashboard runs Conduit's turn itself, or hands it to the gateway queue when the chat is busy.
- Desktop, CLI and TUI run every turn in the gateway ([confirm item 3](../plan/README.md#for-the-owner-to-confirm)).

## What happens in a chat from bb?

[![You send from bb; the bridge puts the message in the gateway queue; the bot runs it and the reply streams to bb. An approval or question shows as a card and a push; your answer continues the turn](chat-from-bb.svg)](https://andrewbird81.github.io/bb-plugin-hermes/chat-from-bb.html)

- You pick a bot, a model and a reasoning level. The bot stays fixed for the whole chat ([01 §4](../plan/01-product.md#4-chat-from-bb-p1)).
- Approvals and questions show as a card in bb and send a push. bb never approves for you.

## How does Stop work?

[![Tapping Stop in bb stops bb's own turn or a forwarded Conduit turn, and bb shows it stopped. Other outside turns keep running, with a "Running outside bb" banner, and their reply shows when they end](chat-stop.svg)](https://andrewbird81.github.io/bb-plugin-hermes/chat-stop.html)

- Stop works on bb's own turns, and on Conduit messages the dashboard hands to the gateway queue ([01 §5](../plan/01-product.md#5-stop-p1)).
- Other outside turns keep running; bb shows "Running outside bb", and the reply still appears when the turn ends.

## How do bb and Conduit share one Bot Chat?

[![bb and Conduit both send into the same Bot Chat: bb through the gateway queue, Conduit through the dashboard. bb's turns stream live; Conduit's own turns show in bb once saved, read through REST](shared-bot-chat.svg)](https://andrewbird81.github.io/bb-plugin-hermes/shared-bot-chat.html)

- The bot's pinned bb thread is its Bot Chat, found by title each time. Nothing forks or gets copied ([01 §6](../plan/01-product.md#6-the-bot-chat-shared-with-conduit-p1)).
- Conduit's own turns show in bb in two steps: your message at once, the reply when the turn ends.
- Two rare Hermes race bugs are accepted and not filed upstream (D50).

## What if Conduit holds the chat?

[![bb's send is refused while Conduit holds the chat; bb waits with a banner and retries; once Conduit lets go, the gateway adopts the chat and runs the turn](shared-wait.svg)](https://andrewbird81.github.io/bb-plugin-hermes/shared-wait.html)

- bb shows "Open in another Hermes app: sends when it's free" and retries. It never creates a second chat ([02 flow 3](../plan/02-architecture.md#flows)).

## Which outside chats show up in bb?

[![Chats from CLI, TUI, Desktop and Conduit are saved in Hermes; the plugin reads them through REST, keeps an allow-list, imports the last 30 days at each switch-on and mirrors new activity into bb threads, marked unread. Discord and other chat apps, cron and one-shot runs stay out](outside-sessions.svg)](https://andrewbird81.github.io/bb-plugin-hermes/outside-sessions.html)

- In: every visible chat of an enabled bot from CLI, TUI, Desktop and Conduit, plus its Bot Chat. Each switch-on imports the last 30 days ([01 §7](../plan/01-product.md#7-mirroring-and-import-p1-for-bound-threads-p2-for-every-chat)).
- Out: cron, one-shot and other sources, and Discord and other chat apps, DMs included (D49).

## What does the per-bot switch do?

[![Switching a bot on writes its bb skill, refreshes its prompts, brings back its threads and imports the last 30 days; the switch row shows the count first. Switching off archives its threads, deletes the skill and refreshes the prompts](bot-switch.svg)](https://andrewbird81.github.io/bb-plugin-hermes/bot-switch.html)

- On: chat in bb, mirroring, and full access to bb. The bot's bb skill calls one `bb-hermes` wrapper on the Hermes machine. The switch row shows the import count first ([01 §2](../plan/01-product.md#2-bot-switches-p1-import-p2)).
- Off: every thread of the bot is archived (D48), and the worker deletes its skill. After writing or deleting the skill, the worker refreshes the bot's prompts. Every bot starts off.

## Settled by the plan

The plan settles what earlier pictures left open; each item is reversible ([For the owner to confirm](../plan/README.md#for-the-owner-to-confirm)):
- The import runs at every switch-on, and the switch row shows its count.
- CLI and TUI run every turn in the gateway; only Conduit's own turns are saved outside it.
- History comes from Hermes' REST projection.
- After the skill is written or deleted, the worker refreshes that bot's prompts.

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

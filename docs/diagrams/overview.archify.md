# How the bb-plugin-hermes v1 works {#hermes-v1}

Each chat with an enabled Hermes bot becomes a **bb thread**. bb sends through the Hermes gateway's queue, so bb and Conduit share one conversation.

- A plugin bridge on the Hermes machine carries each bb chat to the gateway; replies stream back live.[](source:arch)
- bb and Conduit add turns to the same Bot Chat; bb waits instead of forking when Conduit holds it.[](source:shared)
- Chats started in CLI, TUI, Desktop or Conduit appear in bb by themselves.[](source:mirror)
- One switch per bot turns all of this on, including the bot's access to bb.[](source:switch)

@answer scope="The v1 plan for any Hermes user. Bot names are examples."
@meta locale=en quality_profile=showcase repo_url=https://github.com/AndrewBird81/bb-plugin-hermes repo_revision=a035e4cc67d1d611bb28f9bba4256cfb0b822cfa
@source scope title="Plan: v1 scope" path=docs/plan/README.md lines=19:28
@source arch title="02 Architecture: components" path=docs/plan/02-architecture.md lines=5:12
@source reader title="02 Architecture: history reader" path=docs/plan/02-architecture.md lines=27:36
@source cli title="Plan: how CLI and TUI save chats" path=docs/plan/README.md lines=132:132
@source chat title="01 Product: chat from bb" path=docs/plan/01-product.md lines=62:78
@source stop title="01 Product: Stop" path=docs/plan/01-product.md lines=89:99
@source shared title="01 Product: the Bot Chat shared with Conduit" path=docs/plan/01-product.md lines=103:118
@source mirror title="01 Product: mirroring and import" path=docs/plan/01-product.md lines=125:146
@source switch title="01 Product: bot switches" path=docs/plan/01-product.md lines=18:34
@source confirm title="Plan: for the owner to confirm" path=docs/plan/README.md lines=127:137

## What runs where? {#big-picture span=4}

@diagram architecture id=arch source=architecture.json

- The plugin has three parts: a server part on the bb server, and a host worker plus one bridge per open chat on the Hermes machine.[](source:arch)
- The worker and each bridge have their own connection to the gateway. History reads go through Hermes' REST projection.[](source:reader)

## How do the other Hermes apps connect? {#other-apps span=4}

@diagram architecture id=apps source=other-apps.json

- Conduit reaches Hermes through the dashboard. The dashboard runs Conduit's turn itself, or hands it to the gateway queue when the chat is busy.
- Desktop, CLI and TUI run every turn in the gateway.[](source:cli)

## What happens in a chat from bb? {#chat span=4}

@diagram architecture id=chat-flow source=chat-from-bb.json

- You pick a bot, a model and a reasoning level. The bot stays fixed for the whole chat.[](source:chat)
- Approvals and questions show as a card in bb and send a push. bb never approves for you.

## How does Stop work? {#stop span=4}

@diagram architecture id=stop-flow source=chat-stop.json

- Stop works on bb's own turns and on Conduit messages handed to the gateway queue.[](source:stop)
- Other outside turns keep running; bb shows "Running in `<app>`".

## How do bb and Conduit share one Bot Chat? {#shared span=4}

@diagram architecture id=shared-flow source=shared-bot-chat.json

- The bot's pinned bb thread is its Bot Chat, found by title each time. Nothing forks or gets copied.[](source:shared)
- Conduit's own turns show in bb in two steps: your message at once, the reply when the turn ends.

## What if Conduit holds the chat? {#wait span=4}

@diagram architecture id=wait-flow source=shared-wait.json

- bb shows "Open in Conduit: sends when it's free" and retries. It never creates a second chat.[](source:shared)

## Which outside chats show up in bb? {#mirroring span=4}

@diagram architecture id=mirror-flow source=outside-sessions.json

- In: every visible chat of an enabled bot from CLI, TUI, Desktop and Conduit. Each switch-on imports the last 30 days.[](source:mirror)
- Out: cron, one-shot and other sources, and Discord and other chat apps.

## What does the per-bot switch do? {#switch span=4}

@diagram architecture id=switch-map source=bot-switch.json

- On: chat in bb, mirroring, and full access to bb through the bot's bb skill. The row shows the import count first.[](source:switch)
- Off: the bot's threads are archived and its skill deleted. Every bot starts off.

## What did the plan settle? {#settled span=4}

These are settled and reversible.[](source:confirm)

- The import runs at every switch-on, and the switch row shows its count.
- CLI and TUI run every turn in the gateway; only Conduit's own turns are saved outside it.
- History comes from Hermes' REST projection.
- After the skill is written or deleted, the worker refreshes that bot's prompts.
- The two rare Hermes race bugs are accepted and not filed upstream (D50).

# How the proposed bb-plugin-hermes v1 works {#hermes-v1}

Each chat with an enabled Hermes bot becomes a **bb thread**. bb sends through the Hermes gateway's queue, so bb and Conduit share one conversation.

- A plugin bridge on the Hermes machine carries each bb chat to the gateway; replies stream back live.[](source:scope)
- bb and Conduit add turns to the same Bot Chat; bb waits instead of forking when Conduit holds it.[](source:s8)
- Chats started in CLI, TUI, Desktop or Conduit appear in bb by themselves.[](source:scope)
- One switch per bot turns all of this on, including the bot's access to bb.[](source:readme)

@answer scope="Proposed v1 for any Hermes user, awaiting the owner's OK (Q22). Bot names are examples. Open items are marked TBD."
@meta locale=en quality_profile=showcase
@source scope title="Scope reset: proposed v1" path=docs/plan/scope-reset.md lines=29:49
@source rules title="Scope reset: shared-conversation rules" path=docs/plan/scope-reset.md lines=85:105
@source s8 title="S8: Conduit and bb sharing one conversation" path=docs/spikes/S8-conduit-shared-conversation.md lines=92:130
@source s8access title="S8: per-profile bb access, option 1" path=docs/spikes/S8-conduit-shared-conversation.md lines=208:213
@source arch title="02 Architecture: placement" path=docs/plan/02-architecture.md lines=24:27
@source defaults title="Scope reset: per-bot switch defaults" path=docs/plan/scope-reset.md lines=79:82
@source readme title="Decisions D40–D46" path=docs/plan/README.md lines=81:87

## What runs where? {#big-picture span=4}

@diagram architecture id=arch source=architecture.json

- The plugin has three parts: a server part on the bb server, and a host worker plus one bridge per open chat on the Hermes machine.
- The worker and each bridge have their own connection to the gateway. The bb server never touches Hermes files.[](source:arch)

## How do the other Hermes apps connect? {#other-apps span=4}

@diagram architecture id=apps source=other-apps.json

- Conduit reaches Hermes through the dashboard. The dashboard runs Conduit's turn itself, or hands it to the gateway queue when the chat is busy.[](source:s8)
- Desktop on the Hermes machine talks to the gateway directly; CLI and TUI chats land in saved chats.

## What happens in a chat from bb? {#chat span=4}

@diagram architecture id=chat-flow source=chat-from-bb.json

- You pick a bot, a model and a reasoning level. The bot stays fixed for the whole chat.[](source:scope)
- Approvals and questions show as a card in bb and send a push. bb never approves for you.

## How does Stop work? {#stop span=4}

@diagram architecture id=stop-flow source=chat-stop.json

- Stop works on bb's own turns and on Conduit messages handed to the gateway queue.[](source:rules)

## How do bb and Conduit share one Bot Chat? {#shared span=4}

@diagram architecture id=shared-flow source=shared-bot-chat.json

- The bot's pinned bb thread is its Bot Chat, found by title each time. Nothing forks or gets copied.[](source:rules)
- Conduit's own turns show in bb in two steps: your message at once, the reply when the turn ends.[](source:s8)

## What if Conduit holds the chat? {#wait span=4}

@diagram architecture id=wait-flow source=shared-wait.json

- bb shows "Open in Conduit: sends when it's free" and retries. It never creates a second chat.[](source:rules)

## Which outside chats show up in bb? {#mirroring span=4}

@diagram architecture id=mirror-flow source=outside-sessions.json

- In: every chat of an enabled bot from CLI, TUI, Desktop and Conduit. The last 30 days are imported once.[](source:scope)
- Out: cron and one-shot runs. Discord and other chat apps are proposed out (Q23).[](source:scope)

## What does the per-bot switch do? {#switch span=4}

@diagram architecture id=switch-map source=bot-switch.json

- On: chat in bb, mirroring, and full access to bb. The bot's bb skill calls one bb-hermes wrapper on the Hermes machine.[](source:s8access)
- Off: the bot is absent from bb, and the worker deletes its skill. Every bot starts off (proposed).[](source:defaults)

## What is still open? {#open span=4}

@callout level=open-question title="To be decided in the plan rewrite"
How v1 reads Hermes history for the 30-day import and for Conduit's turns. D40 predates full mirroring.
When the 30-day import runs for a bot switched on later, and what happens to a bot's bb threads when it is switched off.

| Question | Proposed answer |
| --- | --- |
| Q22: v1 scope, defaults | Accept {caution:Pending} |
| Q23: Discord, chat apps | Mirror none of them {caution:Pending} |
| Q24: compaction setting | Leave it in v1 {caution:Pending} |
| Q25: file race bugs upstream | Only with the owner's OK {caution:Pending} |

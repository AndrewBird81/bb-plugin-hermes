# Hermes in bb: user guide

Chat with your Hermes bots in bb, and see their Hermes chats as bb threads that keep updating.

## Requirements

- A bb host (the bb desktop app or `npx bb-app`) running on the machine that runs Hermes.
- Hermes with its multiplexed gateway running (Hermes' default). The plugin never starts, stops or restarts it.
- The Hermes folder: `~/.hermes` unless you installed Hermes elsewhere.

## Install, connect, update

1. `bb plugin install git:github.com/AndrewBird81/bb-plugin-hermes@^1 --yes` (a version range: a tag would pin it).
2. Settings → Plugins → Hermes: pick the **Hermes machine**. Change the **Hermes folder** only for an unusual install. The health line turns "connected, supported" within a minute.
3. To update: `bb plugin update hermes`, then `bb plugin rpc call hermes stopHosted`, so running bot processes restart on the new build.

## Bot switches

Each bot (Hermes profile) has one switch. Every bot starts off; off means absent from bb.

Switching a bot **on**:
- lets you chat with it in bb;
- shows its Hermes chats in bb (below);
- **gives it full access to bb**: a skill in the profile lets it read, start, message, stop and archive any bb thread on any machine. Hermes doesn't ask before running bb commands, so anything that can steer the bot, a prompt injection included, can act in bb. Restrictions come later.

Switching it **off** archives its bb threads, removes the skill, and stops watching its chats. Switching it on again brings the same threads back with what happened meanwhile.

## What you see

- **Bot thread:** pinned, titled with the bot's name. It is the bot's Bot Chat, shared with Hermes' other apps (Desktop, Conduit).
- **Side chats:** bb's New Thread on the Hermes machine: pick Hermes, then the bot in the Bot chip. Or `bb thread spawn --project proj_personal --provider hermes --option profile=<bot>` on the Hermes machine.
  - In a project (Project checkout), the bot works in the project's folder; with "No project", in its own working folder (`terminal.cwd`).
- **Mirrored chats:** every CLI, TUI, Desktop and Conduit chat of a bot that is on. Cron, one-shot, ACP, API-server, Discord and other chat-app sessions stay in Hermes.
  - At switch-on, chats active in the last 30 days are imported, read and silently. Older turns of a long chat stay in Hermes, with a note at the top. The switch row says how many before you turn it on.
  - Chats started later appear as new threads, unread.
  - Outside messages read `[Outside bb] …` (imported: `[Outside bb · Oct 12] …`). bb never names the app: Hermes doesn't record which app sent a turn.
  - Replying from bb continues the same Hermes chat. A Conduit chat Hermes' gateway doesn't own yet is taken over by the gateway at your first bb send; Conduit keeps working.
  - Titles follow Hermes until you rename the thread in bb. Pins, archives and renames in bb stay in bb.
  - A thread deleted in bb is never imported again. A chat deleted in Hermes keeps its thread; sends to it fail "Deleted in Hermes".
  - A thread you archived stays archived when its chat changes in Hermes (bb takes no message into an archived thread); what happened meanwhile comes in when you unarchive it.
- **Notifications:** outside activity marks a thread unread without a push; approvals and questions push.

## Privacy

Mirrored threads copy Hermes transcripts, tool results included, into the bb server's store. Turn a bot on only if that is fine for its chats.

## Rollback

- **Kill switch:** switch every bot off first (removes the skills, archives the threads), then `bb plugin disable hermes`. Disabling alone leaves the skills in the profiles.
- **Manual skill removal** (if the plugin is gone): delete `<profile>/skills/bb-plugin-hermes/` (only when it holds `.bb-plugin-hermes.json`) and the plugin's `bin/bb-hermes`, then run `hermes -p <profile> sessions refresh-prompts`.
- **No downgrade in place:** install a newer fixed version instead.
- Never `bb plugin remove hermes` without first copying the plugin's `data.db`: its bindings tie threads to Hermes chats, and a fresh import would duplicate them.
- Everything bb sent stays in Hermes; chats the gateway took over from Conduit stay taken over (harmless).

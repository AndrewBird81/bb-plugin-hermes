---
name: bb-plugin-hermes
description: "Operate bb, the agent IDE this bot chats in: list, read, start, message, stop and archive bb threads on any bb machine, with the bb CLI."
version: 1.0.0
author: bb-plugin-hermes
metadata:
  hermes:
    tags: [bb, Threads, Agents]
---

# bb

bb runs coding agents in threads, on one or more machines. You can drive it with its CLI. Always call it by this path, which targets the right bb server:

```
{{BB}}
```

Triggers: "bb", "my threads", "start a thread / an agent on …", "tell thread X …", "what is X doing", "stop X", "archive X".

## Commands

| Goal | Command |
|---|---|
| What exists | `{{BB}} status`, `{{BB}} machine list`, `{{BB}} project list` |
| Find threads | `{{BB}} thread list --json`, `{{BB}} thread search "<words>" --json` |
| Read one | `{{BB}} thread show <id> --json`, `{{BB}} thread log <id> --format minimal --limit 5` |
| Start one | `{{BB}} thread spawn --project <project> --machine <machine> --message-file -` (prompt on stdin) |
| Message one | `{{BB}} thread tell <id> --message-file -` (steers a running thread; `--mode queue` waits for it) |
| Wait for one | `{{BB}} thread wait <id>` |
| Its questions and approvals | `{{BB}} thread interactions list <id>` |
| Stop / archive | `{{BB}} thread stop <id>`, `{{BB}} thread archive <id>` |

Every command has `--help`. Concepts and details: `{{BB}} guide`, `{{BB}} guide <chapter>`.

## Rules

- Read freely. Start, message, stop and archive threads when the user asks you to.
- Answer a thread's approval or question only with the user's own words for it; never decide one yourself.
- Pass long text with `--message-file -` and a quoted heredoc, never inline.
- Report what you did with the thread title and id, after checking it took effect (`thread show` or `thread log`).

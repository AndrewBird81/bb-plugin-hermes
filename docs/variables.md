# Variables for personal values

The docs never hold the owner's personal values. Each one is written as a variable below, the same way everywhere, including old commits.

- Real values: `~/.config/bb-plugin-hermes/private.env` (`KEY=value`, mode 600, outside the repo, never committed).
- Home paths are written `~/…`. In prose the owner is "the owner".
- Times of day of the owner's activity are dropped or coarsened (dates, durations and config timings stay). Commit dates are UTC.
- Guard: `node scripts/check-private.mjs` fails if a tracked file holds a value from `private.env` or a generic pattern (tailnet IP, `*.ts.net` name, `/Users/<name>/` path, non-noreply email, Hermes session id).

## Machines and tailnet

| Variable | Meaning |
|---|---|
| `$HERMES_HOST` | Machine name of the owner's personal Mac that runs Hermes (and a bb host daemon) |
| `$HERMES_HOST_TS` | Tailnet device name of `$HERMES_HOST` |
| `$WORK_HOST` | Machine name of the owner's work Mac, a bb host without Hermes |
| `$BB_SERVER_HOST` | bb machine name of the always-on bb server |
| `$BB_SERVER_TS` | Tailnet device name of the bb server |
| `$TAILNET` | The tailnet's MagicDNS domain |
| `$TAILNET_SLUG` | `$TAILNET` with dots as dashes, as bb writes it in file names |
| `$PHONE_TS` | Tailnet device name of the owner's iPhone |
| `$OTHER_MAC_TS` | Tailnet device name of a Mac seen in the Hermes dashboard logs |
| `$K8S_RUNNER_TS` | Tailnet device name of the off-box k8s runner. Not guarded: the value is also a public product name |
| `$PHONE_IP`, `$OTHER_MAC_IP`, `$BB_SERVER_IP` | Tailnet IPs of those devices |
| `$HERMES_DISCORD_BOT`, `$NEO_DISCORD_BOT` | Discord account names of the default and neo profiles' bots |

## Identity and work

| Variable | Meaning |
|---|---|
| `$OWNER_NAME` | The owner's first name, where a message label shows it (e.g. the Discord echo) |
| `$LOCAL_USER` | The owner's macOS user name, where it isn't part of a home path |
| `$WORK_MODEL_RULE` | A work-only rule quoted from the owner's agent config |
| `$OBSIDIAN_VAULT` | Folder name of the owner's Obsidian vault (alex's working directory) |

## Ids

| Variable | Meaning |
|---|---|
| `$HERMES_SESSION_01` … `$HERMES_SESSION_38` | Real Hermes session ids (`YYYYMMDD_HHMMSS_hex`) |
| `$HERMES_SESSION_FAKE` | The canned session id of the S1–S3 fake Hermes |
| `$BB_THREAD_01` … `$BB_THREAD_30` | bb thread ids (`thr_…`) |
| `$BB_HOST_1`, `$BB_HOST_2` | bb host ids (`host_…`) |

## Guard-only

`private.env` also holds values that never appear in the repo, so no variable stands in for them: `OTHER_DEVICE_TS`, `OWNER_EMAIL`, `WORK_LOCAL_USER`, `EMPLOYER`, `EMPLOYER_DOMAIN`, `WORK_CLAUDE_PROVIDER`, `K8S_HARDWARE`.

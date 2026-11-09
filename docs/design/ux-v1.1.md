# UX v1.1 — native New Thread, Settings, bot chip

2026-11-09, bb-app 0.49.0, SDK 0.6.132. Design only. **Source** = read in bb's shipped code; **INFERRED** = not run.

## 1. Settings page

Today each bot row repeats the 50-word grant text, and "The bb machine that runs Hermes." shows twice (section description and field hint).

**Recommended:** say the grant once, in a warning card above the rows; each row holds only what differs. Switch on the right, like bb's own settings. One column, so it fits a 390 px phone.

```
Connection
The bb machine that runs Hermes, and how the plugin reaches it.
 Hermes machine
 [ $HERMES_HOST                       v ]   [Save]       <- Save wraps below on a phone
 ● Connected to Hermes 0.22.0 on $HERMES_HOST: supported.
   Worker last seen 1/2/2026, 9:30 AM.

Bots
Chat with a bot in bb and see its Hermes chats as threads. Every bot starts off.
 ┌ ⚠ A bot that's on can operate bb ────────────────────┐
 │ It can read, start, message, stop and archive any bb │
 │ thread on any machine. Hermes doesn't ask before     │
 │ running bb commands. Restrictions come later.        │
 └──────────────────────────────────────────────────────┘
 Hermes                                          [ ●]
 Alex                                            [○ ]
   Imports 3 chats from the last 30 days.
 Bob                                             [○ ] (disabled)
   Not served by this machine's gateway.
```

- Card: bb's warning tone, always shown (bots off too). Title `A bot that's on can operate bb`; body `It can read, start, message, stop and archive any bb thread on any machine. Hermes doesn't ask before running bb commands. Restrictions come later.`
- Section description: `Chat with a bot in bb and see its Hermes chats as threads. Every bot starts off.`
- Row second line, by state (at most one):
  - off, served, count > 0: `Imports 3 chats from the last 30 days.` (`Imports 1 chat …`); count 0 or unknown: none.
  - unserved: `Not served by this machine's gateway.` Switch disabled unless on.
  - on: none. Error: the error, in red.
- Connection: drop the hint `The bb machine that runs Hermes.` (the description says it). Worker time without seconds.
- Avatar: **none** in v1.1. The worker doesn't fetch avatars, and the chip can't show them (§3), so they'd appear only here. Alternatives: Desktop-style letter glyph (no data needed); the real avatar (`profiles.get_asset`).

## 2. New Thread on a machine without Hermes

bb's native model (root-compose `mn`, source): a card titled `Pi not installed`, description `Install Pi before starting a thread.`, button `Install Pi`. bb also passes `blocker: {message, reason: "agent_missing"}`, which disables Send. **Plugins can't set a blocker:** `ComposerCustomization` has `banners` (`chrome: "card" | "bare"`) but no blocker. Ours copies the card, not the block.

**Option A — listed on every machine (recommended).** The Hermes tab shows everywhere; on $WORK_HOST:

```
 ┌──────────────────────────────────────────────────────────┐
 │ Hermes isn't on $WORK_HOST             [Use $HERMES_HOST] │
 │ Switch to $HERMES_HOST to start a Hermes thread.          │
 ├──────────────────────────────────────────────────────────┤
 │ Ask anything.                                            │
 │ +  ⟡ The bot's model v                           mic [↑] │
 └──────────────────────────────────────────────────────────┘
   No project v   $WORK_HOST v                 (no bot chip)
```

- Banner (new-thread scope, `chrome: "card"`): title `Hermes isn't on <machine>`; description `Switch to <Hermes machine> to start a Hermes thread.`; button `Use <Hermes machine>` → `setSelection` to that machine.
- Several Hermes machines later: description `Switch to a machine with Hermes to start a Hermes thread.`, one `Use <machine>` button each (at most 2, most recent first).
- Precedence, one banner at a time: not connected (`Hermes isn't connected` / `Pick the Hermes machine in Settings → Plugins → Hermes [Experimental].`, no button) > wrong machine > no bot on (§3).
- **One-time switch:** when the provider changes to Hermes and the machine has no Hermes, switch once to the Hermes machine. Never at page load (it raced the draft restore, research 13 §5); a restored draft shows the banner instead. A manual move back is respected. After the switch, a bare line until the next change or send: `Moved to $HERMES_HOST, where Hermes runs.`
- **What blocks sending:** only the dispatch refusal. Send stays enabled; submit shows bb's toast and keeps the draft (VERIFIED, research 13).
- Projects: the switch keeps the project; if it has no checkout on $HERMES_HOST, bb's own machine-setup prompt takes over (INFERRED).

**Option B — listed only on Hermes machines.** On $WORK_HOST there is no Hermes tab, so nothing to hang a banner on; the user must know to switch machines first. No auto-switch possible. The desktop sidebar loses the row icon (it reads the primary machine). Refusal text then matters only for the CLI and handoffs.

**Refusal** (replaces ``Hermes runs on <machine>: add `--machine <machine>`.``). No backticks: the toast prints them literally (`13-refused-other-machine.png`). The hook's `context.host.name` gives this machine.

- `Hermes isn't on <this machine>. Start the thread on <Hermes machine> (--machine <Hermes machine>).`
- Toast: `Failed to create thread` · `Blocked by the "hermes" plugin: Hermes isn't on $WORK_HOST. Start the thread on $HERMES_HOST (--machine $HERMES_HOST).`
- CLI: `dispatch_rejected: Hermes isn't on $WORK_HOST. Start the thread on $HERMES_HOST (--machine $HERMES_HOST).`
- Unknown name: `Hermes isn't on this machine. …`

## 3. The bot chip

Source (plugin-frontend `kv`, `jv`, `Mv`): a `category:"mode"` option goes to the footer chip; the chip shows only the **selected value's label**; the menu shows the option label (`Bot`) as a heading, then each value's `label` and `description` (a muted second line). Value schema: `id, label, description?, group?`; **no icon or avatar**, and `group` isn't drawn. Other categories go to the picker list (`kv`), not the footer, so `mode` stays.

```
 ⟡ Stub Medium v   No project v   $HERMES_HOST v    [Hermes bot v]
                                                     │ Bot               │
                                                     │ Hermes bot      ✓ │
                                                     │   Default profile │
                                                     │ Alex              │
                                                     │ Bob               │
```

- **`default` label: `Hermes bot`** in the chip and menu only; other bots keep their name. Value description `Default profile` on it only. The sidebar ("Hermes · Hermes · Bot Chat") is untouched.
- Off bot: not listed (VERIFIED, research 13). **Unserved bot: not listed either** (values can't be disabled, and a send fails `profile_mismatch`). A remembered pick falls back to the default (VERIFIED, research 13).
- No bot on: no chip (the bridge answers only the placeholder). Banner: `No Hermes bot is on` / `Switch one on in Settings → Plugins → Hermes [Experimental].` No button: `useBbNavigate` has no settings route.

## 4. Without the rail panel

| Lost | Covered? |
|---|---|
| A list of the on bots, each opening its Bot Chat | Yes: pinned bot threads. Unpinned, it's in Threads by recency |
| Unread dot per bot | Yes: bb's own unread on the pinned row, phone included |
| One-click `New chat with <bot>` | Partly: New Thread → Hermes tab → chip, ~3 taps; the chip remembers the last bot |
| `No bot is on. Turn one on…` | Yes: §3 banner |
| A bot that's on but has no thread yet | No; rare (the switch makes one) |
| Hermes' own entry in the rail | Partly: the Hermes tab and, with A, the row icon |

**Recommended:** pinned threads cover it; add nothing.

## Questions for the owner

1. Listing: **(a) A, every machine, banner + switch** (recommended: the only option with a banner and a desktop icon); (b) B, Hermes machines only.
2. `default` chip label: **(a) `Hermes bot`** (recommended); (b) `Default`; (c) keep `Hermes`, add the description only.
3. Blocking Send: **(a) refusal toast as the block, and ask bb for a plugin `blocker` on new-thread banners** (recommended); (b) also `setInputLock(true)`: locks typing, and whether it disables Send is unverified; (c) refusal only, no banner.
4. Note after the automatic switch: **(a) show `Moved to <machine>, where Hermes runs.`** (recommended); (b) silent.
5. Bot avatars in Settings: **(a) none** (recommended); (b) letter glyph; (c) the real avatar.
6. Replacing `New chat with <bot>`: **(a) nothing** (recommended); (b) a `+` menu item `New chat with <bot>` in each bot thread.

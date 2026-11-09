// Settings section (01 §2, T1.12, ux-v1.1 §1): the grant once, in a warning card, then one switch per bot the
// worker describes, each with at most one line by state. Every bot starts off (D43).
import { useId, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { BOTS_CHANNEL, type BotRow, type RpcContract } from "../shared/rpc-contract.js";
import { errorText, useLive } from "./live.js";

export const GRANT_TITLE = "A bot that's on can operate bb";
export const GRANT_TEXT =
  "It can read, start, message, stop and archive any bb thread on any machine. Hermes doesn't ask before running bb commands. Restrictions come later.";

export const importText = (count: number) => `Imports ${count} ${count === 1 ? "chat" : "chats"} from the last 30 days.`;

export const UNSERVED_TEXT = "Not served by this machine's gateway.";

/** A row's one line: none when on, unserved, or what a switch-on would import (none for 0 or unknown). */
export function rowText(bot: BotRow): string | null {
  if (bot.enabled) return null;
  if (!bot.served) return UNSERVED_TEXT;
  return bot.import_count ? importText(bot.import_count) : null;
}

function BotSwitch({ bot, grantId, onChanged }: { bot: BotRow; grantId: string; onChanged: () => Promise<void> }) {
  const rpc = useRpc<RpcContract>();
  const id = useId();
  // The requested state until the refetched row shows it.
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = (on: boolean) => {
    setPending(on);
    setError(null);
    rpc
      .call("setBot", { profile_home: bot.profile_home, on })
      .then(onChanged, (cause: unknown) => setError(errorText(cause)))
      .finally(() => setPending(null));
  };

  const text = rowText(bot);
  return (
    <li className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="font-medium text-foreground">
          {bot.bot_label}
        </label>
        {error !== null ? (
          <p id={`${id}-text`} role="alert" className="text-destructive">
            {error}
          </p>
        ) : (
          text !== null && (
            <p id={`${id}-text`} className="text-muted-foreground">
              {text}
            </p>
          )
        )}
      </div>
      {/* bb's own switch (track and thumb), over a native checkbox. */}
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input
          id={id}
          type="checkbox"
          role="switch"
          aria-describedby={error !== null || text !== null ? `${grantId} ${id}-text` : grantId}
          className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
          checked={pending ?? bot.enabled}
          // An unserved bot can't turn on; one already on can still turn off.
          disabled={(!bot.served && !bot.enabled) || pending !== null}
          onChange={(event) => toggle(event.target.checked)}
        />
        <span
          aria-hidden="true"
          className="h-4 w-7 rounded-full border border-input bg-muted transition-colors peer-checked:border-transparent peer-checked:bg-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-50"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0.5 top-0.5 size-3 rounded-full bg-foreground transition-transform peer-checked:translate-x-3 peer-checked:bg-background peer-disabled:opacity-50"
        />
      </span>
    </li>
  );
}

export function BotSwitches() {
  const { value, error, refetch } = useLive("bots", BOTS_CHANNEL);
  const grantId = useId();
  return (
    <div className="flex flex-col gap-4 text-sm">
      <section id={grantId} aria-label={GRANT_TITLE} className="flex flex-col gap-1 rounded-lg border border-warning-text/30 bg-warning-text/5 p-3">
        <p className="flex items-center gap-2 font-medium text-warning-text">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4 shrink-0" aria-hidden="true">
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01" />
          </svg>
          {GRANT_TITLE}
        </p>
        <p className="text-foreground">{GRANT_TEXT}</p>
      </section>
      {value !== null && value.bots.length === 0 && <p className="text-muted-foreground">No bots yet: connect to Hermes above.</p>}
      {value !== null && value.bots.length > 0 && (
        <ul className="flex flex-col gap-4">
          {value.bots.map((bot) => (
            <BotSwitch key={bot.profile_home} bot={bot} grantId={grantId} onChanged={refetch} />
          ))}
        </ul>
      )}
      {value === null && error === null && <p className="text-muted-foreground">Loading bots…</p>}
      {error !== null && <p className="text-destructive">Can't list bots: {error}</p>}
    </div>
  );
}

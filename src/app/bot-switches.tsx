// Settings section (01 §2, T1.12): one switch per bot the worker describes. Every bot starts off (D43).
import { useId, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { BOTS_CHANNEL, type BotRow, type RpcContract } from "../shared/rpc-contract.js";
import { errorText, useLive } from "./live.js";

/** The `default` bot shows as "Hermes": "see its chats", never "Hermes's Hermes chats". */
export const grantText = (bot: string) =>
  `On: chat with ${bot} in bb, see ${bot === "Hermes" ? "its" : `${bot}'s Hermes`} chats in bb, and let ${bot} operate bb: read, start, message, stop and archive any bb thread on any machine. Hermes doesn't ask before running bb commands. Restrictions come later.`;

export const importText = (count: number) => `Imports ${count} ${count === 1 ? "chat" : "chats"} from the last 30 days.`;

export const UNSERVED_TEXT = "Not served by this machine's gateway";

function BotSwitch({ bot, onChanged }: { bot: BotRow; onChanged: () => Promise<void> }) {
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

  return (
    <li className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-describedby={`${id}-text`}
        className="mt-0.5 size-4 shrink-0 cursor-pointer accent-foreground disabled:cursor-not-allowed"
        checked={pending ?? bot.enabled}
        // An unserved bot can't turn on; one already on can still turn off.
        disabled={(!bot.served && !bot.enabled) || pending !== null}
        onChange={(event) => toggle(event.target.checked)}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="font-medium text-foreground">
          {bot.bot_label}
        </label>
        <div id={`${id}-text`} className="flex flex-col gap-0.5 text-muted-foreground">
          {bot.served ? <p>{grantText(bot.bot_label)}</p> : <p>{UNSERVED_TEXT}</p>}
          {bot.served && bot.import_count !== null && <p>{importText(bot.import_count)}</p>}
        </div>
        {error !== null && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </div>
    </li>
  );
}

export function BotSwitches() {
  const { value, error, refetch } = useLive("bots", BOTS_CHANNEL);
  return (
    <div className="flex flex-col gap-3 text-sm">
      {value !== null && value.bots.length === 0 && <p className="text-muted-foreground">No bots yet: connect to Hermes above.</p>}
      {value !== null && value.bots.length > 0 && (
        <ul className="flex flex-col gap-4">
          {value.bots.map((bot) => (
            <BotSwitch key={bot.profile_home} bot={bot} onChanged={refetch} />
          ))}
        </ul>
      )}
      {value === null && error === null && <p className="text-muted-foreground">Loading bots…</p>}
      {error !== null && <p className="text-destructive">Can't list bots: {error}</p>}
    </div>
  );
}

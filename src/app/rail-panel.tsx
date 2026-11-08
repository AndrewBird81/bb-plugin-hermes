// Rail panel (01 §4, T1.12): each enabled bot, its bot thread with bb's unread dot, and "New chat with <bot>".
import { useState } from "react";
import { experimental_useSidebarThreads, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { BOTS_CHANNEL, type BotRow, type RpcContract } from "../shared/rpc-contract.js";
import { errorText, useLive } from "./live.js";
import { BUTTON } from "./styles.js";

export const newChatLabel = (bot: string) => `New chat with ${bot}`;

function BotEntry({ bot, unread }: { bot: BotRow; unread: boolean }) {
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadId = bot.thread_id;

  const newChat = () => {
    setStarting(true);
    setError(null);
    rpc
      .call("newChat", { profile: bot.profile })
      .then(({ thread_id }) => navigate.toThread(thread_id), (cause: unknown) => setError(errorText(cause)))
      .finally(() => setStarting(false));
  };

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border p-3">
      {threadId === null ? (
        <span className="font-medium text-foreground">{bot.bot_label}</span>
      ) : (
        <button
          type="button"
          className="flex cursor-pointer items-center gap-2 text-left font-medium text-foreground hover:underline"
          onClick={() => navigate.toThread(threadId)}
        >
          {bot.bot_label}
          {unread && <span role="status" aria-label="Unread" className="size-2 shrink-0 rounded-full bg-blue-500" />}
        </button>
      )}
      <div>
        <button type="button" className={BUTTON} disabled={starting} onClick={newChat}>
          {starting ? "Starting…" : newChatLabel(bot.bot_label)}
        </button>
      </div>
      {error !== null && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

export function RailPanel() {
  const { value, error } = useLive("bots", BOTS_CHANNEL);
  const { threads } = experimental_useSidebarThreads();
  const unread = new Set(threads.filter((thread) => thread.isUnread).map((thread) => thread.id));
  const enabled = value?.bots.filter((bot) => bot.enabled) ?? [];
  return (
    <div className="flex flex-col gap-4 p-4 text-sm">
      {value !== null && enabled.length === 0 && (
        <p className="text-muted-foreground">No bot is on. Turn one on in the Hermes plugin settings.</p>
      )}
      {enabled.length > 0 && (
        <ul className="flex flex-col gap-3">
          {enabled.map((bot) => (
            <BotEntry key={bot.profile_home} bot={bot} unread={bot.thread_id !== null && unread.has(bot.thread_id)} />
          ))}
        </ul>
      )}
      {value === null && error === null && <p className="text-muted-foreground">Loading bots…</p>}
      {error !== null && <p className="text-destructive">Can't list bots: {error}</p>}
    </div>
  );
}

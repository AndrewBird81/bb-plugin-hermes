// Row badge (01 §3, A28): the Hermes icon and "Hermes · Neo · Bot Chat" on a Hermes thread's metadata line.
import type {
  ExperimentalThreadRowMetadataDataInput,
  ExperimentalThreadRowMetadataProps,
} from "@get-bb/plugin-sdk/app";
import type { ThreadInfo } from "../shared/rpc-contract.js";
import { BOT_CHAT_TITLE } from "../shared/sources.js";
import { HermesIcon } from "./hermes-icon.js";
import { HERMES_PROVIDER, useThreadInfo } from "./thread-info.js";

export type RowData = ReturnType<typeof useThreadInfo>;

/** Bot thread "Hermes · Neo · Bot Chat"; side chat and mirrored chat "Hermes · Neo". Never an app's name. */
export function badgeText(info: ThreadInfo): string {
  return ["Hermes", info.bot_label, ...(info.kind === "bot" ? [BOT_CHAT_TITLE] : [])].join(" · ");
}

export function useRowData({ threads }: ExperimentalThreadRowMetadataDataInput): RowData {
  return useThreadInfo(threads.filter((thread) => thread.providerId === HERMES_PROVIDER).map((thread) => thread.id));
}

export function RowBadge({ thread, data }: ExperimentalThreadRowMetadataProps<RowData>) {
  const info = data?.[thread.id];
  if (!info) return null;
  const text = badgeText(info);
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground" title={text}>
      <HermesIcon className="size-3 shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  );
}

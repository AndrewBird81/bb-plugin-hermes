// Thread banners above a Hermes thread's composer (01 §5–§6, A47; 02 flow 10, A9).
import { experimental_useThreadExtensionState, useComposer } from "@get-bb/plugin-sdk/app";
import { bannerText, EXTENSION_KINDS, statusStateSchema } from "../shared/extension-state.js";
import { HEALTH_CHANNEL, type Health } from "../shared/rpc-contract.js";
import { useLive } from "./live.js";
import { useThreadInfo } from "./thread-info.js";

/** A9 sets the final text in dogfood. */
export const offlineText = (health: Health) =>
  `${health.machine?.name ?? "The Hermes machine"} is offline: sends wait until it reconnects`;

function useThreadId(): string | null {
  const { scope } = useComposer();
  return scope.kind === "thread" ? scope.threadId : null;
}

/** The bridge's `status` state: "Open in another Hermes app: sends when it's free", "Running outside bb". */
export function StatusBanner() {
  const threadId = useThreadId();
  const parsed = statusStateSchema.safeParse(experimental_useThreadExtensionState(threadId ?? "", EXTENSION_KINDS.status));
  const banner = parsed.success ? parsed.data.banner : null;
  return banner === null ? null : <p className="text-sm text-foreground">{bannerText(banner)}</p>;
}

function OfflineText() {
  const { value: health } = useLive("health", HEALTH_CHANNEL);
  return health?.state === "machine_offline" ? <p className="text-sm text-foreground">{offlineText(health)}</p> : null;
}

/** While the Hermes machine is offline, on Hermes threads only. */
export function OfflineBanner() {
  const threadId = useThreadId();
  const info = useThreadInfo(threadId === null ? [] : [threadId]);
  return threadId !== null && info?.[threadId] ? <OfflineText /> : null;
}

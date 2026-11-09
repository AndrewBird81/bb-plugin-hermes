// New Thread banners while Hermes is the picked provider (ux-v1.1 §2–§3). Only "No Hermes bot is on" so far: the
// not-connected and wrong-machine banners come with the listing decision, and this one stays out of their way.
import { useComposer } from "@get-bb/plugin-sdk/app";
import type { ComposerSelection } from "@get-bb/plugin-sdk/app";
import { NO_BOT_TEXT, NO_BOT_TITLE } from "../shared/provider-options.js";
import { BOTS_CHANNEL, HEALTH_CHANNEL } from "../shared/rpc-contract.js";
import { useLive } from "./live.js";
import { HERMES_PROVIDER } from "./thread-info.js";

/** The machine a New Thread draft runs on, when it names one. */
function hostOf(environment: ComposerSelection["environment"]): string | null {
  if (environment?.type === "host") return environment.hostId ?? null;
  if (environment?.type === "provider" && environment.machine?.type === "existing") return environment.machine.hostId;
  return null;
}

function NoBot({ host }: { host: string | null }) {
  const { value: health } = useLive("health", HEALTH_CHANNEL);
  const { value: bots } = useLive("bots", BOTS_CHANNEL);
  // Not connected, or another machine than Hermes': not this banner's to say.
  if (!health?.connected || bots === null || (host !== null && host !== health.machine?.id)) return null;
  if (bots.bots.some((bot) => bot.enabled)) return null;
  return (
    // bb's own card content (its "not installed" card): the host draws only the card's border.
    <div role="status" className="px-3 py-2.5">
      <p className="text-xs font-medium text-foreground">{NO_BOT_TITLE}</p>
      <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">{NO_BOT_TEXT}</p>
    </div>
  );
}

/** No button: `useBbNavigate` has no settings route (ux-v1.1 §3). */
export function NoBotBanner() {
  const { selection } = useComposer();
  return selection?.providerId === HERMES_PROVIDER ? <NoBot host={hostOf(selection.environment)} /> : null;
}

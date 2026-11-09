// The `message.dispatch` hook for Hermes threads. Synchronous, no I/O beyond the mapping db: the hook runs in a
// 10 s box under a server-wide lock.
// - D15 (01 §7): a message that starts with the outside tag and carries no marker, a recalled `[Outside bb] …`
//   line, is refused. Wakes and imports carry markers and pass.
// - 01 §9: a thread on another machine than the Hermes machine is refused "Hermes runs on <machine>: add
//   `--machine <machine>`" (bb answers `bb thread spawn` 409 `dispatch_rejected` with it).
import type { MessageDispatchHookContext, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { decodeMarker } from "../shared/marker.js";
import { otherMachineText } from "../shared/provider-options.js";
import { OUTSIDE_TAG_PREFIX, OUTSIDE_TAG_REFUSAL } from "../shared/sources.js";

type Part = { type: string; text?: string; visibility?: string };

const isMarker = (part: Part) => {
  if (part.type !== "text" || part.visibility !== "agent-only" || part.text === undefined) return false;
  try {
    return decodeMarker(part.text) !== null;
  } catch {
    return false;
  }
};

/** A visible text part starting with the tag, and no marker in the same message. */
const recalled = (parts: readonly Part[]) =>
  !parts.some(isMarker) && parts.some((p) => p.type === "text" && p.visibility !== "agent-only" && OUTSIDE_TAG_PREFIX.test(p.text ?? ""));

/** `hermes`: the saved Hermes machine (null when unset). An unknown host (`context.host` null) passes. */
export function dispatchDecision(context: MessageDispatchHookContext, hermes: { id: string; name: string | null } | null): MessageDispatchHookDecision {
  if (context.thread.providerId !== "hermes") return { action: "proceed" };
  if (hermes && context.host && context.host.id !== hermes.id) return { action: "reject", message: otherMachineText(hermes.name ?? "the Hermes machine") };
  // Each message on its own: bb may merge queued rows (a wake and a user's send) into one dispatch.
  const messages: readonly (readonly Part[])[] = context.queuedMessages.length
    ? context.queuedMessages.map((m) => m.content)
    : [context.input.blocks as readonly PromptInput[]];
  return messages.some(recalled) ? { action: "reject", message: OUTSIDE_TAG_REFUSAL } : { action: "proceed" };
}

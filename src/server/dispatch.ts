// D15 (01 §7): bb refuses a send to a Hermes thread whose message starts with the outside tag and carries no
// marker: a recalled `[Outside bb] …` line. Wakes and imports carry markers and pass. Synchronous, no I/O: the
// hook runs in a 10 s box under a server-wide lock.
import type { MessageDispatchHookContext, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { decodeMarker } from "../shared/marker.js";
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

export function dispatchDecision(context: MessageDispatchHookContext): MessageDispatchHookDecision {
  if (context.thread.providerId !== "hermes") return { action: "proceed" };
  // Each message on its own: bb may merge queued rows (a wake and a user's send) into one dispatch.
  const messages: readonly (readonly Part[])[] = context.queuedMessages.length
    ? context.queuedMessages.map((m) => m.content)
    : [context.input.blocks as readonly PromptInput[]];
  return messages.some(recalled) ? { action: "reject", message: OUTSIDE_TAG_REFUSAL } : { action: "proceed" };
}

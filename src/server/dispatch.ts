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

/** A visible text part starting with the tag. */
const tagged = (parts: readonly Part[]) => parts.some((p) => p.type === "text" && p.visibility !== "agent-only" && OUTSIDE_TAG_PREFIX.test(p.text ?? ""));

/** The dispatch's messages: each queued row on its own, else the inline input. */
const messagesOf = (context: MessageDispatchHookContext): { parts: readonly Part[]; user: boolean }[] =>
  context.queuedMessages.length
    ? context.queuedMessages.map((m) => ({ parts: m.content, user: m.initiator === "user" }))
    : [{ parts: context.input.blocks as readonly PromptInput[], user: context.initiator === "user" }];

/**
 * `hermes`: the saved Hermes machine (null when unset). An unknown host (`context.host` null) passes. A group that
 * holds a marker (a wake or import merged with the user's own rows) proceeds: refusing it would drop the plugin's
 * turn, and the bridge refuses a tagged prompt segment itself.
 */
export function dispatchDecision(context: MessageDispatchHookContext, hermes: { id: string; name: string | null } | null): MessageDispatchHookDecision {
  if (context.thread.providerId !== "hermes") return { action: "proceed" };
  if (hermes && context.host && context.host.id !== hermes.id) return { action: "reject", message: otherMachineText(hermes.name ?? "the Hermes machine") };
  const messages = messagesOf(context);
  if (messages.some((m) => m.parts.some(isMarker))) return { action: "proceed" };
  return messages.some((m) => tagged(m.parts)) ? { action: "reject", message: OUTSIDE_TAG_REFUSAL } : { action: "proceed" };
}

/** The user's own message (not a plugin marker) is in this dispatch: it must not run under an init's or import's hold. */
export const hasUserMessage = (context: MessageDispatchHookContext) =>
  context.thread.providerId === "hermes" && messagesOf(context).some((m) => m.user && !m.parts.some(isMarker));

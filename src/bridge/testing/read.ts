// Test-only: what a thread's captured output says, assembled by the SDK kit like the runtime does.
import type { Rig } from "./harness.js";

type Event = Record<string, unknown> & { type: string };

export const events = (rig: Rig, threadId: string) => rig.events(threadId) as unknown as Event[];

export const agentTexts = (rig: Rig, threadId: string) =>
  events(rig, threadId)
    .filter((e) => e.type === "item/completed" && (e.item as { type: string }).type === "agentMessage")
    .map((e) => (e.item as { text: string }).text);

export const statuses = (rig: Rig, threadId: string) => events(rig, threadId).filter((e) => e.type === "turn/completed").map((e) => e.status as string);

export const errors = (rig: Rig, threadId: string) => events(rig, threadId).filter((e) => e.type === "provider/error").map((e) => e.message as string);

/** The raw deltas the bridge sent for a thread. */
export const deltas = (rig: Rig, threadId: string) =>
  rig.rpc.messages
    .filter((m) => m.method === "thread/delta" && (m.params as { threadId: string }).threadId === threadId)
    .flatMap((m) => (m.params as { deltas: (Record<string, unknown> & { kind: string })[] }).deltas);

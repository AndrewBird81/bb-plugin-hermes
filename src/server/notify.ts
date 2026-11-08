// Per-thread notification levels (01 §8, S1-S3 §S3c): `muted` during an init or an import, `input-only`
// during a mirror turn (approvals and `clarify` still push), then the user's own level again. Through
// the push-notifications plugin's RPC; without it, nothing to do. The user's level is kept in `kv`
// until restored, so a restart restores it too.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { getKv, setKv, type Db } from "./db.js";

export type QuietLevel = "muted" | "input-only";
const QUIETNESS = { all: 2, "input-only": 1, muted: 0 } as const;

/**
 * push-notifications (bb 0.49.0) coalesces a thread's events for 2 s, then reads the thread's level, and
 * skips a thread read since the event. So the hold set right after `threads.spawn` only has to land
 * within 2 s of the init's `thread.idle` (the init's `markRead` also covers it): there is no way to set a
 * level at spawn. The restore must come after that flush: 3 s.
 */
export const RESTORE_DELAY_MS = 3_000;

const PLUGIN = "push-notifications";
const levelSchema = z.object({ own: z.enum(["inherit", "all", "input-only", "muted"]) }).passthrough();
const listSchema = z.object({ threads: z.record(z.string(), levelSchema) }).passthrough();
const KV = "notify_restore";

type Own = z.infer<typeof levelSchema>["own"];

export function createNotify(bb: BbPluginApi, db: Db, onError: (code: string) => void) {
  /** threadId → the level held now; a released thread leaves this map at once (its restore waits). */
  const held = new Map<string, QuietLevel>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  bb.onDispose(() => timers.forEach(clearTimeout));

  const saved = (): Record<string, Own> => (getKv(db, KV) as Record<string, Own> | null) ?? {};
  const save = (map: Record<string, Own>) => setKv(db, KV, map);

  const call = <T>(method: string, input: { [key: string]: string | string[] }, outputSchema: z.ZodType<T>) =>
    bb.sdk.plugins.callRpc({ pluginId: PLUGIN, method, input, outputSchema });

  async function set(threadId: string, level: Own): Promise<void> {
    await call("threadNotifications.set", { threadId, level }, levelSchema);
  }

  /** Quiet a thread to `level` (the quieter of this and any hold already on it) until `release`. */
  async function hold(threadId: string, level: QuietLevel): Promise<void> {
    clearTimeout(timers.get(threadId));
    timers.delete(threadId);
    const current = held.get(threadId);
    if (current && QUIETNESS[current] <= QUIETNESS[level]) return;
    try {
      const map = saved();
      if (!(threadId in map)) {
        const listed = await call("threadNotifications.list", { threadIds: [threadId] }, listSchema);
        const own = listed.threads[threadId]?.own ?? "inherit";
        // A user's level at least as quiet as ours stays as it is.
        if (own !== "inherit" && QUIETNESS[own] <= QUIETNESS[level]) return;
        save({ ...map, [threadId]: own });
      }
      await set(threadId, level);
      held.set(threadId, level);
    } catch {
      onError("notify_hold_failed");
    }
  }

  async function restore(threadId: string): Promise<void> {
    const map = saved();
    if (!(threadId in map)) return;
    try {
      await set(threadId, map[threadId]!);
    } catch {
      onError("notify_restore_failed");
    }
    held.delete(threadId);
    const { [threadId]: _, ...rest } = saved();
    save(rest);
  }

  /** The thread's turns are over: back to the user's level, after `RESTORE_DELAY_MS` (a new hold cancels it). */
  function release(threadId: string): void {
    held.delete(threadId);
    if (!(threadId in saved())) return;
    clearTimeout(timers.get(threadId));
    timers.set(
      threadId,
      setTimeout(() => {
        timers.delete(threadId);
        void restore(threadId);
      }, RESTORE_DELAY_MS),
    );
  }

  return {
    hold,
    release,
    /** Boot: levels a previous run left quiet go back now. */
    async restoreAll(): Promise<void> {
      for (const threadId of Object.keys(saved())) if (!held.has(threadId)) await restore(threadId);
    },
  };
}

export type Notify = ReturnType<typeof createNotify>;

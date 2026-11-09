// Side chats, which bb makes (New Thread, `bb thread spawn`; 02 flow 2, A18), redeploy (flow 12) and the
// per-thread facts the app shows (`threadInfo`).
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ThreadInfo } from "../shared/rpc-contract.js";
import { labelOf } from "./bots.js";
import { errorCode } from "./connection.js";
import { allBindings, type Binding, bindingByThread, botByName, botRecord, getKv, insertBinding } from "./db.js";
import { expectedId, invalidateThreadInfo, type SyncDeps, type Target, targetOf } from "./sync.js";

export const TITLE_MAX = 60;

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** The first visible message, cut to 60 characters (S7 finding 4). */
export function titleFrom(message: string): string | null {
  const line = message.replace(/\s+/g, " ").trim();
  return line ? Array.from(line).slice(0, TITLE_MAX).join("").trimEnd() : null;
}

/** The bot bb's New Thread chip picked: `bb/session-option-selections`, seeded at create (research 13 §3). */
function selectedProfile(events: readonly { type: string; data: unknown }[]): string | null {
  for (const event of events) {
    const data = event.data as { kind?: unknown; payload?: { selections?: { profile?: unknown } } } | null;
    const profile = event.type === "thread/extensionState/updated" && data?.kind === "bb/session-option-selections" ? data.payload?.selections?.profile : null;
    if (typeof profile === "string" && profile) return profile;
  }
  return null;
}

/** `sessionOptions.profile` anywhere in a recorded `thread/start` request. */
function profileOption(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > 6) return null;
  const options = (value as { sessionOptions?: { profile?: unknown } }).sessionOptions;
  if (typeof options?.profile === "string" && options.profile) return options.profile;
  for (const child of Object.values(value)) {
    const found = profileOption(child, depth + 1);
    if (found) return found;
  }
  return null;
}

export function createChats(deps: SyncDeps & { describe: (target: Target) => Promise<{ uid: number }> }) {
  const { bb, db, connection } = deps;
  const fail = (code: string) => connection.recordError(code);
  /** Busy Hermes threads `stopHosted` stops at their `thread.idle`. */
  const stopAtIdle = new Set<string>();

  async function workerUid(target: Target): Promise<number> {
    const uid = getKv(db, "worker_uid");
    return typeof uid === "number" ? uid : (await deps.describe(target)).uid;
  }

  function chatBinding(threadId: string, profileHome: string, uid: number): Omit<Binding, "cursor_uid"> {
    return {
      thread_id: threadId,
      profile_home: profileHome,
      lineage_root: null,
      session_id: null,
      expected_id: expectedId(profileHome, uid, threadId),
      kind: "chat",
      source: null,
      tag: null,
      state: "pending",
      legacy: false,
      archived_by_switch: false,
      title_set: null,
    };
  }

  /**
   * bb's New Thread with the Bot chip, or `bb thread spawn --provider hermes --option profile=<bot>` (A18): bound as a
   * side chat before its first turn. Our own spawns (`pluginMetadata.hermes.origin`) are skipped. With no profile on
   * record yet, the `persisted-turn` state binds it after its first turn.
   */
  async function onCreatedNow(thread: { id: string; providerId: string; originPluginId: string | null }): Promise<void> {
    if (thread.providerId !== "hermes" || thread.originPluginId === bb.pluginId || bindingByThread(db, thread.id)) return;
    const meta = await bb.sdk.threads.getPluginMetadata({ threadId: thread.id }).catch(() => null);
    if (JSON.stringify(meta ?? {}).includes('"hermes":{"origin"')) return;
    const target = targetOf(connection);
    if (!target) return;
    const events = await bb.sdk.threads.events.list({
      threadId: thread.id,
      types: ["thread/extensionState/updated", "client/thread/start", "client/turn/requested"],
      order: "asc",
      limit: "10",
    });
    const name = selectedProfile(events) ?? profileOption(events);
    const bot = name ? botByName(db, name) : null;
    if (!bot?.enabled) return;
    insertBinding(db, chatBinding(thread.id, bot.profile_home, await workerUid(target)));
    invalidateThreadInfo(bb);
  }

  /** Flow 12: idle Hermes threads stop now, busy ones at their `thread.idle`. */
  async function stopHosted(): Promise<{ stopped: number; pending: number; failed: number }> {
    const ids = allBindings(db).map((b) => b.thread_id);
    const out = { stopped: 0, pending: 0, failed: 0 };
    for (let i = 0; i < ids.length; i += 200) {
      const threads = await bb.sdk.threads.list({ threadIds: ids.slice(i, i + 200), includeHidden: true });
      for (const thread of threads) {
        if (thread.providerId !== "hermes") continue;
        if (thread.status === "active" || thread.status === "starting" || thread.status === "stopping") {
          stopAtIdle.add(thread.id);
          out.pending++;
          continue;
        }
        try {
          await bb.sdk.threads.stop({ threadId: thread.id });
          out.stopped++;
        } catch (error) {
          fail(errorCode(error, "stop_failed"));
          out.failed++;
        }
      }
    }
    return out;
  }

  async function onIdle(threadId: string): Promise<void> {
    if (!stopAtIdle.delete(threadId)) return;
    await bb.sdk.threads.stop({ threadId }).catch((error) => fail(errorCode(error, "stop_failed")));
  }

  /** Every key answers: null = not a Hermes thread, or not bound yet. */
  function threadInfo(keys: string[]): Record<string, ThreadInfo | null> {
    const out: Record<string, ThreadInfo | null> = {};
    for (const key of keys) {
      const binding = bindingByThread(db, key);
      const bot = binding ? botRecord(db, binding.profile_home) : null;
      out[key] = !binding || !bot ? null : { kind: binding.kind, profile_home: binding.profile_home, bot_label: labelOf(bot), enabled: bot.enabled };
    }
    return out;
  }

  return { onCreatedNow, stopHosted, onIdle, threadInfo };
}

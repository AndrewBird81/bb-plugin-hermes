// Side chats (02 flow 2), threads made elsewhere (`bb thread spawn`, A18), redeploy (flow 12) and the
// per-thread facts the app shows (`threadInfo`).
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { newChatTitle } from "../shared/bots.js";
import { decodeMarker, spawnStart } from "../shared/marker.js";
import type { ThreadInfo } from "../shared/rpc-contract.js";
import { labelOf, spawnPlacement } from "./bots.js";
import { errorCode } from "./connection.js";
import { allBindings, type Binding, bindingByThread, botByName, botRecord, type Db, getKv, insertBinding, updateBinding } from "./db.js";
import { type Enqueue, expectedId, invalidateThreadInfo, type Sync, type SyncDeps, type Target, targetOf } from "./sync.js";

export const TITLE_MAX = 60;

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** The first visible message, cut to 60 characters (S7 finding 4). */
export function titleFrom(message: string): string | null {
  const line = message.replace(/\s+/g, " ").trim();
  return line ? Array.from(line).slice(0, TITLE_MAX).join("").trimEnd() : null;
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

export function createChats(deps: SyncDeps & { sync: Sync; enqueue: Enqueue; describe: (target: Target) => Promise<{ uid: number }> }) {
  const { bb, db, connection, notify, sync, enqueue } = deps;
  const fail = (code: string) => connection.recordError(code);
  /** Busy Hermes threads `stopHosted` stops at their `thread.idle`. */
  const stopAtIdle = new Set<string>();

  async function workerUid(target: Target): Promise<number> {
    const uid = getKv(db, "worker_uid");
    return typeof uid === "number" ? uid : (await deps.describe(target)).uid;
  }

  function chatBinding(threadId: string, profileHome: string, uid: number, titleSet: string | null): Omit<Binding, "cursor_uid"> {
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
      title_set: titleSet,
    };
  }

  /** Flow 2: an empty chat with an enabled bot; Hermes' session comes with the first message. */
  async function newChat(profile: string): Promise<{ thread_id: string }> {
    const bot = botByName(db, profile);
    if (!bot) throw new Error(`Unknown bot ${profile}.`);
    if (!bot.enabled) throw new Error(`${labelOf(bot)} is switched off in the Hermes plugin settings.`);
    const target = targetOf(connection);
    if (!target) throw new Error("Hermes isn't connected.");
    return enqueue(async () => {
      const uid = await workerUid(target);
      const title = newChatTitle(labelOf(bot));
      const thread = await bb.sdk.threads.spawn({
        ...(await spawnPlacement(bb, target.machine)),
        sessionOptions: { profile: bot.name },
        title,
        input: [spawnStart()],
        pluginMetadata: { hermes: { origin: "newChat" } },
      });
      // Right after the spawn, so a re-list never takes the new session for an outside chat (02 identity rules).
      insertBinding(db, chatBinding(thread.id, bot.profile_home, uid, sha256(title)));
      invalidateThreadInfo(bb);
      sync.readAtIdle.add(thread.id);
      await notify.hold(thread.id, "muted");
      await sync.sendInit(thread.id, { op: "init", profile: bot.name });
      return { thread_id: thread.id };
    });
  }

  /**
   * `bb thread spawn --provider hermes --option profile=<bot>` (A18): bound like a side chat. Our own
   * spawns (`pluginMetadata.hermes.origin`) are skipped. With no profile on record yet, the
   * `persisted-turn` state binds it after its first turn.
   */
  async function onCreatedNow(thread: { id: string; providerId: string; originPluginId: string | null }): Promise<void> {
    if (thread.providerId !== "hermes" || thread.originPluginId === bb.pluginId || bindingByThread(db, thread.id)) return;
    const meta = await bb.sdk.threads.getPluginMetadata({ threadId: thread.id }).catch(() => null);
    if (JSON.stringify(meta ?? {}).includes('"hermes":{"origin"')) return;
    const target = targetOf(connection);
    if (!target) return;
    const events = await bb.sdk.threads.events.list({ threadId: thread.id, types: ["client/thread/start", "client/turn/requested"], order: "asc", limit: "5" });
    const name = profileOption(events);
    const bot = name ? botByName(db, name) : null;
    if (!bot?.enabled) return;
    insertBinding(db, chatBinding(thread.id, bot.profile_home, await workerUid(target), null));
    invalidateThreadInfo(bb);
  }

  /** A side chat still titled "New <bot> chat" takes its first message as title (S7 finding 4). */
  async function retitleNow(threadId: string): Promise<void> {
    const binding = bindingByThread(db, threadId);
    const bot = binding ? botRecord(db, binding.profile_home) : null;
    if (!binding || binding.kind !== "chat" || !bot) return;
    const placeholder = newChatTitle(labelOf(bot));
    if (binding.title_set !== sha256(placeholder)) return;
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.title !== placeholder) return;
    const history = await bb.sdk.threads.promptHistory({ threadId });
    const hasMarker = (entry: (typeof history)[number]) =>
      entry.input.some((part) => {
        if (part.type !== "text" || (part as { visibility?: string }).visibility !== "agent-only") return false;
        try {
          return decodeMarker(part.text) !== null;
        } catch {
          return true;
        }
      });
    // A plugin turn (a wake's `[Outside bb] …` label) never names the chat.
    const visible = (entry: (typeof history)[number]) =>
      hasMarker(entry)
        ? ""
        : entry.input.flatMap((part) => (part.type === "text" && (part as { visibility?: string }).visibility !== "agent-only" ? [part.text] : [])).join(" ");
    // The first entry with visible text: an agent-only `init`, if bb records one, never names the chat.
    const message = [...history].sort((a, b) => a.createdAt - b.createdAt).map(visible).find((t) => titleFrom(t) !== null);
    const title = message ? titleFrom(message) : null;
    if (!title) return;
    await bb.sdk.threads.update({ threadId, title });
    updateBinding(db, threadId, { title_set: sha256(title) });
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

  return { newChat, onCreatedNow, retitleNow, stopHosted, onIdle, threadInfo };
}

// Bot switches and bot threads (02 flow 1 without step 6, flow 9-10 reconciles, D43, D44, D48).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { botLabel, botThreadTitle } from "../shared/bots.js";
import type { HermesProfile } from "../shared/host-contract.js";
import { encodeMarker, type Marker } from "../shared/marker.js";
import { BOTS_CHANNEL, type BotRow } from "../shared/rpc-contract.js";
import { errorCode } from "./connection.js";
import {
  allBots,
  bindingsOf,
  botBinding,
  botRecord,
  type BotRecord,
  deleteBinding,
  enabledBots,
  getKv,
  insertBinding,
  setBotEnabled,
  setKv,
  updateBinding,
  upsertBot,
} from "./db.js";
import { type Enqueue, invalidateThreadInfo, type Sync, type SyncDeps, type Target, targetOf } from "./sync.js";

/** `findBotChat` → `held` (Conduit holds an unadopted Bot Chat): retry at 2, 5, 10, 30 s, then every 60 s (flow 3 step 4). */
export const HELD_RETRY_MS = [2_000, 5_000, 10_000, 30_000, 60_000];
const ACCESS_PENDING = "access_pending";
const PROVIDER_ID = "hermes";

/** Where every Hermes thread is spawned: the personal project, the Hermes machine's personal workspace (S1-S3 §S3b). */
export async function spawnPlacement(bb: BbPluginApi, machine: string) {
  const projects = await bb.sdk.projects.list({ includePersonal: true });
  const personal = projects.find((p) => p.kind === "personal");
  if (!personal) throw Object.assign(new Error("no personal project"), { code: "no_personal_project" });
  return {
    projectId: personal.id,
    providerId: PROVIDER_ID,
    environment: { type: "host" as const, hostId: machine, workspace: { type: "personal" as const } },
  };
}

export const labelOf = (bot: Pick<BotRecord, "name" | "handle">) => botLabel(bot.name, bot.handle);

export function createBots(deps: SyncDeps & { sync: Sync; enqueue: Enqueue }) {
  const { bb, db, host, connection, notify, sync, enqueue } = deps;
  const fail = (code: string) => connection.recordError(code);
  let described: { uid: number; profiles: HermesProfile[] } | null = null;
  const held = new Map<string, { attempt: number; timer: ReturnType<typeof setTimeout> }>();
  bb.onDispose(() => held.forEach((h) => clearTimeout(h.timer)));

  const publish = () => bb.realtime.publish(BOTS_CHANNEL, null);
  const isEnabled = (home: string) => botRecord(db, home)?.enabled === true;

  /** `describe`, cached; the facts deriveProviderOptions needs go into `bots`. */
  async function describe(target: Target): Promise<NonNullable<typeof described>> {
    const answer = await host.call("describe", { root: target.root }, { hostId: target.machine });
    let changed = JSON.stringify(answer) !== JSON.stringify(described);
    described = answer;
    setKv(db, "worker_uid", answer.uid);
    for (const p of answer.profiles) changed = upsertBot(db, { profile_home: p.home, name: p.name, handle: p.handle, cwd: p.terminal_cwd }) || changed;
    if (changed) {
      publish();
      invalidateThreadInfo(bb);
    }
    return answer;
  }

  function row(profile: HermesProfile): BotRow {
    return {
      profile: profile.name,
      profile_home: profile.home,
      bot_label: botLabel(profile.name, profile.handle),
      served: profile.served,
      enabled: isEnabled(profile.home),
      thread_id: botBinding(db, profile.home)?.thread_id ?? null,
      import_count: null,
    };
  }

  /** The worker's profiles; while it can't describe, the last answer, else the bots on record (so an on bot can go off offline). */
  async function rows(): Promise<BotRow[]> {
    const target = targetOf(connection);
    if (target) {
      try {
        return (described ?? (await describe(target))).profiles.map(row);
      } catch (error) {
        fail(errorCode(error, "describe_failed"));
      }
    }
    if (described) return described.profiles.map(row);
    // On record only: offline, never claim a bot unserved (a switch-on fails with "Hermes isn't connected").
    return allBots(db).map((b) => row({ name: b.name, home: b.profile_home, handle: b.handle, terminal_cwd: b.cwd, served: true }));
  }

  // ---- bb access (skill + wrapper): retried until the worker confirms, so an off bot never keeps it ----

  const pendingAccess = () => (getKv(db, ACCESS_PENDING) as Record<string, boolean> | null) ?? {};

  async function syncAccessNow(target: Target, profileHome: string, on: boolean): Promise<void> {
    const enabled = enabledBots(db).map((b) => b.profile_home);
    try {
      const result = await host.call("setBotAccess", { root: target.root, profile_home: profileHome, on, enabled_bots: enabled }, { hostId: target.machine });
      if (result.detail) fail(result.detail);
      // Done only once the sessions saw it (02 flow 1); else retried at the next connect.
      if (!result.refreshed || result.detail) throw Object.assign(new Error("not refreshed"), { code: "set_bot_access_incomplete" });
      const { [profileHome]: _, ...rest } = pendingAccess();
      setKv(db, ACCESS_PENDING, rest);
    } catch (error) {
      fail(errorCode(error, "set_bot_access_failed"));
      setKv(db, ACCESS_PENDING, { ...pendingAccess(), [profileHome]: on });
    }
  }

  // ---- the bot thread (01 §3) ----

  async function spawnBotThreadNow(bot: BotRecord, target: Target): Promise<void> {
    const init: Marker = { op: "init", profile: bot.name, bot: true };
    const thread = await bb.sdk.threads.spawn({
      ...(await spawnPlacement(bb, target.machine)),
      sessionOptions: { profile: bot.name },
      title: botThreadTitle(labelOf(bot)),
      pinned: true,
      input: [encodeMarker(init)],
      pluginMetadata: { hermes: { origin: "switch" } },
    });
    insertBinding(db, {
      thread_id: thread.id,
      profile_home: bot.profile_home,
      lineage_root: null,
      session_id: null,
      expected_id: null,
      kind: "bot",
      source: null,
      tag: null,
      state: "pending",
      legacy: false,
      archived_by_switch: false,
      title_set: null,
    });
    sync.readAtIdle.add(thread.id);
    invalidateThreadInfo(bb);
    await notify.hold(thread.id, "muted");
    publish();
  }

  /** The bot binding's thread, unless bb deleted it (then the binding goes, and a new thread follows). */
  async function liveThread(threadId: string) {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (!thread.deletedAt) return thread;
    } catch (error) {
      if (!/404|not.found/i.test(String((error as Error)?.message ?? error))) throw error;
    }
    deleteBinding(db, threadId);
    invalidateThreadInfo(bb);
    return null;
  }

  /** Flow 1 step 4: find the Bot Chat by title; found → bind and import; held → retry; none → stays `pending`. */
  async function bindBotChatNow(profileHome: string, target: Target): Promise<void> {
    const binding = botBinding(db, profileHome);
    const bot = botRecord(db, profileHome);
    // A running bb turn may be creating the Bot Chat right now: its `persisted-turn` binds it at idle.
    if (!binding || binding.state !== "pending" || !bot?.enabled || sync.active.has(binding.thread_id)) return;
    const found = await host.call("findBotChat", { root: target.root, profile_home: profileHome }, { hostId: target.machine });
    if (found.state === "held") return scheduleHeld(profileHome);
    clearHeld(profileHome);
    if (found.state === "none") return;
    // bb's own first send may have created it: then bb's record binds it, and nothing is imported twice.
    await sync.ingestPersistedNow(binding.thread_id);
    if (botBinding(db, profileHome)?.state !== "pending") return;
    try {
      updateBinding(db, binding.thread_id, { lineage_root: found.lineage_root, session_id: found.session_id, legacy: found.legacy, state: "replaying" });
    } catch (error) {
      // UNIQUE: another thread already has this chat (02 §Invariants: one thread per Hermes chat).
      return fail(errorCode(error, "duplicate_binding"));
    }
    await sync.importNow(botBinding(db, profileHome)!, bot.enabled_at ?? Date.now(), target);
  }

  function clearHeld(profileHome: string): void {
    clearTimeout(held.get(profileHome)?.timer);
    held.delete(profileHome);
  }

  function scheduleHeld(profileHome: string): void {
    const attempt = held.get(profileHome)?.attempt ?? 0;
    clearTimeout(held.get(profileHome)?.timer);
    const delay = HELD_RETRY_MS[Math.min(attempt, HELD_RETRY_MS.length - 1)]!;
    const timer = setTimeout(() => {
      void enqueue(async () => {
        const target = targetOf(connection);
        if (target && isEnabled(profileHome)) await bindBotChatNow(profileHome, target);
        else clearHeld(profileHome);
      }).catch((error) => fail(errorCode(error, "bot_chat_retry_failed")));
    }, delay);
    held.set(profileHome, { attempt: attempt + 1, timer });
  }

  /**
   * A `pending` bot thread looks for its Bot Chat again at every reconcile, beyond switch-on and bb's
   * sends, so a Bot Chat Conduit makes later binds without a bb send. Held here alone: if `session.list`
   * by title turns out to adopt a Conduit-made Bot Chat, this goes (a read must never adopt, A23).
   */
  async function relookBotChatNow(profileHome: string, target: Target): Promise<void> {
    if (!held.has(profileHome)) await bindBotChatNow(profileHome, target);
  }

  /**
   * One enabled bot (flows 1, 6, 9, 10): its bot thread exists (re-created, pinned, if bb deleted it:
   * 01 §3), a `pending` one looks for its Bot Chat, an interrupted import resumes, live threads wake.
   */
  async function reconcileProfileNow(profileHome: string, target: Target, { full = false, relook = true } = {}): Promise<void> {
    const bot = botRecord(db, profileHome);
    if (!bot?.enabled) return;
    const binding = botBinding(db, profileHome);
    if (binding && full) await liveThread(binding.thread_id);
    if (!botBinding(db, profileHome)) await spawnBotThreadNow(bot, target);
    if (relook) await relookBotChatNow(profileHome, target);
    for (const b of bindingsOf(db, profileHome)) {
      if (b.state === "replaying") await sync.importNow(b, bot.enabled_at ?? Date.now(), target);
      else await sync.reconcileNow(b, target);
    }
  }

  /** Errors stay per profile: one bot's failure never blocks another's. */
  async function reconcileAllNow(homes: string[], target: Target, options: { full?: boolean } = {}): Promise<void> {
    for (const home of homes) {
      try {
        await reconcileProfileNow(home, target, options);
      } catch (error) {
        fail(errorCode(error, "reconcile_failed"));
      }
    }
  }

  // ---- switches (flow 1) ----

  async function switchOnNow(profileHome: string, target: Target): Promise<void> {
    setBotEnabled(db, profileHome, true, Date.now());
    await syncAccessNow(target, profileHome, true);
    // The worker writes `worker.json` with this bot before the spawn: bb fills the thread's model catalog
    // at spawn, and the bridge lists only enabled bots (else `model_catalog_unavailable`).
    await connection.ensureNow();
    const bot = botRecord(db, profileHome)!;
    const binding = botBinding(db, profileHome);
    // D48: the bot thread and what the switch archived come back; threads the user archived stay archived.
    if (binding && (await liveThread(binding.thread_id))?.archivedAt) await bb.sdk.threads.unarchive({ threadId: binding.thread_id });
    for (const b of bindingsOf(db, profileHome)) {
      if (b.kind === "bot" || !b.archived_by_switch) continue;
      try {
        await bb.sdk.threads.unarchive({ threadId: b.thread_id });
      } catch (error) {
        fail(errorCode(error, "unarchive_failed"));
      }
    }
    for (const b of bindingsOf(db, profileHome)) if (b.archived_by_switch) updateBinding(db, b.thread_id, { archived_by_switch: false });
    if (!botBinding(db, profileHome)) {
      try {
        await spawnBotThreadNow(bot, target);
      } catch (error) {
        // The bot stays on; every keep-alive reconcile spawns it until it exists (01 §3).
        fail(errorCode(error, "spawn_failed"));
        return;
      }
    }
    await bindBotChatNow(profileHome, target);
    await reconcileProfileNow(profileHome, target, { relook: false });
  }

  async function switchOffNow(profileHome: string): Promise<void> {
    setBotEnabled(db, profileHome, false, Date.now());
    clearHeld(profileHome);
    for (const b of bindingsOf(db, profileHome)) {
      try {
        const thread = await liveThread(b.thread_id);
        if (!thread || thread.archivedAt) continue;
        await bb.sdk.threads.stop({ threadId: b.thread_id }).catch(() => undefined);
        await bb.sdk.threads.archive({ threadId: b.thread_id });
        updateBinding(db, b.thread_id, { archived_by_switch: true });
      } catch (error) {
        fail(errorCode(error, "archive_failed"));
      }
    }
    const target = targetOf(connection);
    if (target) await syncAccessNow(target, profileHome, false);
    else setKv(db, ACCESS_PENDING, { ...pendingAccess(), [profileHome]: false });
  }

  async function setBot(profileHome: string, on: boolean): Promise<BotRow> {
    const target = targetOf(connection);
    if (on && !target) throw new Error("Hermes isn't connected.");
    const profile = (described ?? (target ? await describe(target) : null))?.profiles.find((p) => p.home === profileHome);
    if (!profile && on) throw new Error("Unknown bot.");
    if (on && !profile!.served) throw new Error("Not served by this machine's gateway.");
    await enqueue(async () => (on ? switchOnNow(profileHome, targetOf(connection) ?? target!) : switchOffNow(profileHome)));
    // The worker learns the new `enabled_bots` (watch, prewarm, worker.json) at once.
    await connection.ensureNow();
    publish();
    invalidateThreadInfo(bb);
    const record = botRecord(db, profileHome);
    return profile
      ? row(profile)
      : {
          profile: record?.name ?? "",
          profile_home: profileHome,
          bot_label: record ? labelOf(record) : "",
          served: false,
          enabled: false,
          thread_id: botBinding(db, profileHome)?.thread_id ?? null,
          import_count: null,
        };
  }

  /** The connection hook (flows 9, 10): describe again, retry bb access, reconcile every enabled bot. */
  async function onConnectedNow(target: Target, { newBoot, reconnected }: { newBoot: boolean; reconnected: boolean }): Promise<void> {
    if (!newBoot && !reconnected && described) {
      // An enabled bot with no bot thread (a failed spawn, a deleted thread) gets one at the next keep-alive.
      const missing = enabledBots(db).filter((b) => !botBinding(db, b.profile_home)).map((b) => b.profile_home);
      if (missing.length) await reconcileAllNow(missing, target);
      return;
    }
    await describe(target);
    for (const [home, on] of Object.entries(pendingAccess())) await syncAccessNow(target, home, on);
    if (newBoot || reconnected) await reconcileAllNow(enabledBots(db).map((b) => b.profile_home), target, { full: newBoot });
  }

  return { rows, setBot, describe, onConnectedNow, reconcileAllNow, isEnabled };
}

export type Bots = ReturnType<typeof createBots>;

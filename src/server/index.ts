// Server part (server seam): mapping db, keep-alive, health, diagnostics RPC (T0.6, T0.9); switches,
// bot threads, side chats, import and wakes (T1.9–T1.11).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import pkg from "../../package.json" with { type: "json" };
import { hostContract, hostSignals } from "../shared/host-contract.js";
import { BOTS_CHANNEL, rpcContract, type Diagnostics } from "../shared/rpc-contract.js";
import { parseModels, type SettingsHandle } from "../shared/settings.js";
import { createBots, personalProject } from "./bots.js";
import { createChats } from "./chats.js";
import { createDiscovery } from "./discovery.js";
import { dispatchDecision, hasUserMessage } from "./dispatch.js";
import { type ConnectionSource, createConnection, errorCode, KEEPALIVE_MS, type OnConnected } from "./connection.js";
import { hermesMachine, MACHINE_FOLDER_KEY, machineFolder, PERSONAL_PROJECT_KEY } from "./provider-options.js";
import { addTombstone, allBindings, bindingByThread, bindingCounts, type Db, deleteBinding, getKv, openMappingDb, queuedTurnsOf, setKv, updateBinding } from "./db.js";
import { createNotify } from "./notify.js";
import { createQueue, createSync, invalidateThreadInfo, targetOf } from "./sync.js";

/** `changed` signals are debounced again here: one re-list per burst (02 flow 6). */
export const WAKE_DEBOUNCE_MS = 500;
const PROVIDER_ID = "hermes";

/** Worker `diagnostics` must not hold the RPC for the host's 30 s default. */
const WORKER_DIAGNOSTICS_TIMEOUT_MS = 5_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // An abort during the check came before this listener: stop now, not after `ms`.
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

const MACHINE_KEY = "machine";
/** kv: machines the Connection moved off whose worker hasn't confirmed `release` yet (offline then). */
const RELEASE_KEY = "release_pending";
const RELEASE_TIMEOUT_MS = 5_000;

function savedMachine(db: Db): string {
  const value = getKv(db, MACHINE_KEY);
  return typeof value === "string" ? value : "";
}

export async function startServer(bb: BbPluginApi, settings: SettingsHandle, db: Db = openMappingDb(bb)): Promise<void> {
  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
  // A P0 db has a machine but no folder for it: it counts as matching, so record the folder now.
  if (savedMachine(db) && machineFolder(db) === null) setKv(db, MACHINE_FOLDER_KEY, (await settings.get()).folder);
  const source: ConnectionSource = {
    get: async () => {
      const { folder, models } = await settings.get();
      return { machine: savedMachine(db), folder, machine_folder: machineFolder(db), models: parseModels(models) };
    },
  };
  let onConnected: OnConnected = () => {};
  const connection = createConnection(bb, source, db, host, (event) => onConnected(event));
  await connection.init();

  const fail = (code: string) => connection.recordError(code);
  const enqueue = createQueue();
  const notify = createNotify(bb, db, fail);
  const deps = { bb, db, host, connection, notify };
  const sync = createSync({ ...deps, enqueue });
  const discovery = createDiscovery({ ...deps, sync });
  const bots = createBots({ ...deps, sync, enqueue, discovery });
  const chats = createChats({ ...deps, describe: bots.describe });
  const run = (code: string, job: () => Promise<void>) => void enqueue(job).catch((error) => fail(errorCode(error, code)));
  /**
   * A job about one thread: one the server deleted itself (an import redo) ends silently, before or during it; so
   * does one bb deleted (a refused spawn), whose reads may fail before its `thread.deleted` comes.
   */
  const runFor = (threadId: string, code: string, job: () => Promise<void>) =>
    run(code, async () => {
      if (sync.gone.has(threadId)) return;
      await job().catch((error) => {
        if (errorCode(error, code) === "thread_not_found") sync.gone.add(threadId);
        if (!sync.gone.has(threadId)) throw error;
      });
    });
  const isHermes = (thread: { providerId: string }) => thread.providerId === PROVIDER_ID;

  /** A thread's turns may be over: settle them (sync). */
  const finalize = (threadId: string) => runFor(threadId, "finalize_failed", () => sync.finalizeNow(threadId, targetOf(connection), bots.isEnabled));

  onConnected = ({ newBoot, reconnected }) =>
    run("connect_reconcile_failed", async () => {
      const target = targetOf(connection);
      if (!target) return;
      if (newBoot) await sync.recoverQueuedNow(finalize);
      await bots.onConnectedNow(target, { newBoot, reconnected });
    });
  // A restart mid-import (review 3): a thread with queued rows keeps its hold until its finalize, and a bot
  // thread's or side chat's import still ends read (a mirrored one is redone anyway).
  for (const b of allBindings(db)) if (b.state === "replaying" && b.kind !== "mirror") sync.readAtIdle.add(b.thread_id);
  // A restart during an init (review-2 6): a held thread whose binding has no session yet keeps its hold and ends
  // read. Finalized now too: its idle may have come before the restart, its confirm lost with it.
  const initing = notify.held().filter((threadId) => {
    const b = bindingByThread(db, threadId);
    return b?.state === "pending" && !b.session_id;
  });
  for (const threadId of initing) sync.readAtIdle.add(threadId);
  void notify.restoreAll((threadId) => initing.includes(threadId) || queuedTurnsOf(db, threadId).length > 0);
  for (const threadId of initing) finalize(threadId);
  // The folder as of the last check (the hook can't await settings).
  bb.experimental_hooks.on("message.dispatch", (context) => {
    const decision = dispatchDecision(context, hermesMachine(db, connection.health().folder));
    // Review 5: the user's own turn behind an init or import pushes as usual, and isn't marked read for them.
    if (decision.action === "proceed" && hasUserMessage(context, bb.pluginId)) {
      sync.dropReadFlag(context.thread.id);
      notify.release(context.thread.id);
    }
    return decision;
  });

  bb.events.on("thread.active", ({ thread }) => {
    if (isHermes(thread)) sync.active.add(thread.id);
  });
  const settled = ({ thread }: { thread: { id: string; providerId: string } }) => {
    if (!isHermes(thread)) return;
    sync.active.delete(thread.id);
    void chats.onIdle(thread.id);
    finalize(thread.id);
  };
  bb.events.on("thread.idle", settled);
  bb.events.on("thread.failed", settled);
  // `persisted-turn` (A37); debounced and cumulative, so the latest state is enough.
  bb.events.on("experimental_thread.events", ({ thread }) => {
    if (isHermes(thread)) runFor(thread.id, "persisted_turn_failed", () => sync.ingestPersistedNow(thread.id));
  });
  // A49: wakes bb refused while the user had it archived run now.
  bb.events.on("thread.unarchived", ({ thread }) => {
    if (!isHermes(thread)) return;
    runFor(thread.id, "wake_failed", async () => {
      // D48: unarchived (by the user while the bot is off, or by the switch-on): the switch no longer owns its
      // archive, so a later user archive stays at the next switch-on (review-2 8).
      if (bindingByThread(db, thread.id)?.archived_by_switch) updateBinding(db, thread.id, { archived_by_switch: false });
      const binding = bindingByThread(db, thread.id);
      const target = targetOf(connection);
      if (binding && target && bots.isEnabled(binding.profile_home)) await sync.reconcileNow(binding, target);
    });
  });
  bb.events.on("thread.created", ({ thread }) => runFor(thread.id, "bind_failed", () => chats.onCreatedNow(thread)));
  bb.events.on("thread.deleted", ({ thread }) => {
    const binding = bindingByThread(db, thread.id);
    if (!binding) return;
    // Q1: a chat bb deleted is never imported again, a side chat's included (a pending one by the id its first
    // send would create). A deleted bot thread is re-created at the next reconcile, bound by title (D44).
    const id = binding.lineage_root ?? binding.expected_id;
    if (binding.kind !== "bot" && id) addTombstone(db, binding.profile_home, id, Date.now());
    deleteBinding(db, thread.id);
    sync.importing.delete(thread.id);
    invalidateThreadInfo(bb);
    if (binding.kind === "bot") bb.realtime.publish(BOTS_CHANNEL, null);
  });

  const changed = new Set<string>();
  let changedTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  bb.onDispose(() => {
    disposed = true;
    clearTimeout(changedTimer);
  });

  const isTarget = (hostId: string) => savedMachine(db) === hostId;
  host.experimental_onSignal("changed", ({ hostId, payload }) => {
    if (!isTarget(hostId)) return;
    for (const home of payload.profile_homes) changed.add(home);
    clearTimeout(changedTimer);
    if (disposed) return;
    changedTimer = setTimeout(() => {
      const homes = [...changed].filter(bots.isEnabled);
      changed.clear();
      run("wake_failed", async () => {
        const target = targetOf(connection);
        if (target) await bots.reconcileAllNow(homes, target);
      });
    }, WAKE_DEBOUNCE_MS);
  });
  host.experimental_onSignal("watch", async ({ hostId }) => {
    if (isTarget(hostId)) await connection.ensureNow();
  });
  host.experimental_onWorkerExit(async ({ hostId }) => {
    if (!isTarget(hostId)) return;
    connection.recordError("worker_exit");
    // The next call starts a fresh worker, which re-arms the watch.
    await connection.ensureNow();
  });
  // A folder saved in bb's settings form keeps the machine (only a folder that moved without a save stops it).
  settings.onChange(async () => {
    setKv(db, MACHINE_FOLDER_KEY, (await settings.get()).folder);
    void connection.ensureNow();
  });

  /**
   * D56: a machine the Connection moved off must stop listing Hermes. Its worker removes `worker.json` (`release`);
   * an offline one is retried at each keep-alive until it answers. Never the current machine.
   */
  const pendingReleases = () => ((getKv(db, RELEASE_KEY) as string[] | null) ?? []).filter((id) => id !== savedMachine(db));
  async function releaseNow(): Promise<void> {
    for (const hostId of pendingReleases()) {
      try {
        await host.call("release", null, { hostId, timeoutMs: RELEASE_TIMEOUT_MS });
      } catch {
        continue; // offline: the next keep-alive retries
      }
      setKv(db, RELEASE_KEY, pendingReleases().filter((id) => id !== hostId));
    }
  }

  bb.background.service("keepalive", {
    async start(signal) {
      while (!signal.aborted) {
        if (pendingReleases().length) await releaseNow().catch((error) => fail(errorCode(error, "release_failed")));
        // Until known, every thread works in its bot's folder (D54).
        if (getKv(db, PERSONAL_PROJECT_KEY) === null) await personalProject(bb, db).catch((error) => fail(errorCode(error, "projects_failed")));
        await connection.ensureNow();
        await sleep(KEEPALIVE_MS, signal);
      }
    },
  });

  bb.rpc.register(rpcContract, {
    health: () => connection.health(),
    async diagnostics(): Promise<Diagnostics> {
      const health = connection.health();
      let worker: Diagnostics["worker"] = null;
      let workerError: string | null = null;
      if (!health.machine?.online) {
        workerError = health.state;
      } else {
        try {
          worker = await host.call("diagnostics", null, { hostId: health.machine.id, timeoutMs: WORKER_DIAGNOSTICS_TIMEOUT_MS });
        } catch (error) {
          workerError = errorCode(error, "worker_diagnostics_failed");
        }
      }
      return {
        plugin_version: pkg.version,
        instance_id: connection.instanceId(),
        health,
        bindings: bindingCounts(db),
        errors: connection.errors(),
        worker,
        worker_error: workerError,
      };
    },
    async setConnection({ machine, folder }) {
      const previous = savedMachine(db);
      setKv(db, MACHINE_KEY, machine);
      if (previous && previous !== machine) {
        setKv(db, RELEASE_KEY, [...new Set([...pendingReleases(), previous])]);
        void releaseNow().catch((error) => fail(errorCode(error, "release_failed")));
      }
      setKv(db, MACHINE_FOLDER_KEY, folder ?? (await settings.get()).folder);
      // A folder change also fires `onChange`; both share one check.
      if (folder !== undefined) await settings.experimental_set({ folder });
      return connection.ensureNow();
    },
    bots: async () => ({ bots: await bots.rows() }),
    setBot: ({ profile_home, on }) => bots.setBot(profile_home, on),
    stopHosted: () => chats.stopHosted(),
    threadInfo: ({ keys }) => chats.threadInfo(keys),
  });
}

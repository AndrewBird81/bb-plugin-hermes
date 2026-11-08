// Host worker (02 §Components, T0.8, T1.7, T1.8): one per bb host daemon process. Kept alive only by the
// server's 60 s `ensureWatch` keep-alive, no lease: the daemon stops a worker after 5 idle minutes.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { buildFromModuleUrl } from "../shared/bridge-registry.js";
import { hostContract, hostSignals } from "../shared/host-contract.js";
import { bbTarget, setBotAccess, writeWrapper, type AccessInput } from "./access.js";
import { readBridgeRecords } from "./bridges.js";
import { findBotChat, listProfileSessions } from "./sessions.js";
import { expandRoot, Watcher, type WatcherOptions } from "./watch.js";

export interface HostEntryOptions extends WatcherOptions {
  /** Tests stub the `refresh-prompts` run and the executable probe. */
  access?: Pick<AccessInput, "refresh" | "exists">;
}

export function createHostEntry(opts: HostEntryOptions = {}) {
  const watcher = new Watcher(opts);
  const startedAt = Date.now();
  let lifecycleBound = false;
  const bindLifecycle = (signal: AbortSignal) => {
    if (lifecycleBound) return;
    lifecycleBound = true;
    signal.addEventListener("abort", () => watcher.close(), { once: true });
  };

  return experimental_defineHostEntry({
    contract: hostContract,
    experimental_signals: hostSignals,
    handlers: {
      ensureWatch: async ({ root, enabled_bots }, context) => {
        bindLifecycle(context.lifecycle.signal);
        // The daemon's environment for this call only (A44): read before any await.
        const target = bbTarget(process.env, opts.access?.exists);
        watcher.emit = (payload) => context.experimental_emitSignal("watch", payload);
        watcher.emitChanged = (payload) => context.experimental_emitSignal("changed", payload);
        const dataDir = context.experimental_paths.dataDir;
        // The wrapper follows bb when it moves (an update, a new server URL) while any bot is on.
        if (enabled_bots.length && target) await writeWrapper(dataDir, target).catch(() => {});
        return watcher.ensure(root, context.signal, { enabledBots: enabled_bots, dataDir });
      },
      describe: async ({ root }, context) => {
        bindLifecycle(context.lifecycle.signal);
        return { uid: process.getuid?.() ?? -1, profiles: await watcher.describe(root, context.signal) };
      },
      diagnostics: async (_input, context) => ({
        pid: process.pid,
        started_at: startedAt,
        worker_boot_id: watcher.bootId,
        build: buildFromModuleUrl(import.meta.url),
        watch: { root: watcher.root, state: watcher.state, instance_id: watcher.instanceId, since: watcher.since, last_error: watcher.lastError },
        version: watcher.version,
        bridges: await readBridgeRecords(context.experimental_paths.dataDir),
      }),
      models: async ({ root, profile_home }, context) => {
        bindLifecycle(context.lifecycle.signal);
        await watcher.ensure(root, context.signal);
        return watcher.models.get(profile_home, opts.modelsWaitMs);
      },
      listSessions: async ({ root, profile_home, since }, context) => {
        bindLifecycle(context.lifecycle.signal);
        await watcher.ensure(root, context.signal);
        return { sessions: await listProfileSessions(expandRoot(root), watcher.profileName(profile_home), since) };
      },
      readTurns: () => notYet("T1.7"),
      findBotChat: async ({ root, profile_home }, context) => {
        bindLifecycle(context.lifecycle.signal);
        await watcher.ensure(root, context.signal);
        return findBotChat(watcher.client(), watcher.profileName(profile_home));
      },
      setBotAccess: async ({ root, profile_home, on, enabled_bots }, context) => {
        const env = { ...process.env };
        return setBotAccess({ rootHome: expandRoot(root), profileHome: profile_home, on, enabledBots: enabled_bots, dataDir: context.experimental_paths.dataDir, env, ...opts.access });
      },
    },
    dispose: () => watcher.close(),
  });
}

function notYet(task: string): never {
  throw new Error(`not_implemented:${task}`);
}

export default createHostEntry();

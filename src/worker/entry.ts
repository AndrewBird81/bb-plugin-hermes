// Host worker (02 §Components, T0.8): one per bb host daemon process. P0 keeps it alive only through the
// server's 60 s `ensureWatch` keep-alive, no lease: the daemon stops a worker after 5 idle minutes.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { buildFromModuleUrl } from "../shared/bridge-registry.js";
import { hostContract, hostSignals } from "../shared/host-contract.js";
import { readBridgeRecords } from "./bridges.js";
import { Watcher, type WatcherOptions } from "./watch.js";

export function createHostEntry(opts: WatcherOptions = {}) {
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
      ensureWatch: ({ root }, context) => {
        // `enabled_bots` drives the change watch and wakes: P1.
        bindLifecycle(context.lifecycle.signal);
        watcher.emit = (payload) => context.experimental_emitSignal("watch", payload);
        return watcher.ensure(root, context.signal);
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
    },
    dispose: () => watcher.close(),
  });
}

export default createHostEntry();

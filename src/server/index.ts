// Server part (server seam): mapping db, keep-alive, health, diagnostics RPC (T0.6, T0.9).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import pkg from "../../package.json" with { type: "json" };
import { hostContract, hostSignals } from "../shared/host-contract.js";
import { rpcContract, type Diagnostics } from "../shared/rpc-contract.js";
import type { SettingsHandle } from "../shared/settings.js";
import { type ConnectionSource, createConnection, errorCode, KEEPALIVE_MS } from "./connection.js";
import { bindingCounts, type Db, getKv, openMappingDb, setKv } from "./db.js";

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

function savedMachine(db: Db): string {
  const value = getKv(db, MACHINE_KEY);
  return typeof value === "string" ? value : "";
}

export async function startServer(bb: BbPluginApi, settings: SettingsHandle, db: Db = openMappingDb(bb)): Promise<void> {
  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
  const source: ConnectionSource = { get: async () => ({ machine: savedMachine(db), folder: (await settings.get()).folder }) };
  const connection = createConnection(bb, source, db, host);
  await connection.init();

  const isTarget = (hostId: string) => savedMachine(db) === hostId;
  host.experimental_onSignal("watch", async ({ hostId }) => {
    if (isTarget(hostId)) await connection.ensureNow();
  });
  host.experimental_onWorkerExit(async ({ hostId }) => {
    if (!isTarget(hostId)) return;
    connection.recordError("worker_exit");
    // The next call starts a fresh worker, which re-arms the watch.
    await connection.ensureNow();
  });
  settings.onChange(() => void connection.ensureNow());

  bb.background.service("keepalive", {
    async start(signal) {
      while (!signal.aborted) {
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
      setKv(db, MACHINE_KEY, machine);
      // A folder change also fires `onChange`; both share one check.
      if (folder !== undefined) await settings.experimental_set({ folder });
      return connection.ensureNow();
    },
    // P1 seam stubs (lead): the server seam replaces them (T1.9, T1.10, T1.12).
    bots: () => notYet("T1.9"),
    setBot: () => notYet("T1.9"),
    newChat: () => notYet("T1.10"),
    stopHosted: () => notYet("T1.10"),
    threadInfo: ({ keys }) => Object.fromEntries(keys.map((key) => [key, null])),
  });
}

function notYet(task: string): never {
  throw new Error(`not_implemented:${task}`);
}

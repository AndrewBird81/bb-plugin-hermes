// Keep-alive and health (T0.9, 01 §1): `ensureWatch` on the Hermes machine every 60 s and at once on
// a change, since an idle worker dies at 300 s with no exit event (S7 §6). Ids and bounded codes only.
import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import type { EnsureWatchOutput, HostContract, hostSignals } from "../shared/host-contract.js";
import { HEALTH_CHANNEL, type Health, type HealthState } from "../shared/rpc-contract.js";
import type { ConnectionSettings } from "../shared/settings.js";
import { enabledBots, getKv, setKv, type Db } from "./db.js";
import { MACHINE_NAME_KEY, machineName } from "./provider-options.js";

export const KEEPALIVE_MS = 60_000;
const ERROR_RING = 20;

export type HostClient = ExperimentalHostClient<HostContract, typeof hostSignals>;

const bounded = (code: unknown) => (typeof code === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : null);

/**
 * A bounded code for logs, health and diagnostics: an error's own short code, never its message. bb's API errors
 * keep theirs in `body.code`. A host worker's own error reaches the server as bb's `command_failed` with only its
 * message (bb's plugin host worker sends no code): the worker's code that message starts with
 * (`history_http_404:…`, `not_connected:…`), never the rest.
 */
export function errorCode(error: unknown, fallback: string): string {
  const e = error as { code?: unknown; body?: { code?: unknown } | null; message?: unknown; name?: unknown } | null;
  const code = bounded(e?.code) ?? bounded(e?.body?.code);
  if (code === "command_failed") return (typeof e?.message === "string" ? /^[a-z]+(?:_[a-z0-9]+)+/.exec(e.message)?.[0] : undefined) ?? fallback;
  if (code) return code;
  if (e?.name === "AbortError") return "aborted";
  return fallback;
}

function healthFrom(settings: ConnectionSettings, patch: Partial<Health> & { state: HealthState }): Health {
  return {
    machine: settings.machine ? { id: settings.machine, name: null, online: false } : null,
    folder: settings.folder,
    connected: false,
    version: null,
    supported: null,
    detail: null,
    worker_last_seen_at: null,
    ...patch,
  };
}

/** Change detection ignores `worker_last_seen_at`: it moves every keep-alive; the app reads it on refetch. */
const sameHealth = (a: Health, b: Health): boolean => JSON.stringify({ ...a, worker_last_seen_at: 0 }) === JSON.stringify({ ...b, worker_last_seen_at: 0 });

/** The machine (mapping db `kv`) and the folder (`bb.settings`), read at each check. */
export interface ConnectionSource {
  /** `machine_folder`: the folder the machine was set with (null: a P0 db, taken as matching). */
  get(): Promise<ConnectionSettings & { machine_folder: string | null }>;
}

/**
 * After each answer from a working gateway: `newBoot` (a new `worker_boot_id`, also the first one this
 * server sees) → full reconcile (flow 9); `reconnected` (not connected before) → reconcile (flow 10).
 */
export type OnConnected = (event: { machine: string; folder: string; newBoot: boolean; reconnected: boolean }) => void;

const working = (state: HealthState) => state === "connected" || state === "not_supported";

export function createConnection(bb: BbPluginApi, settings: ConnectionSource, db: Db, host: HostClient, onConnected: OnConnected = () => {}) {
  let health: Health = healthFrom({ machine: "", folder: "" }, { state: "not_configured" });
  /** The worker's last answer, for the current target only. */
  let answer: EnsureWatchOutput | null = null;
  const errors: string[] = [];

  function recordError(code: string): void {
    errors.push(code);
    if (errors.length > ERROR_RING) errors.shift();
    bb.log.warn(`error ${code}`);
  }

  function publish(next: Health): Health {
    const changed = !sameHealth(health, next);
    health = next;
    if (changed) {
      bb.log.info(`health ${next.state}${next.detail ? ` (${next.detail})` : ""}`);
      bb.realtime.publish(HEALTH_CHANNEL, next);
    }
    return next;
  }

  /** True for a boot id this server hasn't recorded. */
  function noteBoot(output: EnsureWatchOutput): boolean {
    if (getKv(db, "worker_boot_id") === output.worker_boot_id) return false;
    setKv(db, "worker_boot_id", output.worker_boot_id);
    bb.log.info(`worker boot ${output.worker_boot_id}`);
    return true;
  }
  /** Each server start reconciles once at its first working answer (boot recovery, flow 9). */
  let seenBoot = false;

  /** No worker answer for this target: drop the old one, so `diagnostics` never shows a stale `instance_id`. */
  function unanswered(next: Health): Health {
    answer = null;
    return publish(next);
  }

  async function check(): Promise<Health> {
    const current = await settings.get();
    // Unset machine: no Hermes I/O at all (01 §1 AC, R3 M3).
    if (!current.machine) return unanswered(healthFrom(current, { state: "not_configured" }));
    // The folder moved without `setConnection` (e.g. a reinstall reset settings, but data.db kept the
    // machine): never dial the default folder on the old machine (R8). No Hermes I/O until set again.
    if (current.machine_folder !== null && current.machine_folder !== current.folder)
      return unanswered(healthFrom(current, { state: "not_configured", detail: "folder_changed" }));

    let machine: Health["machine"];
    try {
      const listed = (await bb.sdk.hosts.list()).find((h) => h.id === current.machine);
      machine = { id: current.machine, name: listed?.name ?? null, online: listed?.status === "connected" };
      // For "Start the thread on <machine>" (bridges and the dispatch hook read it synchronously).
      if (listed?.name && machineName(db, current.machine) !== listed.name) setKv(db, MACHINE_NAME_KEY, { id: current.machine, name: listed.name });
    } catch (error) {
      const code = errorCode(error, "hosts_list_failed");
      recordError(code);
      return unanswered(healthFrom(current, { state: "disconnected", detail: code }));
    }
    if (!machine.online) return unanswered(healthFrom(current, { state: "machine_offline", machine }));

    // `connecting` only for a new target: a failing one stays `disconnected` between retries.
    const fresh = health.machine?.id !== current.machine || health.folder !== current.folder || health.state === "not_configured" || health.state === "machine_offline";
    if (fresh) unanswered(healthFrom(current, { state: "connecting", machine }));
    try {
      const enabled = enabledBots(db).map((b) => b.profile_home);
      const output = await host.call("ensureWatch", { root: current.folder, enabled_bots: enabled }, { hostId: current.machine });
      answer = output;
      const newBoot = noteBoot(output);
      const state: HealthState = !output.connected ? "disconnected" : output.supported === false ? "not_supported" : "connected";
      const reconnected = !working(health.state) || health.machine?.id !== current.machine || health.folder !== current.folder;
      const next = publish(
        healthFrom(current, {
          state,
          machine,
          connected: output.connected,
          version: output.version,
          supported: output.supported,
          detail: output.detail,
          worker_last_seen_at: Date.now(),
        }),
      );
      if (working(state)) {
        onConnected({ machine: current.machine, folder: current.folder, newBoot: newBoot || !seenBoot, reconnected });
        seenBoot = true;
      }
      return next;
    } catch (error) {
      const code = errorCode(error, "host_call_failed");
      recordError(code);
      return unanswered(healthFrom(current, { state: "disconnected", machine, detail: code }));
    }
  }

  // One check at a time; calls made while one waits to start share it.
  let tail: Promise<unknown> = Promise.resolve();
  let waiting: Promise<Health> | null = null;
  function ensureNow(): Promise<Health> {
    if (waiting) return waiting;
    const run = tail.then(() => {
      waiting = null;
      return check();
    });
    waiting = run;
    tail = run.catch(() => undefined);
    return run;
  }

  return {
    ensureNow,
    recordError,
    health: (): Health => health,
    /** The gateway's `instance_id` from the worker's last answer. */
    instanceId: (): string | null => answer?.instance_id ?? null,
    errors: (): string[] => [...errors],
    /** Seed health from settings before the first check, so `health` never reports a stale target. */
    async init(): Promise<void> {
      const current = await settings.get();
      health = healthFrom(current, { state: current.machine ? "connecting" : "not_configured" });
    },
  };
}

export type Connection = ReturnType<typeof createConnection>;

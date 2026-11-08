import { createFakePluginHost, makeHostResponse, type ExperimentalFakeHostRpcCall } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import type { EnsureWatchOutput, WorkerDiagnostics } from "../shared/host-contract.js";
import { HEALTH_CHANNEL, type Diagnostics, type Health } from "../shared/rpc-contract.js";
import { settingsDescriptors } from "../shared/settings.js";
import { KEEPALIVE_MS } from "./connection.js";
import { getKv, insertBinding, openMappingDb, setKv } from "./db.js";
import { startServer } from "./index.js";

const MACHINE = "host_hermes";

const answer = (over: Partial<EnsureWatchOutput> = {}): EnsureWatchOutput => ({
  worker_boot_id: "boot_1",
  connected: true,
  instance_id: "inst_fake",
  version: "0.9.0",
  supported: true,
  detail: null,
  ...over,
});

const workerDiagnostics: WorkerDiagnostics = {
  pid: 42,
  started_at: 1,
  worker_boot_id: "boot_1",
  build: "dev",
  watch: { root: "~/.hermes", state: "connected", instance_id: "inst_fake", since: 1, last_error: null },
  version: { version: "0.9.0", supported: true, missing: [], checked_at: 1 },
  bridges: [],
};

interface Setup {
  /** The saved machine (`kv`). */
  machine?: string;
  online?: boolean;
  host?: (call: ExperimentalFakeHostRpcCall) => unknown;
}

async function setup({ machine = MACHINE, online = true, host = () => answer() }: Setup = {}) {
  const hosts = { online };
  const fake = createFakePluginHost({
    pluginId: "hermes",
    sdk: { hosts: { list: async () => [makeHostResponse({ id: MACHINE, name: "hermes-mac", status: hosts.online ? "connected" : "disconnected" })] } },
    experimental_callHostRpc: (call) => host(call),
  });
  if (machine) setKv(openMappingDb(fake.bb), "machine", machine);
  const settings = fake.bb.settings.define(settingsDescriptors);
  await startServer(fake.bb, settings);
  const { harness } = fake;
  return {
    ...fake,
    hosts,
    rpc: <T>(method: string, input: unknown = null) => harness.behavior.callRpc(method, input) as Promise<T>,
    ensureCalls: () => harness.inspection.experimental_hostRpcCalls.filter((c) => c.method === "ensureWatch"),
    healthSignals: () => harness.inspection.realtimeSignals.filter((s) => s.channel === HEALTH_CHANNEL).map((s) => (s.payload as Health).state),
  };
}

afterEach(() => vi.useRealTimers());

describe("keep-alive and health", () => {
  it("unset machine: 0 host calls, not_configured", async () => {
    const t = await setup({ machine: "" });
    expect((await t.rpc<Health>("health")).state).toBe("not_configured");
    const svc = t.harness.behavior.runService("keepalive");
    await vi.waitFor(() => expect(t.healthSignals()).toEqual([]));
    const diag = await t.rpc<Diagnostics>("diagnostics");
    expect(diag).toMatchObject({ worker: null, worker_error: "not_configured", instance_id: null });
    expect(t.harness.inspection.experimental_hostRpcCalls).toEqual([]);
    svc.controller.abort();
    await svc.done;
  });

  it("calls ensureWatch at once and every 60 s; a good answer is connected", async () => {
    vi.useFakeTimers();
    const t = await setup();
    expect((await t.rpc<Health>("health")).state).toBe("connecting");
    const svc = t.harness.behavior.runService("keepalive");
    await vi.waitFor(() => expect(t.ensureCalls()).toHaveLength(1));
    expect(t.ensureCalls()[0]).toMatchObject({ hostId: MACHINE, input: { root: "~/.hermes", enabled_bots: [] } });
    const health = await t.rpc<Health>("health");
    expect(health).toMatchObject({
      state: "connected",
      machine: { id: MACHINE, name: "hermes-mac", online: true },
      folder: "~/.hermes",
      connected: true,
      version: "0.9.0",
      supported: true,
      detail: null,
    });
    expect(health.worker_last_seen_at).toEqual(expect.any(Number));

    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    expect(t.ensureCalls()).toHaveLength(2);
    // Unchanged health is not re-published.
    expect(t.healthSignals()).toEqual(["connected"]);
    svc.controller.abort();
    await svc.done;
  });

  it("supported:false → not_supported", async () => {
    const t = await setup({ host: () => answer({ supported: false, detail: "missing:2" }) });
    const health = await t.rpc<Health>("setConnection", { machine: MACHINE });
    expect(health).toMatchObject({ state: "not_supported", supported: false, detail: "missing:2", connected: true });
  });

  it("supported:null (no contract file) stays connected", async () => {
    const t = await setup({ host: () => answer({ supported: null }) });
    expect((await t.rpc<Health>("setConnection", { machine: MACHINE })).state).toBe("connected");
  });

  it("worker without a gateway → disconnected with its detail", async () => {
    const t = await setup({ host: () => answer({ connected: false, instance_id: null, version: null, supported: null, detail: "no_gateway" }) });
    expect(await t.rpc<Health>("setConnection", { machine: MACHINE })).toMatchObject({ state: "disconnected", detail: "no_gateway" });
  });

  it("host call failure → disconnected with a bounded detail, recorded in diagnostics", async () => {
    const t = await setup({
      host: () => {
        throw new Error("spawn failed at /private/tmp/secret/path");
      },
    });
    const health = await t.rpc<Health>("setConnection", { machine: MACHINE });
    expect(health).toMatchObject({ state: "disconnected", detail: "host_call_failed", connected: false });
    const diag = await t.rpc<Diagnostics>("diagnostics");
    expect(diag.errors).toEqual(["host_call_failed"]);
    expect(diag.worker_error).toBe("worker_diagnostics_failed");
    expect(JSON.stringify(diag)).not.toContain("/private/tmp");
    expect(t.harness.inspection.logEntries.map((e) => e.message).join("\n")).not.toContain("/private/tmp");
  });

  it("machine not connected in bb → machine_offline, no host call", async () => {
    const t = await setup({ online: false });
    expect(await t.rpc<Health>("setConnection", { machine: MACHINE })).toMatchObject({
      state: "machine_offline",
      machine: { id: MACHINE, name: "hermes-mac", online: false },
    });
    expect((await t.rpc<Diagnostics>("diagnostics")).worker_error).toBe("machine_offline");
    expect(t.harness.inspection.experimental_hostRpcCalls).toEqual([]);
  });

  it("an unknown machine id is offline too", async () => {
    const t = await setup();
    expect(await t.rpc<Health>("setConnection", { machine: "host_gone" })).toMatchObject({
      state: "machine_offline",
      machine: { id: "host_gone", name: null, online: false },
    });
    expect(t.harness.inspection.experimental_hostRpcCalls).toEqual([]);
  });

  it("records a new worker_boot_id in kv", async () => {
    let boot = "boot_1";
    const t = await setup({ host: () => answer({ worker_boot_id: boot }) });
    const db = openMappingDb(t.bb);
    await t.rpc("setConnection", { machine: MACHINE });
    expect(getKv(db, "worker_boot_id")).toBe("boot_1");
    boot = "boot_2";
    await t.rpc("setConnection", { machine: MACHINE });
    expect(getKv(db, "worker_boot_id")).toBe("boot_2");
    expect(t.harness.inspection.logEntries.filter((e) => e.message.startsWith("worker boot")).map((e) => e.message)).toEqual([
      "worker boot boot_1",
      "worker boot boot_2",
    ]);
  });

  it("setConnection persists machine and folder and re-checks at once", async () => {
    const t = await setup({ machine: "" });
    const health = await t.rpc<Health>("setConnection", { machine: MACHINE, folder: "/private/tmp/bb-hermes-test/home" });
    expect(health).toMatchObject({ state: "connected", folder: "/private/tmp/bb-hermes-test/home" });
    expect(t.ensureCalls().at(-1)?.input).toEqual({ root: "/private/tmp/bb-hermes-test/home", enabled_bots: [] });
    // Back to unset: no further host call.
    const calls = t.ensureCalls().length;
    expect((await t.rpc<Health>("setConnection", { machine: "" })).state).toBe("not_configured");
    expect(t.ensureCalls()).toHaveLength(calls);
    await expect(t.rpc("setConnection", { machine: "a b" })).rejects.toThrow();
  });

  it("a folder save in bb's settings form re-checks at once", async () => {
    const t = await setup();
    await t.rpc("setConnection", { machine: MACHINE });
    await t.harness.behavior.setSettings({ folder: "/private/tmp/bb-hermes-test/other" });
    await vi.waitFor(() => expect(t.ensureCalls().at(-1)?.input).toEqual({ root: "/private/tmp/bb-hermes-test/other", enabled_bots: [] }));
  });

  it("the machine is saved in kv, not in bb's settings", async () => {
    const t = await setup({ machine: "" });
    await t.rpc("setConnection", { machine: MACHINE });
    expect(getKv(openMappingDb(t.bb), "machine")).toBe(MACHINE);
    expect((await t.rpc<Health>("setConnection", { machine: "" })).state).toBe("not_configured");
    expect(getKv(openMappingDb(t.bb), "machine")).toBe("");
  });

  it("an abort during a check stops the keep-alive at once, not after 60 s", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const t = await setup({ host: async () => (await pending, answer()) });
    const svc = t.harness.behavior.runService("keepalive");
    await vi.waitFor(() => expect(t.ensureCalls()).toHaveLength(1));
    svc.controller.abort();
    release();
    await svc.done;
  });

  it("publishes health on every change", async () => {
    let connected = true;
    const t = await setup({ host: () => answer({ connected, detail: connected ? null : "no_gateway" }) });
    await t.rpc("setConnection", { machine: MACHINE });
    connected = false;
    await t.rpc("setConnection", { machine: MACHINE });
    await t.rpc("setConnection", { machine: MACHINE });
    t.hosts.online = false;
    await t.rpc("setConnection", { machine: MACHINE });
    expect(t.healthSignals()).toEqual(["connected", "disconnected", "machine_offline"]);
    const last = t.harness.inspection.realtimeSignals.at(-1)?.payload as Health;
    expect(last).toEqual(await t.rpc<Health>("health"));
  });

  it("a watch signal or worker exit on the machine re-ensures; other hosts are ignored", async () => {
    const t = await setup();
    await t.rpc("setConnection", { machine: MACHINE });
    const watch = { state: "disconnected", worker_boot_id: "boot_1", instance_id: null };
    await t.harness.behavior.experimental_emitHostSignal("host_other", "watch", watch);
    expect(t.ensureCalls()).toHaveLength(1);
    await t.harness.behavior.experimental_emitHostSignal(MACHINE, "watch", watch);
    expect(t.ensureCalls()).toHaveLength(2);
    await t.harness.behavior.experimental_emitHostWorkerExit(MACHINE);
    expect(t.ensureCalls()).toHaveLength(3);
    expect((await t.rpc<Diagnostics>("diagnostics")).errors).toEqual(["worker_exit"]);
  });
});

describe("diagnostics", () => {
  it("reports version, instance, bindings, errors and the worker", async () => {
    const t = await setup({ host: (call) => (call.method === "diagnostics" ? workerDiagnostics : answer()) });
    insertBinding(openMappingDb(t.bb), {
      thread_id: "thr_1",
      profile_home: "/h",
      lineage_root: "root_1",
      session_id: null,
      expected_id: null,
      kind: "chat",
      source: null,
      tag: null,
      state: "live",
      legacy: false,
      archived_by_switch: false,
      title_set: null,
    });
    await t.rpc("setConnection", { machine: MACHINE });
    expect(await t.rpc<Diagnostics>("diagnostics")).toMatchObject({
      plugin_version: pkg.version,
      instance_id: "inst_fake",
      health: { state: "connected" },
      bindings: { total: 1, duplicates: 0 },
      errors: [],
      worker: workerDiagnostics,
      worker_error: null,
    });
  });

  it("a failing worker diagnostics call → worker_error", async () => {
    const t = await setup({
      host: (call) => {
        if (call.method === "diagnostics") throw Object.assign(new Error("boom"), { code: "timeout" });
        return answer();
      },
    });
    await t.rpc("setConnection", { machine: MACHINE });
    expect(await t.rpc<Diagnostics>("diagnostics")).toMatchObject({ worker: null, worker_error: "timeout", instance_id: "inst_fake" });
  });
});

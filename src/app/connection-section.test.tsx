// @vitest-environment jsdom
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HEALTH_CHANNEL, rpcContract, type Health, type HealthState, type RpcContract } from "../shared/rpc-contract.js";
import { DEFAULT_FOLDER } from "../shared/settings.js";

const app = await loadPluginApp(() => import("../../app.js"));
const section = app.settingsSections.find((s) => s.id === "connection")!;

function host(id: string, name: string, status: "connected" | "disconnected") {
  return {
    id,
    name,
    status,
    type: "persistent" as const,
    createdAt: 0,
    updatedAt: 0,
    lastSeenAt: null,
    lastRejectedProtocolVersion: null,
    lifecycle: { phase: "active" as const, message: null, pendingLog: "", suspendedAt: null, teardown: null },
    machineProviderId: null,
    maxPermissionMode: "full" as const,
  };
}
const hosts = [host("host_a", "studio", "connected"), host("host_b", "laptop", "disconnected")];

function health(state: HealthState, extra: Partial<Health> = {}): Health {
  const configured = state !== "not_configured";
  return {
    state,
    machine: configured ? { id: "host_a", name: "studio", online: state !== "machine_offline" } : null,
    folder: DEFAULT_FOLDER,
    connected: state === "connected" || state === "not_supported",
    version: null,
    supported: null,
    detail: null,
    worker_last_seen_at: null,
    ...extra,
  };
}

function render<M extends keyof RpcContract>(rpc: PluginRpcTestHandlers<Pick<RpcContract, M>>) {
  return renderSlot<object, Pick<RpcContract, M>>(section, {}, {
    rpc,
    experimental_rpcContract: rpcContract,
    settings: { folder: DEFAULT_FOLDER },
    sdk: { hosts: { list: async () => hosts } },
  });
}

describe("settings section", () => {
  afterEach(cleanup);

  it("registers Connection, then Bots", () => {
    expect(app.settingsSections.map((s) => s.id)).toEqual(["connection", "bots"]);
  });

  it.each<[HealthState, Partial<Health>, string]>([
    ["not_configured", {}, "Not connected: pick the Hermes machine."],
    ["machine_offline", {}, "Not connected: studio is offline."],
    ["connecting", {}, "Connecting to Hermes on studio…"],
    ["disconnected", { detail: "gateway_unreachable" }, "Not connected to Hermes on studio: gateway_unreachable."],
    ["connected", { version: "0.9.1", supported: true }, "Connected to Hermes 0.9.1 on studio: supported."],
    ["connected", { version: "0.9.1", supported: null }, "Connected to Hermes 0.9.1 on studio: version unknown."],
    [
      "not_supported",
      { version: "0.10.0", supported: false },
      "Connected to Hermes 0.10.0 on studio: not supported. Mirroring and import pause; chats from bb keep working.",
    ],
  ])("%s renders its health text", async (state, extra, text) => {
    const slot = render({ health: () => health(state, extra) });
    expect(await slot.findByText(text)).toBeTruthy();
  });

  it("shows when the worker was last seen", async () => {
    const at = Date.UTC(2026, 10, 8, 12);
    const slot = render({ health: () => health("connected", { worker_last_seen_at: at }) });
    expect(await slot.findByText(`Worker last seen ${new Date(at).toLocaleString()}.`)).toBeTruthy();
  });

  it("lists bb machines and Not connected", async () => {
    const slot = render({ health: () => health("not_configured") });
    await slot.findByRole("option", { name: "studio" });
    const options = slot.getAllByRole("option").map((o) => [o.getAttribute("value"), o.textContent]);
    expect(options).toEqual([
      ["", "Not connected"],
      ["host_a", "studio"],
      ["host_b", "laptop (offline)"],
    ]);
  });

  it("Save calls setConnection with the picked machine", async () => {
    const slot = render({
      health: () => health("not_configured"),
      setConnection: () => health("connected", { version: "0.9.1", supported: true }),
    });
    await slot.findByRole("option", { name: "studio" });
    fireEvent.change(slot.getByLabelText("Hermes machine"), { target: { value: "host_a" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    expect(await slot.findByText("Connected to Hermes 0.9.1 on studio: supported.")).toBeTruthy();
    expect(slot.inspection.rpcCalls.filter((c) => c.method === "setConnection")).toEqual([
      { method: "setConnection", input: { machine: "host_a" } },
    ]);
  });

  it("starts from the saved machine and has no folder field (bb's settings form holds it)", async () => {
    const slot = render({ health: () => health("connecting", { machine: { id: "host_b", name: "laptop", online: true } }) });
    await slot.findByRole("option", { name: "studio" });
    await waitFor(() => expect((slot.getByLabelText("Hermes machine") as HTMLSelectElement).value).toBe("host_b"));
    expect(slot.queryByLabelText("Hermes folder")).toBeNull();
  });

  it("shows a server error from setConnection", async () => {
    const slot = render({
      health: () => health("not_configured"),
      setConnection: () => {
        throw new Error("That machine isn't a bb host.");
      },
    });
    await slot.findByRole("option", { name: "studio" });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    expect((await slot.findByRole("alert")).textContent).toBe("That machine isn't a bb host.");
  });

  it("refetches health on the realtime signal", async () => {
    let state: HealthState = "connecting";
    const slot = render({ health: () => health(state, { version: "0.9.1", supported: true }) });
    await slot.findByText("Connecting to Hermes on studio…");
    state = "connected";
    await slot.behavior.emitRealtime(HEALTH_CHANNEL, null);
    expect(await slot.findByText("Connected to Hermes 0.9.1 on studio: supported.")).toBeTruthy();
    expect(slot.inspection.rpcCalls.filter((c) => c.method === "health")).toHaveLength(2);
  });

  it("refetches health when the realtime connection comes back", async () => {
    let state: HealthState = "connected";
    const slot = render({ health: () => health(state) });
    await slot.findByText("Connected to Hermes on studio: version unknown.");
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    state = "machine_offline";
    await slot.behavior.setRealtimeConnectionState("connected");
    expect(await slot.findByText("Not connected: studio is offline.")).toBeTruthy();
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((c) => c.method === "health")).toHaveLength(2));
  });
});

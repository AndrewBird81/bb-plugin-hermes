// @vitest-environment jsdom
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EXTENSION_KINDS, type StatusState } from "../shared/extension-state.js";
import { HEALTH_CHANNEL, rpcContract, type HealthState, type RpcContract, type ThreadInfo } from "../shared/rpc-contract.js";
import { health, info, loadApp } from "./test-fixtures.js";

const app = await loadApp();
const customization = app.composerCustomizations.find((c) => c.id === "hermes-thread")!;
const banner = (id: string) => customization.banners!.find((b) => b.id === id)!;

function render<M extends keyof RpcContract>(
  id: string,
  rpc: PluginRpcTestHandlers<Pick<RpcContract, M>>,
  status: StatusState | null = null,
) {
  return renderSlot<object, Pick<RpcContract, M>>(banner(id), {}, {
    rpc,
    experimental_rpcContract: rpcContract,
    composer: { scope: { kind: "thread", threadId: "thr_neo" } },
    threadExtensionStates: status === null ? {} : { thr_neo: { [EXTENSION_KINDS.status]: status } },
  });
}

// Every key answers; null = not a Hermes thread.
const answer = (row: ThreadInfo | null) => ({ keys }: { keys: string[] }) =>
  Object.fromEntries(keys.map((id) => [id, row]));
const hermesThread = answer(info("bot"));

describe("thread banners", () => {
  afterEach(cleanup);

  it("thread composers only: status, then offline", () => {
    expect(customization.scopes).toEqual(["thread"]);
    expect(customization.banners!.map((b) => b.id)).toEqual(["status", "offline"]);
  });

  it("reads the bridge's state by its local kind name, status", () => {
    expect(EXTENSION_KINDS.status).toBe("status");
  });

  it.each<[StatusState["banner"], string]>([
    [{ kind: "held" }, "Open in another Hermes app: sends when it's free"],
    [{ kind: "running_elsewhere" }, "Running outside bb"],
  ])("status %j shows its text", async (state, text) => {
    const slot = render("status", {}, { banner: state, since: 1 });
    expect(slot.container.textContent).toBe(text);
  });

  it("no status, a cleared one, or an invalid one: nothing", () => {
    expect(render("status", {}).container.textContent).toBe("");
    cleanup();
    expect(render("status", {}, { banner: null, since: null }).container.textContent).toBe("");
    cleanup();
    expect(render("status", {}, { banner: { kind: "nope" }, since: 1 } as unknown as StatusState).container.textContent).toBe("");
  });

  it("offline banner while health is machine_offline", async () => {
    const slot = render("offline", { threadInfo: hermesThread, health: () => health("machine_offline") });
    expect(await slot.findByText("studio is offline: sends wait until it reconnects")).toBeTruthy();
  });

  it.each<HealthState>(["connected", "connecting", "disconnected", "not_supported"])("no offline banner while %s", async (state) => {
    const slot = render("offline", { threadInfo: hermesThread, health: () => health(state) });
    await waitFor(() => expect(slot.inspection.rpcCalls.some((c) => c.method === "health")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(slot.container.textContent).toBe("");
  });

  it("no offline banner, and no health read, on a non-Hermes thread", async () => {
    const slot = render("offline", { threadInfo: answer(null), health: () => health("machine_offline") });
    await waitFor(() => expect(slot.inspection.rpcCalls.some((c) => c.method === "threadInfo")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(slot.container.textContent).toBe("");
    expect(slot.inspection.rpcCalls.some((c) => c.method === "health")).toBe(false);
  });

  it("follows health on HEALTH_CHANNEL; an unnamed machine reads The Hermes machine", async () => {
    let state: HealthState = "connected";
    const slot = render("offline", { threadInfo: hermesThread, health: () => health(state, null) });
    await waitFor(() => expect(slot.inspection.rpcCalls.some((c) => c.method === "health")).toBe(true));
    state = "machine_offline";
    await slot.behavior.emitRealtime(HEALTH_CHANNEL, null);
    expect(await slot.findByText("The Hermes machine is offline: sends wait until it reconnects")).toBeTruthy();
    state = "connected";
    await slot.behavior.emitRealtime(HEALTH_CHANNEL, null);
    await waitFor(() => expect(slot.container.textContent).toBe(""));
  });
});

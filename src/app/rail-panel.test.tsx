// @vitest-environment jsdom
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BOTS_CHANNEL, rpcContract, type RpcContract } from "../shared/rpc-contract.js";
import { bot, loadApp, thread } from "./test-fixtures.js";

const app = await loadApp();
const panel = app.navPanels[0]!;

function render<M extends keyof RpcContract>(rpc: PluginRpcTestHandlers<Pick<RpcContract, M>>, unread: string[] = []) {
  return renderSlot<{ subPath: string }, Pick<RpcContract, M>>(panel, { subPath: "" }, {
    rpc,
    experimental_rpcContract: rpcContract,
    sidebarThreads: { status: "ready", threads: unread.map((id) => thread(id, { isUnread: true })) },
  });
}

describe("rail panel", () => {
  afterEach(cleanup);

  it("registers Hermes with the Hermes icon", () => {
    expect(app.navPanels.map((p) => [p.id, p.title, p.icon, p.path])).toEqual([["hermes", "Hermes", "hermes", "hermes"]]);
    expect(app.icons.map((i) => i.name)).toEqual(["hermes"]);
  });

  it("lists enabled bots only, each with New chat", async () => {
    const slot = render({
      bots: () => ({ bots: [bot("neo", { enabled: true, thread_id: "thr_neo" }), bot("alex"), bot("bob", { enabled: true, thread_id: "thr_bob" })] }),
    });
    expect(await slot.findByRole("button", { name: "New chat with Neo" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "New chat with Bob" })).toBeTruthy();
    expect(slot.queryByText("Alex")).toBeNull();
    expect(slot.queryByRole("button", { name: "New chat with Alex" })).toBeNull();
  });

  it("the bot thread opens, with its unread dot", async () => {
    const slot = render(
      { bots: () => ({ bots: [bot("neo", { enabled: true, thread_id: "thr_neo" }), bot("bob", { enabled: true, thread_id: "thr_bob" })] }) },
      ["thr_neo"],
    );
    const neo = await slot.findByRole("button", { name: /^Neo/ });
    expect(within(neo).getByRole("status", { name: "Unread" })).toBeTruthy();
    expect(within(slot.getByRole("button", { name: /^Bob/ })).queryByRole("status")).toBeNull();
    fireEvent.click(neo);
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_neo" }]);
  });

  it("New chat calls newChat{profile} and opens the thread", async () => {
    const slot = render({
      bots: () => ({ bots: [bot("neo", { enabled: true, thread_id: "thr_neo" })] }),
      newChat: () => ({ thread_id: "thr_new" }),
    });
    fireEvent.click(await slot.findByRole("button", { name: "New chat with Neo" }));
    await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_new" }]));
    expect(slot.inspection.rpcCalls.filter((c) => c.method === "newChat")).toEqual([{ method: "newChat", input: { profile: "neo" } }]);
  });

  it("shows a newChat error and stays put", async () => {
    const slot = render({
      bots: () => ({ bots: [bot("neo", { enabled: true })] }),
      newChat: () => {
        throw new Error("Neo is switched off in the Hermes plugin settings.");
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "New chat with Neo" }));
    expect((await slot.findByRole("alert")).textContent).toBe("Neo is switched off in the Hermes plugin settings.");
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("no bot on: says where to turn one on; follows BOTS_CHANNEL", async () => {
    let rows = [bot("neo")];
    const slot = render({ bots: () => ({ bots: rows }) });
    expect(await slot.findByText("No bot is on. Turn one on in the Hermes plugin settings.")).toBeTruthy();
    rows = [bot("neo", { enabled: true, thread_id: "thr_neo" })];
    await slot.behavior.emitRealtime(BOTS_CHANNEL, null);
    expect(await slot.findByRole("button", { name: "New chat with Neo" })).toBeTruthy();
  });
});

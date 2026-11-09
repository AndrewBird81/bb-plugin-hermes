// @vitest-environment jsdom
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BOTS_CHANNEL, rpcContract, type BotRow, type RpcContract } from "../shared/rpc-contract.js";
import { grantText } from "./bot-switches.js";
import { bot, loadApp } from "./test-fixtures.js";

const app = await loadApp();
const section = app.settingsSections.find((s) => s.id === "bots")!;

const GRANT_NEO =
  "On: chat with Neo in bb, see Neo's Hermes chats in bb, and let Neo operate bb: read, start, message, stop and archive any bb thread on any machine. Hermes doesn't ask before running bb commands. Restrictions come later.";

function render<M extends keyof RpcContract>(rpc: PluginRpcTestHandlers<Pick<RpcContract, M>>) {
  return renderSlot<object, Pick<RpcContract, M>>(section, {}, { rpc, experimental_rpcContract: rpcContract });
}

describe("bot switches", () => {
  afterEach(cleanup);

  it("one row per bot, every bot off, with the grant text", async () => {
    const slot = render({ bots: () => ({ bots: [bot("neo"), bot("alex")] }) });
    const neo = (await slot.findByRole("switch", { name: "Neo" })) as HTMLInputElement;
    expect(neo.checked).toBe(false);
    expect(neo.disabled).toBe(false);
    expect((slot.getByRole("switch", { name: "Alex" }) as HTMLInputElement).checked).toBe(false);
    expect(slot.getByText(GRANT_NEO)).toBeTruthy();
    expect(neo.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(neo.getAttribute("aria-describedby")!)!.textContent).toBe(GRANT_NEO);
  });

  it("the default bot (Hermes) reads \"see its chats\", never Hermes's Hermes chats", () => {
    expect(grantText("Hermes")).toContain("see its chats in bb");
    expect(grantText("Hermes")).not.toContain("Hermes's");
  });

  it("shows the import count only when it is a number", async () => {
    const slot = render({ bots: () => ({ bots: [bot("neo", { import_count: 12 }), bot("alex"), bot("bob", { import_count: 1 })] }) });
    expect(await slot.findByText("Imports 12 chats from the last 30 days.")).toBeTruthy();
    expect(slot.getByText("Imports 1 chat from the last 30 days.")).toBeTruthy();
    expect(slot.queryAllByText(/^Imports/)).toHaveLength(2);
  });

  it("an unserved bot: switch disabled, Not served by this machine's gateway", async () => {
    const slot = render({ bots: () => ({ bots: [bot("neo", { served: false })] }) });
    const neo = (await slot.findByRole("switch", { name: "Neo" })) as HTMLInputElement;
    expect(neo.disabled).toBe(true);
    expect(slot.getByText("Not served by this machine's gateway")).toBeTruthy();
    expect(slot.queryByText(GRANT_NEO)).toBeNull();
  });

  it("an unserved bot that is on can still turn off", async () => {
    const slot = render({ bots: () => ({ bots: [bot("neo", { served: false, enabled: true })] }) });
    const neo = (await slot.findByRole("switch", { name: "Neo" })) as HTMLInputElement;
    expect(neo.checked).toBe(true);
    expect(neo.disabled).toBe(false);
  });

  it("no bots while not connected", async () => {
    const slot = render({ bots: () => ({ bots: [] }) });
    expect(await slot.findByText("No bots yet: connect to Hermes above.")).toBeTruthy();
  });

  it("toggling calls setBot, holds the requested state, then shows the refetched row", async () => {
    let rows: BotRow[] = [bot("neo")];
    let release!: () => void;
    const slot = render({
      bots: () => ({ bots: rows }),
      setBot: async ({ profile_home, on }) => {
        await new Promise<void>((resolve) => (release = resolve));
        rows = rows.map((row) => (row.profile_home === profile_home ? { ...row, enabled: on, thread_id: "thr_neo" } : row));
        return rows[0]!;
      },
    });
    const neo = (await slot.findByRole("switch", { name: "Neo" })) as HTMLInputElement;
    fireEvent.click(neo);
    await waitFor(() => expect(neo.disabled).toBe(true));
    expect(neo.checked).toBe(true);
    release();
    await waitFor(() => expect(neo.disabled).toBe(false));
    expect(neo.checked).toBe(true);
    expect(slot.inspection.rpcCalls.filter((c) => c.method === "setBot")).toEqual([
      { method: "setBot", input: { profile_home: "/hermes/profiles/neo", on: true } },
    ]);
    expect(slot.inspection.rpcCalls.filter((c) => c.method === "bots")).toHaveLength(2);
  });

  it("shows a setBot error and the row's real state", async () => {
    const slot = render({
      bots: () => ({ bots: [bot("neo")] }),
      setBot: () => {
        throw new Error("Hermes isn't connected.");
      },
    });
    const neo = (await slot.findByRole("switch", { name: "Neo" })) as HTMLInputElement;
    fireEvent.click(neo);
    expect((await slot.findByRole("alert")).textContent).toBe("Hermes isn't connected.");
    expect(neo.checked).toBe(false);
  });

  it("refetches on BOTS_CHANNEL and when the realtime connection comes back", async () => {
    let rows = [bot("neo")];
    const slot = render({ bots: () => ({ bots: rows }) });
    await slot.findByRole("switch", { name: "Neo" });
    rows = [bot("neo"), bot("alex")];
    await slot.behavior.emitRealtime(BOTS_CHANNEL, null);
    expect(await slot.findByRole("switch", { name: "Alex" })).toBeTruthy();
    rows = [bot("neo", { enabled: true })];
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(slot.queryByRole("switch", { name: "Alex" })).toBeNull());
    expect((slot.getByRole("switch", { name: "Neo" }) as HTMLInputElement).checked).toBe(true);
  });
});

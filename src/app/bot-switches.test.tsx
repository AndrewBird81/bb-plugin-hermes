// @vitest-environment jsdom
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BOTS_CHANNEL, rpcContract, type BotRow, type RpcContract } from "../shared/rpc-contract.js";
import { GRANT_TEXT, GRANT_TITLE } from "./bot-switches.js";
import { bot, loadApp } from "./test-fixtures.js";

const app = await loadApp();
const section = app.settingsSections.find((s) => s.id === "bots")!;

function render<M extends keyof RpcContract>(rpc: PluginRpcTestHandlers<Pick<RpcContract, M>>) {
  return renderSlot<object, Pick<RpcContract, M>>(section, {}, { rpc, experimental_rpcContract: rpcContract });
}

describe("bot switches", () => {
  afterEach(cleanup);

  it("the grant once, in a warning card above the rows, also with no bot; every bot off", async () => {
    const slot = render({ bots: () => ({ bots: [bot("neo"), bot("alex")] }) });
    const neo = (await slot.findByRole("switch", { name: "Neo" })) as HTMLInputElement;
    expect(neo.checked).toBe(false);
    expect(neo.disabled).toBe(false);
    expect((slot.getByRole("switch", { name: "Alex" }) as HTMLInputElement).checked).toBe(false);
    const card = slot.getByRole("region", { name: GRANT_TITLE });
    expect(card.textContent).toBe(GRANT_TITLE + GRANT_TEXT);
    expect(slot.getAllByText(GRANT_TEXT)).toHaveLength(1);
    expect(GRANT_TEXT).toBe("It can read, start, message, stop and archive any bb thread on any machine. Hermes doesn't ask before running bb commands. Restrictions come later.");
    // Each switch is described by the card.
    expect(neo.getAttribute("aria-describedby")).toBe(card.id);
    cleanup();
    const empty = render({ bots: () => ({ bots: [] }) });
    await empty.findByText("No bots yet: connect to Hermes above.");
    expect(empty.getByRole("region", { name: GRANT_TITLE })).toBeTruthy();
  });

  it("one line per row by state: imports (count > 0, off), unserved, nothing when on or with no count; no avatar", async () => {
    const slot = render({
      bots: () => ({
        bots: [
          bot("neo", { import_count: 12 }),
          bot("bob", { import_count: 1 }),
          bot("alex", { import_count: 0 }),
          bot("dan"),
          bot("eve", { enabled: true, import_count: 3 }),
          bot("zed", { served: false }),
        ],
      }),
    });
    await slot.findByRole("switch", { name: "Neo" });
    const line = (name: string) => {
      const ids = slot.getByRole("switch", { name }).getAttribute("aria-describedby")!.split(" ");
      return ids.length > 1 ? document.getElementById(ids[1]!)!.textContent : null;
    };
    expect(["Neo", "Bob", "Alex", "Dan", "Eve", "Zed"].map(line)).toEqual([
      "Imports 12 chats from the last 30 days.",
      "Imports 1 chat from the last 30 days.",
      null,
      null,
      null,
      "Not served by this machine's gateway.",
    ]);
    expect(slot.container.querySelectorAll("img")).toHaveLength(0);
  });

  it("an unserved bot: switch disabled", async () => {
    const slot = render({ bots: () => ({ bots: [bot("neo", { served: false })] }) });
    const neo = (await slot.findByRole("switch", { name: "Neo" })) as HTMLInputElement;
    expect(neo.disabled).toBe(true);
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

  it("shows a setBot error as the row's line, and the row's real state", async () => {
    const slot = render({
      bots: () => ({ bots: [bot("neo", { import_count: 2 })] }),
      setBot: () => {
        throw new Error("Hermes isn't connected.");
      },
    });
    const neo = (await slot.findByRole("switch", { name: "Neo", description: /Imports 2 chats/ })) as HTMLInputElement;
    fireEvent.click(neo);
    // The error takes the row's one line.
    expect((await slot.findByRole("alert")).textContent).toBe("Hermes isn't connected.");
    expect(slot.queryByText(/^Imports/)).toBeNull();
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

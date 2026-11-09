// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { rpcContract, THREAD_INFO_TAG, type RpcContract, type ThreadInfo } from "../shared/rpc-contract.js";
import { HERMES_PATHS } from "./hermes-icon.js";
import type { RowData } from "./row-badge.js";
import { info, loadApp, thread } from "./test-fixtures.js";

const app = await loadApp();
const registration = app.threadRowMetadata[0]! as unknown as {
  useData(input: { threads: readonly PluginSidebarThread[] }): RowData;
  component(props: { thread: PluginSidebarThread; data: RowData }): React.ReactNode;
};

/** What bb's sidebar does: one `useData` for every row, then each row's component with that data. */
function Line({ threads }: { threads: PluginSidebarThread[] }) {
  const data = registration.useData({ threads });
  const Badge = registration.component;
  return threads.map((t) => (
    <div key={t.id} data-testid={t.id}>
      <Badge thread={t} data={data} />
    </div>
  ));
}

function render(threads: PluginSidebarThread[], rows: () => Record<string, ThreadInfo>) {
  return renderSlot<{ threads: PluginSidebarThread[] }, Pick<RpcContract, "threadInfo">>({ component: Line }, { threads }, {
    // Every key answers; null = not a Hermes thread (keyed reads reject an omitted key).
    rpc: { threadInfo: ({ keys }) => Object.fromEntries(keys.map((id) => [id, rows()[id] ?? null])) },
    experimental_rpcContract: rpcContract,
  });
}

describe("row badge", () => {
  afterEach(cleanup);

  it("the inline icon is assets/hermes.svg", () => {
    const asset = readFileSync("assets/hermes.svg", "utf8");
    expect([...asset.matchAll(/ d="([^"]+)"/g)].map((m) => m[1])).toEqual(HERMES_PATHS);
  });

  it("bot thread, side chat and mirrored chat texts, with the icon; never an app's name", async () => {
    const slot = render([thread("thr_bot"), thread("thr_side"), thread("thr_mirror")], () => ({
      thr_bot: info("bot"),
      thr_side: info("chat"),
      thr_mirror: info("mirror", { bot_label: "Hermes" }),
    }));
    expect(await slot.findByText("Hermes · Neo · Bot Chat")).toBeTruthy();
    expect(slot.getByTestId("thr_side").textContent).toBe("Hermes · Neo");
    expect(slot.getByTestId("thr_mirror").textContent).toBe("Hermes · Hermes");
    expect(slot.getByTitle("Hermes · Neo · Bot Chat").querySelector("svg")).toBeTruthy();
  });

  it("reads only Hermes threads, in one batch; others show nothing", async () => {
    const slot = render([thread("thr_bot"), thread("thr_codex", { providerId: "codex" }), thread("thr_unbound")], () => ({ thr_bot: info("bot") }));
    await slot.findByText("Hermes · Neo · Bot Chat");
    expect(slot.inspection.rpcCalls).toEqual([{ method: "threadInfo", input: { keys: ["thr_bot", "thr_unbound"] } }]);
    expect(slot.getByTestId("thr_codex").textContent).toBe("");
    expect(slot.getByTestId("thr_unbound").textContent).toBe("");
  });

  it("refreshes when the server invalidates THREAD_INFO_TAG (a thread bound after its first read)", async () => {
    let rows: Record<string, ThreadInfo> = { thr_bot: info("bot") };
    const slot = render([thread("thr_bot"), thread("thr_side")], () => rows);
    await slot.findByText("Hermes · Neo · Bot Chat");
    rows = { ...rows, thr_side: info("chat", { bot_label: "Bob" }) };
    await slot.behavior.experimental_invalidateRpc([THREAD_INFO_TAG]);
    expect(await slot.findByText("Hermes · Bob")).toBeTruthy();
  });
});

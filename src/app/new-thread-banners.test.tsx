// @vitest-environment jsdom
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ComposerSelection } from "@get-bb/plugin-sdk/app";
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { rpcContract, type BotRow, type HealthState, type RpcContract } from "../shared/rpc-contract.js";
import { NO_BOT_TEXT, NO_BOT_TITLE } from "../shared/provider-options.js";
import { bot, health, loadApp } from "./test-fixtures.js";

const app = await loadApp();
const customization = app.composerCustomizations.find((c) => c.id === "hermes-new-thread")!;

const ON_HERMES: ComposerSelection["environment"] = { type: "provider", environmentProviderId: "personal-workspace", inputs: null, machine: { type: "existing", hostId: "host_a" } };

function render(selection: ComposerSelection, bots: BotRow[], state: HealthState = "connected") {
  return renderSlot<object, Pick<RpcContract, "health" | "bots">>(customization.banners![0]!, {}, {
    rpc: { health: () => ({ ...health(state), connected: state === "connected" }), bots: () => ({ bots }) },
    experimental_rpcContract: rpcContract,
    composer: { scope: { kind: "new-thread", projectId: null }, selection },
  });
}

describe("New Thread banner: No Hermes bot is on (ux-v1.1 §3)", () => {
  afterEach(cleanup);

  it("new-thread composers only, one banner, card chrome", () => {
    expect(customization.scopes).toEqual(["new-thread"]);
    expect(customization.banners!.map((b) => [b.id, b.chrome ?? "card"])).toEqual([["no-bot", "card"]]);
  });

  it("Hermes picked on its machine, connected, no bot on: title and text, no button", async () => {
    const slot = render({ providerId: "hermes", environment: ON_HERMES }, [bot("neo"), bot("alex", { served: false })]);
    expect(await slot.findByText(NO_BOT_TITLE)).toBeTruthy();
    expect(slot.getByText(NO_BOT_TEXT)).toBeTruthy();
    expect(NO_BOT_TEXT).toBe("Switch one on in Settings → Plugins → Hermes [Experimental].");
    expect(slot.queryByRole("button")).toBeNull();
  });

  it("nothing when a bot is on, for another provider, on another machine, or not connected", async () => {
    const cases: [ComposerSelection, BotRow[], HealthState][] = [
      [{ providerId: "hermes", environment: ON_HERMES }, [bot("neo", { enabled: true })], "connected"],
      [{ providerId: "codex", environment: ON_HERMES }, [], "connected"],
      [{ providerId: "hermes", environment: { type: "host", hostId: "host_work", workspace: { type: "personal" } } }, [], "connected"],
      [{ providerId: "hermes", environment: ON_HERMES }, [], "not_configured"],
    ];
    for (const [selection, bots, state] of cases) {
      const slot = render(selection, bots, state);
      // Both reads answered (none for another provider), then a render.
      if (selection.providerId === "hermes") await waitFor(() => expect(slot.inspection.rpcCalls.map((c) => c.method).sort()).toEqual(["bots", "health"]));
      await new Promise((r) => setTimeout(r, 20));
      expect(slot.container.textContent).toBe("");
      cleanup();
    }
  });
});

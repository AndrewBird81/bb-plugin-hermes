import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { DEFAULT_FOLDER } from "../shared/settings.js";
import { PROVIDER_ID, REASONING_LEVELS, registerProvider } from "./provider.js";

// The fake host validates the declaration with the production validator.
function register() {
  const { bb, harness } = createFakePluginHost();
  registerProvider(bb);
  expect(harness.registrations.providerRegistrations).toHaveLength(1);
  return harness.registrations.providerRegistrations[0]!;
}

describe("registerProvider", () => {
  it("registers Hermes hidden from bb's pickers (S1-S3 §S3a)", () => {
    expect(register()).toMatchObject({
      id: PROVIDER_ID,
      displayName: "Hermes",
      icon: "./assets/hermes.svg",
      experimental_visibility: "installed",
      maintenance: { health: true },
      capabilities: {
        supportsServiceTier: false,
        supportsNativeUserQuestion: true,
        fork: "none",
        supportsManualCompaction: false,
        supportsThreadArchive: false,
        supportsThreadRename: false,
        permissionModes: ["auto"],
        reasoningLevels: REASONING_LEVELS,
      },
      composerActions: [],
      models: { scope: "workspace" },
    });
  });

  it("passes the folder setting to the bridge", () => {
    const derive = register().deriveProviderOptions!;
    const context = { threadId: "t", projectId: "p", model: "m", permissionMode: "auto" } as const;
    expect(derive({ ...context, settings: { folder: "/srv/hermes" } })).toEqual({ folder: "/srv/hermes" });
    expect(derive({ ...context, settings: {} })).toEqual({ folder: DEFAULT_FOLDER });
  });
});

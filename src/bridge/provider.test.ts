import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { EXTENSION_KINDS } from "../shared/extension-state.js";
import type { ProviderOptions } from "../shared/provider-options.js";
import { PROVIDER_ID, REASONING_LEVELS, registerProvider } from "./provider.js";

const OPTIONS: ProviderOptions = { folder: "/srv/hermes", machine: null, thread: null, project: false };

// The fake host validates the declaration with the production validator.
function register() {
  const { bb, harness } = createFakePluginHost();
  registerProvider(bb, () => OPTIONS);
  expect(harness.registrations.providerRegistrations).toHaveLength(1);
  return harness.registrations.providerRegistrations[0]!;
}

describe("registerProvider", () => {
  it("registers Hermes as installed: listed only where the bridge's health says so (D56)", () => {
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

  it("hands every command the server's options and declares the bridge's extension states", () => {
    const registration = register();
    const context = { threadId: "t", projectId: "p", model: "m", permissionMode: "auto", settings: {} } as const;
    expect(registration.deriveProviderOptions!(context)).toEqual(OPTIONS);
    expect(Object.keys(registration.extensionKinds ?? {}).sort()).toEqual([EXTENSION_KINDS.persistedTurn, EXTENSION_KINDS.status].sort());
  });
});

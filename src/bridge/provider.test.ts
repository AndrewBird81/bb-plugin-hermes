import type { BbPluginApi, PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import { DEFAULT_FOLDER } from "../shared/settings.js";
import { deriveProviderOptions, PROVIDER_ID, REASONING_LEVELS, registerProvider } from "./provider.js";

// A stub `bb`: `@get-bb/plugin-sdk/testing` needs the optional peer `cron-parser`, not installed yet.
function register(): PluginProviderDeclaration {
  const declarations: PluginProviderDeclaration[] = [];
  registerProvider({ providers: { register: (d: PluginProviderDeclaration) => declarations.push(d) } } as unknown as BbPluginApi);
  expect(declarations).toHaveLength(1);
  return declarations[0]!;
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

  it("passes the machine and folder settings to the bridge", () => {
    const derive = register().deriveProviderOptions!;
    const context = { threadId: "t", projectId: "p", model: "m", permissionMode: "auto" } as const;
    expect(derive({ ...context, settings: { machine: "host_1", folder: "/srv/hermes" } })).toEqual({ machine: "host_1", folder: "/srv/hermes" });
    expect(deriveProviderOptions({ settings: {} })).toEqual({ machine: "", folder: DEFAULT_FOLDER });
  });
});

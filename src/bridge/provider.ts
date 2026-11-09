// Provider registration (T0.7; 02 §Components, §Protocol mapping `initialize` row).
// Listed only where health doesn't say `not_installed`: the Hermes machine (D56, `bridge.ts` `health`).
import type { BbPluginApi, PluginProviderOptionsContext } from "@get-bb/plugin-sdk";
import { EXTENSION_KINDS, persistedTurnStateSchema, statusStateSchema } from "../shared/extension-state.js";
import type { ProviderOptions } from "../shared/provider-options.js";

export const PROVIDER_ID = "hermes";

/** The Hermes efforts bb's ladder also has, lowest to highest (r11 §1; Hermes' `minimal` has no bb rung). */
export const REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** The server builds every command's options (`src/shared/provider-options.ts`); it must be fast and synchronous. */
export type DeriveProviderOptions = (context: PluginProviderOptionsContext) => ProviderOptions;

export function registerProvider(bb: BbPluginApi, deriveProviderOptions: DeriveProviderOptions): void {
  bb.providers.register({
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
      permissionModes: ["auto"], // A2, D17
      reasoningLevels: REASONING_LEVELS,
    },
    composerActions: [],
    models: { scope: "workspace" },
    extensionKinds: {
      [EXTENSION_KINDS.persistedTurn]: { state: persistedTurnStateSchema },
      [EXTENSION_KINDS.status]: { state: statusStateSchema },
    },
    deriveProviderOptions,
  });
}

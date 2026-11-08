// Provider registration (T0.7; 02 §Components, §Protocol mapping `initialize` row).
// Hidden from bb's pickers: visible only where health says installed, and the bridge always says
// `not_installed` (S1-S3 §S3a).
import type { BbPluginApi, PluginProviderOptionsContext } from "@get-bb/plugin-sdk";
import { DEFAULT_FOLDER } from "../shared/settings.js";

export const PROVIDER_ID = "hermes";

/** The Hermes efforts bb's ladder also has, lowest to highest (r11 §1; Hermes' `minimal` has no bb rung). */
export const REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** What `deriveProviderOptions` sends every bridge command (02 §Placement). The machine isn't a setting (kv). */
export type BridgeProviderOptions = { folder: string };

export function deriveProviderOptions({ settings }: Pick<PluginProviderOptionsContext, "settings">): BridgeProviderOptions {
  const { folder } = settings;
  return { folder: typeof folder === "string" && folder !== "" ? folder : DEFAULT_FOLDER };
}

export function registerProvider(bb: BbPluginApi): void {
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
    deriveProviderOptions,
  });
}

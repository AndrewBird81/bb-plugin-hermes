// bb.server entry: wiring only. Settings are defined once here and shared.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerProvider } from "./src/bridge/provider.js";
import { startServer } from "./src/server/index.js";
import { settingsDescriptors } from "./src/shared/settings.js";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define(settingsDescriptors);
  registerProvider(bb);
  await startServer(bb, settings);
}

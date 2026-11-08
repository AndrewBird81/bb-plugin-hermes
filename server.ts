// bb.server entry: wiring only. Settings are defined once here and shared.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerProvider } from "./src/bridge/provider.js";
import { openMappingDb } from "./src/server/db.js";
import { startServer } from "./src/server/index.js";
import { deriveProviderOptions } from "./src/server/provider-options.js";
import { settingsDescriptors } from "./src/shared/settings.js";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define(settingsDescriptors);
  const db = openMappingDb(bb);
  registerProvider(bb, (context) => deriveProviderOptions(db, context));
  await startServer(bb, settings, db);
}

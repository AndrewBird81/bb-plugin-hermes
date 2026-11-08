// Server part (server seam): mapping db, keep-alive, health, diagnostics RPC. Stub until T0.6/T0.9.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { SettingsHandle } from "../shared/settings.js";

export async function startServer(_bb: BbPluginApi, _settings: SettingsHandle): Promise<void> {}

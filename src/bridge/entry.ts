// Provider bridge entry (`host.ts` export). Importing it starts nothing: the daemon calls `start`.
import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import { buildFromModuleUrl } from "../shared/bridge-registry.js";
import { createBridge } from "./bridge.js";

const bridge = createBridge(buildFromModuleUrl(import.meta.url));

// A SIGTERM or SIGINT handler replaces Node's default exit, so exit here after cleanup.
const exitOn = (code: number) => () => {
  bridge.close();
  process.exit(code);
};

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine: bridge.handleLine,
  start: ({ dataDir, pluginId }) => bridge.start(dataDir, pluginId),
  onClose: () => bridge.close(),
  onSigterm: exitOn(143),
  onSigint: exitOn(130),
});

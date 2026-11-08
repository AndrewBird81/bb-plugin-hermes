// bb.host entry: the host worker (default export) and the provider bridge share one artifact.
export { default } from "./src/worker/entry.js";
export { experimental_providerBridge } from "./src/bridge/entry.js";

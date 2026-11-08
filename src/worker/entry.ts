// Host worker (worker seam, T0.8). Stub handlers until then.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals } from "../shared/host-contract.js";

const notYet = (): never => {
  throw new Error("not_implemented");
};

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: { ensureWatch: notYet, describe: notYet, diagnostics: notYet },
});

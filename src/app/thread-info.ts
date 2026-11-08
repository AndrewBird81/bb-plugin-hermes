// `threadInfo` per thread id, through bb's keyed query cache: the row badge reads every Hermes row in one
// batch, a banner reads its own thread, and both share the cached rows.
import { experimental_useRpcKeyedQuery } from "@get-bb/plugin-sdk/app";
import type { PROVIDER_ID } from "../bridge/provider.js";
import { rpcContract } from "../shared/rpc-contract.js";

/** The provider id Hermes threads run on. */
export const HERMES_PROVIDER: typeof PROVIDER_ID = "hermes";

/** By thread id; a non-Hermes or not-yet-bound thread has no info. */
export function useThreadInfo(threadIds: readonly string[]) {
  // bb reads keys in batches of 200 (within the contract's 500) and refreshes them when the server
  // invalidates `THREAD_INFO_TAG`.
  return experimental_useRpcKeyedQuery({ contract: rpcContract, method: "threadInfo", keys: threadIds, enabled: threadIds.length > 0 }).data;
}

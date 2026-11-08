// Version check (02 flow 11, A51): every method and param in `contract/used-surface.json` must exist in
// the Hermes install's own `gateway-contract.openrpc.json`. No file → unknown, never a guess.
// The REST half (`rest:` entries): one list page and one messages page of an enabled bot, key-checked.
import { readFile } from "node:fs/promises";
import path from "node:path";
import usedSurface from "../../contract/used-surface.json" with { type: "json" };
import { missingRestKeys, missingSurface } from "../hermes/contract.js";
import { listSessions, readMessages } from "../hermes/history.js";
import type { GatewayEndpoint } from "../hermes/types.js";
import type { VersionCheck } from "../shared/host-contract.js";

export const CONTRACT_FILE = path.join("hermes-agent", "apps", "shared", "src", "gateway-contract.openrpc.json");

/** `code_version`, else the short `code_sha` (10 characters, as the plan cites Hermes commits). */
export function hermesVersion(endpoint: GatewayEndpoint): string | null {
  return endpoint.codeVersion ?? (endpoint.codeSha ? endpoint.codeSha.slice(0, 10) : null);
}

/** Check the install under `rootHome` (expanded) for the gateway behind `endpoint`. */
export async function checkVersion(rootHome: string, endpoint: GatewayEndpoint): Promise<VersionCheck> {
  const version = hermesVersion(endpoint);
  let contract;
  try {
    contract = JSON.parse(await readFile(path.join(rootHome, CONTRACT_FILE), "utf8"));
  } catch {
    return { version, supported: null, missing: [], checked_at: Date.now() };
  }
  const missing = missingSurface(usedSurface, contract);
  return { version, supported: missing.length === 0, missing, checked_at: Date.now() };
}

/** How long each REST read of the key check waits for a restarting gateway. */
const REST_CHECK_WAIT_MS = 2000;

/**
 * Flow 11, REST half: the first of `profiles` (enabled bots only: off bots get no Hermes I/O) with a chat
 * that has messages answers one list page and one messages page, read-only; their keys are checked against
 * `used-surface.json` `rest`. Null: no such chat yet, nothing proven.
 */
export async function checkRestKeys(rootHome: string, profiles: string[]): Promise<string[] | null> {
  for (const profile of profiles) {
    const list = await listSessions(rootHome, profile, { order: "recent", archived: "include", limit: 100 }, { waitMs: REST_CHECK_WAIT_MS });
    const row = list.sessions.find((r) => r.message_count > 0);
    if (!row) continue;
    const messages = await readMessages(rootHome, profile, row.id, { order: "oldest", limit: 500 }, { waitMs: REST_CHECK_WAIT_MS });
    return missingRestKeys(usedSurface.rest, list, messages);
  }
  return null;
}

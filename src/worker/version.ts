// Version check (02 flow 11, A51): every method and param in `contract/used-surface.json` must exist in
// the Hermes install's own `gateway-contract.openrpc.json`. No file → unknown, never a guess.
// The REST key check (`rest:` entries) needs the history reader (T0.5): P1.
import { readFile } from "node:fs/promises";
import path from "node:path";
import usedSurface from "../../contract/used-surface.json" with { type: "json" };
import { missingSurface } from "../hermes/contract.js";
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

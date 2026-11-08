// `describe` (02 §Contracts): one row per Hermes profile, served by the host gateway or not.
// Names and homes from canonical `profiles.list`; the rest from each profile's files, read-only.
// Never reads `.env` (02 §bb access and security).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalHome } from "../hermes/control.js";
import type { GatewayEndpoint, ProfileRow } from "../hermes/types.js";
import type { HermesProfile } from "../shared/host-contract.js";

/**
 * The Bot Mode @handle (r11 §2, `tools/bot_mode_probe.py:_handle`): the folder id; `default` answers
 * to `hermes` while no profile holds that name.
 */
export function botHandle(name: string, names: readonly string[]): string {
  return name === "default" && !names.includes("hermes") ? "hermes" : name;
}

/**
 * `terminal.cwd` from a `config.yaml` (r11 §6): a line scan of the top-level `terminal:` block, not a
 * YAML parser. Only absolute or `~` paths: Hermes' default `.` means the gateway's own cwd.
 */
export function terminalCwd(yaml: string): string | null {
  let inTerminal = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inTerminal = /^terminal:\s*(#.*)?$/.test(line);
      continue;
    }
    const m = inTerminal ? /^ +cwd:\s*(.*?)\s*$/.exec(line) : null;
    if (!m) continue;
    let value = m[1] ?? "";
    const quoted = /^(["'])(.*?)\1/.exec(value);
    value = quoted ? (quoted[2] ?? "") : value.replace(/\s+#.*$/, "");
    return /^(~|~\/.*|\/.*)$/.test(value) ? value : null;
  }
  return null;
}

async function readTerminalCwd(home: string): Promise<string | null> {
  try {
    return terminalCwd(await readFile(path.join(home, "config.yaml"), "utf8"));
  } catch {
    return null;
  }
}

/** Rows for `profiles.list` answered by the gateway behind `endpoint`. */
export async function describeProfiles(rows: ProfileRow[], endpoint: GatewayEndpoint): Promise<HermesProfile[]> {
  const served = new Map(endpoint.servedProfiles.map((p) => [canonicalHome(p.home), p.profile_id]));
  const names = rows.map((r) => r.name);
  return Promise.all(
    rows.map(async (row) => {
      const home = canonicalHome(row.path);
      return {
        name: row.name,
        home: served.get(home) ?? home,
        handle: botHandle(row.name, names),
        terminal_cwd: await readTerminalCwd(home),
        served: served.has(home),
      };
    }),
  );
}

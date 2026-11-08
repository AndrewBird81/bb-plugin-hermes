// Bridge build registry for `diagnostics` (02 §Bridge state, flow 12). A22 assumed one shared dataDir;
// bb 0.49 gives the worker `plugins/<id>/host-data` and bridges `plugins/<id>/bridge-data`, so the
// worker reads its own `bridges/` and the sibling `bridge-data/bridges/`.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { BRIDGES_DIR, bridgeFileSchema } from "../shared/bridge-registry.js";

export interface BridgeRecord {
  pid: number;
  build: string;
  thread_id: string;
  started_at: number;
  alive: boolean;
}

export function bridgeDirs(dataDir: string): string[] {
  return [path.join(dataDir, BRIDGES_DIR), path.join(path.dirname(dataDir), "bridge-data", BRIDGES_DIR)];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Every valid `<pid>.json`, once per pid; unreadable or invalid files are skipped. */
export async function readBridgeRecords(dataDir: string): Promise<BridgeRecord[]> {
  const records = new Map<number, BridgeRecord>();
  for (const dir of bridgeDirs(dataDir)) {
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      const m = /^(\d+)\.json$/.exec(file);
      const pid = Number(m?.[1]);
      if (!m || records.has(pid)) continue;
      try {
        const rec = bridgeFileSchema.parse(JSON.parse(await readFile(path.join(dir, file), "utf8")));
        // The host contract wants a string; a bridge with no thread yet (maintenance) reports "".
        records.set(pid, { pid, build: rec.build, thread_id: rec.threadId ?? "", started_at: rec.startedAt, alive: isAlive(pid) });
      } catch {
        // A half-written or foreign file: not a bridge record.
      }
    }
  }
  return [...records.values()].sort((a, b) => a.pid - b.pid);
}

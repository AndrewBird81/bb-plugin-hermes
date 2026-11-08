// Build registry (02 §Bridge state, A22): this process's `<dataDir>/bridges/<pid>.json`, read by the
// worker's `diagnostics` to see which build each bridge runs (flow 12). Best effort: a failed write
// is reported on stderr and never stops the bridge.
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGES_DIR, type BridgeFile, bridgeFileSchema } from "../shared/bridge-registry.js";

export interface BuildRegistry {
  readonly path: string;
  setThread(threadId: string): void;
  remove(): void;
}

export function openRegistry(dataDir: string, build: string, pid = process.pid, startedAt = Date.now()): BuildRegistry {
  const dir = join(dataDir, BRIDGES_DIR);
  const path = join(dir, `${pid}.json`);
  let removed = false;
  const write = (file: BridgeFile) => {
    if (removed) return;
    try {
      mkdirSync(dir, { recursive: true });
      // Write then rename, so the worker never reads half a file.
      writeFileSync(`${path}.tmp`, JSON.stringify(bridgeFileSchema.parse(file)));
      renameSync(`${path}.tmp`, path);
    } catch (error) {
      process.stderr.write(`hermes bridge: build registry not written: ${(error as Error).message}\n`);
    }
  };
  write({ build, threadId: null, startedAt });
  return {
    path,
    setThread: (threadId) => write({ build, threadId, startedAt }),
    remove() {
      removed = true;
      rmSync(path, { force: true });
    },
  };
}

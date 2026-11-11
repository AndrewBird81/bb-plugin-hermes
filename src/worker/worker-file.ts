// `bridge-data/worker.json` (02 §Bridge state, `src/shared/bridge-files.ts`): what bridges on this machine
// learn from the worker. Rewritten whole (write, then rename) only when its content changes; the boot id
// is part of it, so each worker process writes it once at least.
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { WORKER_FILE, workerFileSchema, type EnabledBot } from "../shared/bridge-files.js";

export class WorkerFileWriter {
  private last: string | null = null;

  /** Writes `<bridgeDataDir>/worker.json` unless this process already wrote this content; true when written. */
  async write(bridgeDataDir: string, root: string, workerBootId: string, enabled: EnabledBot[], models: readonly string[] = []): Promise<boolean> {
    const key = JSON.stringify([bridgeDataDir, root, workerBootId, enabled, models]);
    if (key === this.last) return false;
    const file = path.join(bridgeDataDir, WORKER_FILE);
    await mkdir(bridgeDataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const body = workerFileSchema.parse({ root, worker_boot_id: workerBootId, written_at: Date.now(), enabled, models });
    await writeFile(tmp, JSON.stringify(body, null, 2) + "\n");
    await rename(tmp, file);
    this.last = key;
    return true;
  }

  /** Removes `<bridgeDataDir>/worker.json`; true when there was one. The next `write` writes it again. */
  async remove(bridgeDataDir: string): Promise<boolean> {
    this.last = null;
    return rm(path.join(bridgeDataDir, WORKER_FILE)).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
  }
}

// Files the worker writes into the bridges' dataDir for them (02 §Bridge state). bb gives the worker
// `…/plugins/<id>/host-data` and bridges `…/plugins/<id>/bridge-data` (A22 false), so the worker writes
// the sibling dir. Bridges only read these; each file is written whole (write, then rename). Node-only.
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { catalogSchema } from "./models.js";

/** The bridges' dataDir, seen from the worker's own dataDir. */
export const bridgeDataDir = (workerDataDir: string) => path.join(path.dirname(workerDataDir), "bridge-data");

export const WORKER_FILE = "worker.json";

export const enabledBotSchema = z
  .object({
    profile: z.string(),
    profile_home: z.string(),
    bot_label: z.string(),
    cwd: z.string().nullable(),
  })
  .strict();
export type EnabledBot = z.infer<typeof enabledBotSchema>;

/**
 * `worker.json`, rewritten on every `ensureWatch` that changes it. Its presence with the bridge's folder
 * as `root` means "this machine runs the Hermes worker"; a bridge without it fails turns with
 * `otherMachineText` (01 §9). `enabled`: the bots `model/list` offers as the `profile` session option
 * (`bb thread spawn --option profile=<bot>`, A18).
 */
export const workerFileSchema = z
  .object({
    root: z.string(),
    worker_boot_id: z.string(),
    written_at: z.number(),
    enabled: z.array(enabledBotSchema),
  })
  .strict();
export type WorkerFile = z.infer<typeof workerFileSchema>;

export const MODELS_DIR = "models";

/** `models/<sha256(profile_home)[:16]>.json`: the bot's last-known catalog, written by the worker (prewarm) and the bridge (`model/list`). */
export function modelsFile(dataDir: string, profileHome: string): string {
  return path.join(dataDir, MODELS_DIR, `${createHash("sha256").update(profileHome).digest("hex").slice(0, 16)}.json`);
}

export const modelsFileSchema = catalogSchema;

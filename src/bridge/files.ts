// The bridge's dataDir (02 §Bridge state): `worker.json` and `models/` are the worker's (read here,
// `models/` also written after a fresh `model.options`); `threads.json` is the bridge's own record of each
// thread's bot, for `model/list` (no provider options there, S7 1c) and for a `bb thread spawn` thread the
// server hasn't bound yet, plus bb's own turns as stored (the cumulative `persisted-turn` state).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { modelsFile, modelsFileSchema, WORKER_FILE, type WorkerFile, workerFileSchema } from "../shared/bridge-files.js";
import { mirroredTurnRecordSchema, persistedTurnRecordSchema } from "../shared/extension-state.js";
import type { Catalog } from "../shared/models.js";
import { canonicalHome } from "../hermes/control.js";

/** `~/…` as configured, expanded on the Hermes machine. */
export function expandHome(folder: string, home = homedir()): string {
  return folder === "~" ? home : folder.startsWith("~/") ? path.join(home, folder.slice(2)) : folder;
}

export const sameFolder = (a: string, b: string) => canonicalHome(expandHome(a)) === canonicalHome(expandHome(b));

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Write then rename, so a reader never sees half a file. Best effort: the bridge keeps going without it. */
function writeJson(file: string, value: unknown): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(value));
    renameSync(`${file}.${process.pid}.tmp`, file);
  } catch (error) {
    process.stderr.write(`hermes bridge: ${path.basename(file)} not written: ${(error as Error).message}\n`);
  }
}

export function readWorkerFile(dataDir: string): WorkerFile | null {
  const parsed = workerFileSchema.safeParse(readJson(path.join(dataDir, WORKER_FILE)));
  return parsed.success ? parsed.data : null;
}

export function readCatalog(dataDir: string, profileHome: string): Catalog | null {
  const parsed = modelsFileSchema.safeParse(readJson(modelsFile(dataDir, profileHome)));
  return parsed.success && parsed.data.profile_home === profileHome ? parsed.data : null;
}

export function writeCatalog(dataDir: string, catalog: Catalog): void {
  writeJson(modelsFile(dataDir, catalog.profile_home), catalog);
}

export const THREADS_FILE = "threads.json";

const threadEntrySchema = z.object({
  profile: z.string(),
  bot: z.boolean(),
  /** The bot's home and label, when known: `model/list` needs the home for the catalog file. */
  profile_home: z.string().nullable().default(null),
  /** bb's own turns as stored, newest last (`PERSISTED_TURNS_KEPT`). */
  turns: z.array(persistedTurnRecordSchema).default([]),
  /** Outside turns this thread rendered, with the reply rows shown. */
  mirrored: z.array(mirroredTurnRecordSchema).default([]),
});
export type ThreadEntry = z.infer<typeof threadEntrySchema>;

/** `threads.json`: `{threadId: entry}`. Several bridge processes share it: read, change one key, write. */
export function readThreads(dataDir: string): Record<string, ThreadEntry> {
  const raw = readJson(path.join(dataDir, THREADS_FILE));
  const out: Record<string, ThreadEntry> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, value] of Object.entries(raw)) {
    const parsed = threadEntrySchema.safeParse(value);
    if (parsed.success) out[id] = parsed.data;
  }
  return out;
}

/** Merge `patch` into the thread's entry (a new entry needs `profile`). */
export function updateThread(dataDir: string, threadId: string, patch: Partial<ThreadEntry>): ThreadEntry {
  const all = readThreads(dataDir);
  const next: ThreadEntry = { profile: "", bot: false, profile_home: null, turns: [], mirrored: [], ...all[threadId], ...patch };
  all[threadId] = next;
  writeJson(path.join(dataDir, THREADS_FILE), all);
  return next;
}

/** The thread a `model/list` cwd belongs to: personal-workspace cwds end in the threadId (S7 finding 1). */
export function threadForCwd(dataDir: string, cwd: string | undefined): { threadId: string; entry: ThreadEntry } | null {
  if (!cwd) return null;
  const threads = readThreads(dataDir);
  const leaf = path.basename(cwd);
  const entry = threads[leaf];
  return entry ? { threadId: leaf, entry } : null;
}

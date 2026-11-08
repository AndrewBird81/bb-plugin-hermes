// The bridge's dataDir (02 §Bridge state): `worker.json` and `models/` are the worker's (read here,
// `models/` also written after a fresh `model.options`); `threads/<threadId>.json` is the bridge's own record of each
// thread's bot, for `model/list` (no provider options there, S7 1c) and for a `bb thread spawn` thread the
// server hasn't bound yet, plus bb's own turns as stored (the cumulative `persisted-turn` state).
import { createHash } from "node:crypto";
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

/** One file per thread: several bridge processes write their own threads' records with no read-modify-write race. */
export const THREADS_DIR = "threads";
const threadFile = (dataDir: string, threadId: string) =>
  path.join(dataDir, THREADS_DIR, `${/^[A-Za-z0-9_-]{1,128}$/.test(threadId) ? threadId : createHash("sha256").update(threadId).digest("hex")}.json`);

const threadEntrySchema = z.object({
  profile: z.string(),
  bot: z.boolean(),
  /** The bot's home and label, when known: `model/list` needs the home for the catalog file. */
  profile_home: z.string().nullable().default(null),
  /** bb's own turns as stored, newest last (`PERSISTED_TURNS_KEPT`). */
  turns: z.array(persistedTurnRecordSchema).default([]),
  /** Outside turns this thread rendered, with the reply rows shown. */
  mirrored: z.array(mirroredTurnRecordSchema).default([]),
  /** The model and reasoning bb last asked for: a different pick is a mid-chat change (`session.mutate`). */
  asked: z.object({ model: z.string().nullable(), reasoning: z.string().nullable() }).nullable().default(null),
});
export type ThreadEntry = z.infer<typeof threadEntrySchema>;

/** The bridge's record of a thread, or undefined. */
export function readThread(dataDir: string, threadId: string): ThreadEntry | undefined {
  const parsed = threadEntrySchema.safeParse(readJson(threadFile(dataDir, threadId)));
  return parsed.success ? parsed.data : undefined;
}

/** Merge `patch` into the thread's entry (a new entry needs `profile`). Only this thread's file is written. */
export function updateThread(dataDir: string, threadId: string, patch: Partial<ThreadEntry>): ThreadEntry {
  const next: ThreadEntry = { profile: "", bot: false, profile_home: null, turns: [], mirrored: [], asked: null, ...readThread(dataDir, threadId), ...patch };
  writeJson(threadFile(dataDir, threadId), next);
  return next;
}

/** The thread a `model/list` cwd belongs to: personal-workspace cwds end in the threadId (S7 finding 1). */
export function threadForCwd(dataDir: string, cwd: string | undefined): { threadId: string; entry: ThreadEntry } | null {
  if (!cwd) return null;
  const leaf = path.basename(cwd);
  const entry = readThread(dataDir, leaf);
  return entry ? { threadId: leaf, entry } : null;
}

// Server ↔ host worker (02 §Contracts). P0 calls only; the lead adds P1 calls (models, listSessions,
// readTurns, findBotChat, setBotAccess) when P1 starts. Ids only in every output: no transcript text,
// no expanded home paths (02 §bb access and security).
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { folderSchema } from "./settings.js";

/** The worker's view of the Hermes version (flow 11, A51). `supported: null` = unknown: no contract file. */
export const versionCheckSchema = z
  .object({
    /** Hermes `code_version` from the gateway's `identify`, else its short `code_sha`. */
    version: z.string().nullable(),
    supported: z.boolean().nullable(),
    /** Canonical methods or REST keys we use that this Hermes lacks (`method:session.steer`, `param:prompt.submit.turn_author`, `rest:list.title`). */
    missing: z.array(z.string()),
    checked_at: z.number().nullable(),
  })
  .strict();
export type VersionCheck = z.infer<typeof versionCheckSchema>;

export const watchStateSchema = z.enum(["idle", "connecting", "connected", "disconnected"]);
export type WatchState = z.infer<typeof watchStateSchema>;

export const ensureWatchOutputSchema = z
  .object({
    /** New per worker process. A new id → the server runs a full reconcile. */
    worker_boot_id: z.string(),
    connected: z.boolean(),
    /** The gateway's `instance_id` (`identify`); null while not connected. */
    instance_id: z.string().nullable(),
    version: z.string().nullable(),
    supported: z.boolean().nullable(),
    /** A bounded code when not connected or not supported (`no_gateway`, `not_ready:<state>`, `missing:2`…). */
    detail: z.string().nullable(),
  })
  .strict();
export type EnsureWatchOutput = z.infer<typeof ensureWatchOutputSchema>;

export const profileSchema = z
  .object({
    name: z.string(),
    /** Hermes `profile_id`: the profile home on the Hermes machine. An id, never shown. */
    home: z.string(),
    /** Bot Mode handle, else null (the name is shown; `default` shows as "Hermes", r11 §2). */
    handle: z.string().nullable(),
    terminal_cwd: z.string().nullable(),
    /** Listed in the host gateway's `served_profiles` (S8 §Per-profile reach). */
    served: z.boolean(),
  })
  .strict();
export type HermesProfile = z.infer<typeof profileSchema>;

export const bridgeRecordSchema = z
  .object({ pid: z.number().int(), build: z.string(), thread_id: z.string().nullable(), started_at: z.number(), alive: z.boolean() })
  .strict();

export const workerDiagnosticsSchema = z
  .object({
    pid: z.number().int(),
    started_at: z.number(),
    worker_boot_id: z.string(),
    build: z.string(),
    watch: z
      .object({
        /** The folder as configured (`~/…`), never expanded. */
        root: z.string().nullable(),
        state: watchStateSchema,
        instance_id: z.string().nullable(),
        since: z.number().nullable(),
        last_error: z.string().nullable(),
      })
      .strict(),
    version: versionCheckSchema,
    /** Bridge build registry (`bridges/<pid>.json`, A22). */
    bridges: z.array(bridgeRecordSchema),
  })
  .strict();
export type WorkerDiagnostics = z.infer<typeof workerDiagnosticsSchema>;

export const hostContract = defineRpcContract({
  /** Idempotent; also the 60 s keep-alive (an idle worker dies at 300 s with no exit event, S7 §6). */
  ensureWatch: {
    input: z.object({ root: folderSchema, enabled_bots: z.array(z.string()) }).strict(),
    output: ensureWatchOutputSchema,
    experimental_retryable: true,
  },
  describe: {
    input: z.object({ root: folderSchema }).strict(),
    output: z.object({ uid: z.number().int(), profiles: z.array(profileSchema) }).strict(),
    experimental_retryable: true,
  },
  diagnostics: {
    input: z.null(),
    output: workerDiagnosticsSchema,
    experimental_retryable: true,
  },
});
export type HostContract = typeof hostContract;

export const hostSignals = {
  /** Something changed in these profiles' chats (debounced). A hint only: the server re-lists. */
  changed: { payload: z.object({ profile_homes: z.array(z.string()) }).strict() },
  watch: {
    payload: z
      .object({ state: z.enum(["connected", "disconnected"]), worker_boot_id: z.string(), instance_id: z.string().nullable() })
      .strict(),
  },
} satisfies ExperimentalHostSignals;

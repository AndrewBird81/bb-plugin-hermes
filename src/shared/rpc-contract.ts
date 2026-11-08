// Server RPC for the app and `bb plugin rpc call hermes …` (02 §Components). P0 methods only; P1 adds
// stopHosted, newChat and setBot. The app imports this file type-only.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { workerDiagnosticsSchema } from "./host-contract.js";
import { folderSchema, machineSchema } from "./settings.js";

/**
 * - `not_configured`: no machine set; no Hermes I/O.
 * - `machine_offline`: the machine isn't connected to bb.
 * - `connecting`: set, no worker answer yet.
 * - `disconnected`: the worker answered without a gateway, or the host call failed (`detail` says why).
 * - `connected`: the gateway answered; `supported` true, or null when the version is unknown (A51).
 * - `not_supported`: connected, but the contract check failed: mirroring and import pause (flow 11).
 */
export const healthStateSchema = z.enum(["not_configured", "machine_offline", "connecting", "disconnected", "connected", "not_supported"]);
export type HealthState = z.infer<typeof healthStateSchema>;

export const healthSchema = z
  .object({
    state: healthStateSchema,
    machine: z.object({ id: z.string(), name: z.string().nullable(), online: z.boolean() }).strict().nullable(),
    folder: z.string(),
    connected: z.boolean(),
    version: z.string().nullable(),
    supported: z.boolean().nullable(),
    detail: z.string().nullable(),
    /** Unix ms of the worker's last `ensureWatch` answer. */
    worker_last_seen_at: z.number().nullable(),
  })
  .strict();
export type Health = z.infer<typeof healthSchema>;

export const diagnosticsSchema = z
  .object({
    plugin_version: z.string(),
    /** The gateway's `instance_id`; e2e aborts unless it is the fake's (03 §E2E step 6, R3 M3). */
    instance_id: z.string().nullable(),
    health: healthSchema,
    bindings: z.object({ total: z.number().int(), duplicates: z.number().int() }).strict(),
    /** Recent bounded error codes, newest last. */
    errors: z.array(z.string()),
    worker: workerDiagnosticsSchema.nullable(),
    worker_error: z.string().nullable(),
  })
  .strict();
export type Diagnostics = z.infer<typeof diagnosticsSchema>;

export const rpcContract = defineRpcContract({
  health: { input: z.null(), output: healthSchema },
  diagnostics: { input: z.null(), output: diagnosticsSchema },
  /** Saves the machine (and folder) settings, then checks the connection at once. */
  setConnection: {
    input: z.object({ machine: machineSchema, folder: folderSchema.optional() }).strict(),
    output: healthSchema,
  },
});
export type RpcContract = typeof rpcContract;

/** `bb.realtime` channel: published whenever `health` changes; the app refetches. */
export const HEALTH_CHANNEL = "health";

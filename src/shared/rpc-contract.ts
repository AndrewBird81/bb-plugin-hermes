// Server RPC for the app and `bb plugin rpc call hermes …` (02 §Components). The app imports this file
// type-only.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { workerDiagnosticsSchema } from "./host-contract.js";
import { folderSchema, machineSchema } from "./settings.js";
import { SOURCE_TAGS } from "./sources.js";

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

/** RPC tag of every `threadInfo` read (`bb.rpc.experimental_invalidate([THREAD_INFO_TAG])`). */
export const THREAD_INFO_TAG = "thread-info";

/** One switch row (01 §2). */
export const botRowSchema = z
  .object({
    profile: z.string(),
    profile_home: z.string(),
    bot_label: z.string(),
    /** In the host gateway's `served_profiles`; else "Not served by this machine's gateway", switch disabled. */
    served: z.boolean(),
    enabled: z.boolean(),
    /** The bot thread, once the switch made one. */
    thread_id: z.string().nullable(),
    /** "Imports N chats from the last 30 days": P2 (null in P1). */
    import_count: z.number().int().nullable(),
  })
  .strict();
export type BotRow = z.infer<typeof botRowSchema>;

/** Per thread, for the row badge (A28), the composer chip and banners. */
export const threadInfoSchema = z
  .object({
    kind: z.enum(["bot", "chat", "mirror"]),
    profile_home: z.string(),
    bot_label: z.string(),
    enabled: z.boolean(),
    tag: z.enum(SOURCE_TAGS).nullable(),
  })
  .strict();
export type ThreadInfo = z.infer<typeof threadInfoSchema>;

export const rpcContract = defineRpcContract({
  health: { input: z.null(), output: healthSchema },
  diagnostics: { input: z.null(), output: diagnosticsSchema },
  /** Saves the machine (and folder) settings, then checks the connection at once. */
  setConnection: {
    input: z.object({ machine: machineSchema, folder: folderSchema.optional() }).strict(),
    output: healthSchema,
  },
  /** Every profile the worker describes; an empty list while not connected. */
  bots: { input: z.null(), output: z.object({ bots: z.array(botRowSchema) }).strict() },
  /** A bot switch (flow 1). Every bot starts off (D43). */
  setBot: {
    input: z.object({ profile_home: z.string().min(1), on: z.boolean() }).strict(),
    output: botRowSchema,
  },
  /** A side chat with an enabled bot (flow 2): `profile` is the profile name. The app navigates to `thread_id`. */
  newChat: {
    input: z.object({ profile: z.string().min(1) }).strict(),
    output: z.object({ thread_id: z.string() }).strict(),
  },
  /** Redeploy (flow 12): stops idle Hermes threads now and busy ones at their `thread.idle`. */
  stopHosted: {
    input: z.null(),
    output: z.object({ stopped: z.number().int(), pending: z.number().int(), failed: z.number().int() }).strict(),
  },
  /**
   * Keyed (`experimental_useRpcKeyedQuery`): `keys` are thread ids. Every key answers (bb rejects a keyed
   * read that omits one); null = not a Hermes thread, or not bound yet. The server invalidates
   * `THREAD_INFO_TAG` whenever a binding is created or its kind, label, tag or switch changes.
   */
  threadInfo: {
    input: z.object({ keys: z.array(z.string()).max(500) }).strict(),
    output: z.record(z.string(), threadInfoSchema.nullable()),
    tags: () => [THREAD_INFO_TAG],
  },
});
export type RpcContract = typeof rpcContract;

/** `bb.realtime` channel: published whenever `health` changes; the app refetches. */
export const HEALTH_CHANNEL = "health";
/** `bb.realtime` channel: published whenever a bot row changes (switch, describe, bot thread). */
export const BOTS_CHANNEL = "bots";

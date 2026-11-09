// Extension states the bridge publishes (`extension.state`), declared in the provider's `extensionKinds`
// under these local names (bb namespaces them with the plugin id). No Node imports: the app reads `status`.
import { z } from "zod";

export const EXTENSION_KINDS = {
  /** bb's own turns as Hermes stored them: the server records them as `bb` turns so they never mirror (A37, R4 M3c). */
  persistedTurn: "persisted-turn",
  /** What the app's thread banner shows (A47). */
  status: "status",
} as const;

/** One bb turn as Hermes stored it. Anchors cover the submit, its steers and a `/retry`'s new user row (A4). */
export const persistedTurnRecordSchema = z
  .object({
    submission_id: z.string(),
    anchor_uids: z.array(z.string()),
    reply_uids: z.array(z.string()),
    /** Unix ms when the turn settled. */
    at: z.number(),
  })
  .strict();

/** One outside turn the bridge rendered for a `mirror` marker, with the reply rows it showed (none for Conduit's own turn). */
export const mirroredTurnRecordSchema = z
  .object({
    anchor_uid: z.string(),
    reply_uids: z.array(z.string()),
    /** The bridge closed it `partial` (no canonical admission): the reply rows come later by `mirror{rest:true}`. */
    partial: z.boolean(),
    at: z.number(),
  })
  .strict();

/**
 * Cumulative, so a server that reads only the latest state (events are debounced, S7 finding 2) misses
 * nothing: the newest `PERSISTED_TURNS_KEPT` records of each list, oldest first. `lineage_root`/`session_id`
 * let the server fill a `pending` binding once the first send created the session. `mirrored` tells the
 * server which reply rows a mirror turn showed, so it wakes `mirror{rest:true}` only for rows not shown.
 */
export const persistedTurnStateSchema = z
  .object({
    profile_home: z.string(),
    lineage_root: z.string(),
    session_id: z.string(),
    turns: z.array(persistedTurnRecordSchema),
    mirrored: z.array(mirroredTurnRecordSchema).default([]),
  })
  .strict();
export type PersistedTurnState = z.infer<typeof persistedTurnStateSchema>;
export const PERSISTED_TURNS_KEPT = 20;

/**
 * The thread banner (01 §5, §6):
 * - `held`: "Open in another Hermes app: sends when it's free" (flow 3 step 4);
 * - `running_elsewhere`: "Running outside bb" (Stop on an outside turn bb can't stop).
 * Never an app's name: Hermes records no per-turn source (owner ruling, 2026-11-08).
 * `null` clears it. The offline banner comes from health, not from here (flow 10).
 * `dead_requests`: the `interaction/request` ids (bb's `providerRequestId`) of cards whose Hermes prompt
 * settled elsewhere or timed out, newest `DEAD_REQUESTS_KEPT`. bb 0.49.0 gives a bridge no way to close
 * a card it raised (T1.14, A3), so the server cancels them with `threads.interactions.cancel`.
 */
export const statusStateSchema = z
  .object({
    banner: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("held") }).strict(),
        z.object({ kind: z.literal("running_elsewhere") }).strict(),
      ])
      .nullable(),
    /** Unix ms the banner was set. */
    since: z.number().nullable(),
    dead_requests: z.array(z.string()).optional(),
  })
  .strict();
export type StatusState = z.infer<typeof statusStateSchema>;
export const DEAD_REQUESTS_KEPT = 20;

export const bannerText = (banner: NonNullable<StatusState["banner"]>): string =>
  banner.kind === "held" ? "Open in another Hermes app: sends when it's free" : "Running outside bb";

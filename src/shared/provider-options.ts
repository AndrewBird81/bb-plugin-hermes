// What the server hands every bridge command through `deriveProviderOptions` (02 §Placement): the folder,
// the Hermes machine, and the server's view of this thread's binding, read synchronously from the mapping
// db on each command. Ids only: provider options ride the daemon wire and persist with the session.
import { z } from "zod";
import { SOURCE_TAGS } from "./sources.js";

export const threadViewSchema = z
  .object({
    kind: z.enum(["bot", "chat", "mirror"]),
    /** The profile name Hermes routes by (`profile` on every host-socket call) and REST reads by. */
    profile: z.string(),
    profile_home: z.string(),
    /** What bb shows for the bot ("Neo"; `default` shows as "Hermes"). */
    bot_label: z.string(),
    /** The bot's switch. Off → every turn fails "<bot_label> is switched off in the Hermes plugin settings." */
    enabled: z.boolean(),
    /** Null until the first send creates the session (side chat) or the Bot Chat is found (bot thread). */
    lineage_root: z.string().nullable(),
    session_id: z.string().nullable(),
    /** Not gateway-owned yet: adopted only by the first bb send (D16, A23). */
    legacy: z.boolean(),
    /** The tag outside turns carry in this thread; null for a side chat. */
    tag: z.enum(SOURCE_TAGS).nullable(),
    /** The bot's `terminal.cwd`, for `session.create` (null → `~`, R1 S10). */
    cwd: z.string().nullable(),
  })
  .strict();
export type ThreadView = z.infer<typeof threadViewSchema>;

export const providerOptionsSchema = z
  .object({
    /** The folder setting as configured (`~/…`); the bridge expands `~` on the Hermes machine. */
    folder: z.string(),
    /** The Hermes machine (mapping db `kv`); null when unset: no Hermes I/O. The name is for "Hermes runs on <machine>". */
    machine: z.object({ id: z.string(), name: z.string().nullable() }).strict().nullable(),
    /** Null when the server has no binding (yet) for this thread, e.g. a `bb thread spawn` whose `thread.created` hasn't run. */
    thread: threadViewSchema.nullable(),
  })
  .strict();
export type ProviderOptions = z.infer<typeof providerOptionsSchema>;

/** The bridge's view of `options.providerOptions`: a missing or invalid value reads as "nothing known". */
export function readProviderOptions(raw: unknown): ProviderOptions | null {
  const parsed = providerOptionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** 01 §2: the error a switched-off bot's thread shows. */
export const switchedOffText = (botLabel: string) => `${botLabel} is switched off in the Hermes plugin settings.`;
/** 01 §9, 02 §Protocol mapping: a turn on a machine that doesn't run Hermes. */
export const otherMachineText = (machine: string) => `Hermes runs on ${machine}: add \`--machine ${machine}\`.`;

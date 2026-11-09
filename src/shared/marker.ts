// Markers: agent-only `<hermes-bb>{json}</hermes-bb>` input from the server to the bridge (02 §Contracts).
// Never rendered, never sent to Hermes. Shared by the server (encode) and the bridge (decode, segment).
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

const nonEmpty = z.string().min(1);
/**
 * The visible text part right before this marker is its label: the user's bubble for that Hermes turn,
 * tagged (`[Outside bb] …`) or not (bb's own earlier message in an import). Never a prompt (02 §Invariants).
 */
const labeled = z.literal(true).optional();

export const markerSchema = z.discriminatedUnion("op", [
  /** Spawn of a bot thread (`bot: true`) or an empty side chat. Refused unless the identity is `pending:`. */
  z.object({ op: z.literal("init"), profile: nonEmpty, bot: z.boolean().optional() }).strict(),
  /** First import turn: bind the thread, render that turn from history. `since` (Unix ms) adds the "Earlier messages stay in Hermes" note. */
  z
    .object({
      op: z.literal("bind"),
      profile_home: nonEmpty,
      lineage_root: nonEmpty,
      legacy: z.boolean(),
      anchor_uid: nonEmpty,
      since: z.number().int().nonnegative().optional(),
      labeled,
    })
    .strict(),
  /** Later import turns: render that turn from history. */
  z.object({ op: z.literal("replay"), anchor_uid: nonEmpty, labeled }).strict(),
  /** Wake: render or watch an outside turn. `rest`: only the reply rows not shown yet (`/retry`, Conduit's second step). */
  z.object({ op: z.literal("mirror"), anchor_uid: nonEmpty, rest: z.boolean().optional(), labeled }).strict(),
]);

export type Marker = z.infer<typeof markerSchema>;

/**
 * Decoding drops unknown fields: a bridge keeps running old code after an update (S1-S3 fact 2), so a
 * field a newer server adds must not turn a marker invalid. Encoding stays strict.
 */
const decodeSchema = z.discriminatedUnion(
  "op",
  markerSchema.options.map((o) => o.strip()) as unknown as [typeof markerSchema.options[number], ...typeof markerSchema.options],
);
export type MarkerOp = Marker["op"];

const OPEN = "<hermes-bb>";
const CLOSE = "</hermes-bb>";
const WRAPPED = /^<hermes-bb>([\s\S]*)<\/hermes-bb>$/;

export type MarkerPart = Extract<PromptInput, { type: "text" }> & { visibility: "agent-only" };

/** The prompt part the server sends. */
export function encodeMarker(marker: Marker): MarkerPart {
  return { type: "text", mentions: [], text: `${OPEN}${JSON.stringify(markerSchema.parse(marker))}${CLOSE}`, visibility: "agent-only" };
}

/**
 * The input of every plugin spawn: one empty agent-only text. bb derives a thread's immutable `titleFallback` from
 * every text part of the spawn input, agent-only ones included (bb-app 0.49.0 `deriveTitleFallback`), so a marker
 * there would show wherever bb falls back from the title. The bridge runs it as an empty prompt: nothing reaches
 * Hermes. The marker follows in a `threads.send`.
 */
export function spawnStart(): MarkerPart {
  return { type: "text", mentions: [], text: "", visibility: "agent-only" };
}

export class MarkerError extends Error {
  readonly text: string;
  constructor(message: string, text: string) {
    super(message);
    this.name = "MarkerError";
    this.text = text;
  }
}

/** `null` when `text` isn't wrapped in `<hermes-bb>`; throws `MarkerError` when it is but doesn't validate. */
export function decodeMarker(text: string): Marker | null {
  const m = WRAPPED.exec(text.trim());
  if (!m) return null;
  let json: unknown;
  try {
    json = JSON.parse(m[1] ?? "");
  } catch {
    throw new MarkerError("marker is not JSON", text);
  }
  const parsed = decodeSchema.safeParse(json);
  if (!parsed.success) throw new MarkerError(`invalid marker: ${parsed.error.issues[0]?.message ?? "unknown"}`, text);
  return parsed.data;
}

/**
 * One turn's input split in order (R1 M6: bb may merge queued sends into one turn).
 * - `marker`: a marker, with its label: the visible text part right before it when the marker says
 *   `labeled` (the server sets it on every marker it sends after a bubble). A wake for a hidden user
 *   row has no label; a user's own text before an unlabeled marker stays a prompt, tag or not.
 * - `prompt`: consecutive parts with no marker between them: a bb prompt for `prompt.submit`.
 *   Agent-only parts that aren't markers (bb's own context) stay in the prompt.
 * - `invalid`: a `<hermes-bb>` part that failed to decode, with the visible text right before it (its
 *   likely label). The bridge fails the turn and submits nothing of it.
 */
export type Segment =
  | { kind: "marker"; marker: Marker; label: string | null }
  | { kind: "prompt"; parts: PromptInput[] }
  | { kind: "invalid"; error: string; label: string | null };

export function segmentInput(input: readonly PromptInput[]): Segment[] {
  const out: Segment[] = [];
  let prompt: PromptInput[] = [];
  const flush = () => {
    if (prompt.length) out.push({ kind: "prompt", parts: prompt });
    prompt = [];
  };
  for (const part of input) {
    if (part.type !== "text" || part.visibility !== "agent-only") {
      prompt.push(part);
      continue;
    }
    const last = prompt.at(-1);
    const popLabel = (): string | null => {
      if (last?.type !== "text" || last.visibility === "agent-only") return null;
      prompt.pop();
      return last.text;
    };
    let marker: Marker | null;
    try {
      marker = decodeMarker(part.text);
    } catch (error) {
      const label = popLabel();
      flush();
      out.push({ kind: "invalid", error: (error as Error).message, label });
      continue;
    }
    if (!marker) {
      prompt.push(part);
      continue;
    }
    const label = marker.op !== "init" && marker.labeled === true ? popLabel() : null;
    flush();
    out.push({ kind: "marker", marker, label });
  }
  flush();
  return out;
}

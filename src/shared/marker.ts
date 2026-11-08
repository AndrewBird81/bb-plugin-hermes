// Markers: agent-only `<hermes-bb>{json}</hermes-bb>` input from the server to the bridge (02 §Contracts).
// Never rendered, never sent to Hermes. Shared by the server (encode) and the bridge (decode, segment).
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { SOURCE_TAG_PREFIX } from "./sources.js";

const nonEmpty = z.string().min(1);
/**
 * The visible text part right before this marker is its label: the user's bubble for that Hermes turn,
 * tagged (`[CLI] …`) or not (bb's own earlier message in an import). Never a prompt (02 §Invariants).
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
export type MarkerOp = Marker["op"];

const OPEN = "<hermes-bb>";
const CLOSE = "</hermes-bb>";
const WRAPPED = /^<hermes-bb>([\s\S]*)<\/hermes-bb>$/;

export type MarkerPart = Extract<PromptInput, { type: "text" }> & { visibility: "agent-only" };

/** The prompt part the server sends. */
export function encodeMarker(marker: Marker): MarkerPart {
  return { type: "text", mentions: [], text: `${OPEN}${JSON.stringify(markerSchema.parse(marker))}${CLOSE}`, visibility: "agent-only" };
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
  const parsed = markerSchema.safeParse(json);
  if (!parsed.success) throw new MarkerError(`invalid marker: ${parsed.error.issues[0]?.message ?? "unknown"}`, text);
  return parsed.data;
}

/**
 * One turn's input split in order (R1 M6: bb may merge queued sends into one turn).
 * - `marker`: a marker, with its label: the visible text part right before it when the marker says
 *   `labeled`, or when that part starts with a source tag (`[CLI] …`, `[CLI · Oct 12] …`). A wake for a
 *   hidden user row has no label.
 * - `prompt`: consecutive parts with no marker between them: a bb prompt for `prompt.submit`.
 *   Agent-only parts that aren't markers (bb's own context) stay in the prompt.
 * - `invalid`: a `<hermes-bb>` part that failed to decode. The bridge fails it; never submitted.
 */
export type Segment =
  | { kind: "marker"; marker: Marker; label: string | null }
  | { kind: "prompt"; parts: PromptInput[] }
  | { kind: "invalid"; error: string };

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
    let marker: Marker | null;
    try {
      marker = decodeMarker(part.text);
    } catch (error) {
      flush();
      out.push({ kind: "invalid", error: (error as Error).message });
      continue;
    }
    if (!marker) {
      prompt.push(part);
      continue;
    }
    const last = prompt.at(-1);
    let label: string | null = null;
    const labels = marker.op !== "init" && marker.labeled === true;
    if (last?.type === "text" && last.visibility !== "agent-only" && (labels || SOURCE_TAG_PREFIX.test(last.text))) {
      label = last.text;
      prompt.pop();
    }
    flush();
    out.push({ kind: "marker", marker, label });
  }
  flush();
  return out;
}

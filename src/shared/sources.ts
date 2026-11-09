// Which Hermes chats mirror into bb, and the tag their outside messages carry (02 §Invariants, README confirm item 5).
// An allow-list that fails closed: unknown labels, hidden rows and empty rows stay out. Hermes records no per-turn
// source, so an outside message never names an app: it reads `[Outside bb]` (owner ruling, 2026-11-08).

export const BOT_CHAT_TITLE = "Bot Chat";

/** The tag every outside message carries in bb. */
export const OUTSIDE_TAG = "Outside bb";

/** A visible text that starts with the outside tag: a mirror label, or a recalled one bb refuses to send (D15). */
export const OUTSIDE_TAG_PREFIX = /^\[Outside bb(?: · [^\]\n]{1,40})?\] /;

/**
 * Raw surfaces that mirror. Canonical rows store `source=local` and the surface in `created_source` (r03 §67);
 * dashboard chats (Conduit, remote Desktop, dashboard chat) are `desktop` rows. A surface only decides
 * eligibility; it never becomes UI text.
 */
const MIRRORED_SURFACES: ReadonlySet<string> = new Set(["cli", "tui", "gui", "desktop"]);

export interface SourceFacts {
  source: string | null;
  created_source: string | null;
}

export interface SessionFacts extends SourceFacts {
  title: string | null;
  hidden: boolean;
  message_count: number;
}

export interface EligibilityContext {
  /** The row is a session bb created (`expected_id`, or a `bb:` `request_id`). */
  bbCreated: boolean;
  /** bb deleted its thread: never import again (Q1). */
  tombstoned: boolean;
}

export type OutReason = "source" | "hidden" | "empty" | "bb-created" | "tombstoned";

export type Eligibility =
  | { kind: "bot" }
  | { kind: "chat"; surface: string }
  | { kind: "out"; reason: OutReason };

/** The surface a row came from: `created_source` for canonical (`source=local`) rows, else `source`. */
export function surfaceOf(row: SourceFacts): string | null {
  return row.source === "local" ? row.created_source : row.source;
}

/**
 * What bb does with a Hermes session of an enabled bot:
 * - `bot`: the profile's Bot Chat, bound to the bot thread whatever its source (never its own thread);
 * - `chat`: a mirrored thread; `surface` is the chat's own recorded surface (for a later badge, never a label);
 * - `out`: stays in Hermes.
 */
export function eligibility(row: SessionFacts, context: EligibilityContext): Eligibility {
  if (row.title === BOT_CHAT_TITLE) return { kind: "bot" };
  const surface = surfaceOf(row);
  if (surface === null || !MIRRORED_SURFACES.has(surface)) return { kind: "out", reason: "source" };
  if (row.hidden) return { kind: "out", reason: "hidden" };
  if (row.message_count < 1) return { kind: "out", reason: "empty" };
  if (context.bbCreated) return { kind: "out", reason: "bb-created" };
  if (context.tombstoned) return { kind: "out", reason: "tombstoned" };
  return { kind: "chat", surface };
}

const MONTH_DAY = (timeZone?: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone });

/** `[Outside bb] ` for a live mirror; `[Outside bb · Oct 12] ` for an imported message (Q7 default). */
export function outsideTag(at?: Date, timeZone?: string): string {
  return at ? `[${OUTSIDE_TAG} · ${MONTH_DAY(timeZone).format(at)}] ` : `[${OUTSIDE_TAG}] `;
}

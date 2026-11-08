// Which Hermes chats mirror into bb, and the tag their outside messages carry (02 §Invariants, README confirm item 5).
// An allow-list that fails closed: unknown labels, hidden rows and empty rows stay out.

export const BOT_CHAT_TITLE = "Bot Chat";

export const SOURCE_TAGS = ["CLI", "TUI", "Desktop", "Conduit"] as const;
export type SourceTag = (typeof SOURCE_TAGS)[number];

/** A visible text that starts with a source tag: a mirror label, or a recalled one (D15). */
export const SOURCE_TAG_PREFIX = /^\[(?:CLI|TUI|Desktop|Conduit)(?: · [^\]\n]{1,40})?\] /;

/** Raw surfaces that mirror. Canonical rows store `source=local` and the surface in `created_source` (r03 §67). */
const SURFACE_TAGS: Record<string, (legacy: boolean) => SourceTag> = {
  cli: () => "CLI",
  tui: () => "TUI",
  gui: () => "Desktop",
  // Dashboard chats (Conduit, remote Desktop, dashboard chat) are legacy `desktop` rows; Conduit
  // isn't distinguishable from the others (A5), so "Conduit" names them all in UI text.
  desktop: (legacy) => (legacy ? "Conduit" : "Desktop"),
};

export interface SourceFacts {
  source: string | null;
  created_source: string | null;
  legacy: boolean;
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
  | { kind: "chat"; tag: SourceTag }
  | { kind: "out"; reason: OutReason };

/** The surface a row came from: `created_source` for canonical (`source=local`) rows, else `source`. */
export function surfaceOf(row: SourceFacts): string | null {
  return row.source === "local" ? row.created_source : row.source;
}

/** The tag for a mirrored row, or `null` when its surface isn't on the allow-list. */
export function tagFor(row: SourceFacts): SourceTag | null {
  const surface = surfaceOf(row);
  const tag = surface !== null && Object.hasOwn(SURFACE_TAGS, surface) ? SURFACE_TAGS[surface] : undefined;
  return tag ? tag(row.legacy) : null;
}

/**
 * What bb does with a Hermes session of an enabled bot:
 * - `bot`: the profile's Bot Chat, bound to the bot thread whatever its source (never its own thread);
 * - `chat`: a mirrored thread with that tag;
 * - `out`: stays in Hermes.
 */
export function eligibility(row: SessionFacts, context: EligibilityContext): Eligibility {
  if (row.title === BOT_CHAT_TITLE) return { kind: "bot" };
  const tag = tagFor(row);
  if (!tag) return { kind: "out", reason: "source" };
  if (row.hidden) return { kind: "out", reason: "hidden" };
  if (row.message_count < 1) return { kind: "out", reason: "empty" };
  if (context.bbCreated) return { kind: "out", reason: "bb-created" };
  if (context.tombstoned) return { kind: "out", reason: "tombstoned" };
  return { kind: "chat", tag };
}

const MONTH_DAY = (timeZone?: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone });

/** `[CLI] ` for a live mirror; `[CLI · Oct 12] ` for an imported message (Q7 default). */
export function formatTag(tag: SourceTag, at?: Date, timeZone?: string): string {
  return at ? `[${tag} · ${MONTH_DAY(timeZone).format(at)}] ` : `[${tag}] `;
}

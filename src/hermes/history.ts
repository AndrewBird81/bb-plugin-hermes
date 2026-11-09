// History reader (02 §History reader, README confirm item 4): Hermes' own REST projection on the gateway's
// listener (`api_origin` from `identify`), with a `native-http` ticket minted on `gateway.sock` for each
// request, as Desktop reads it (`apps/desktop/electron/local-gateway.ts:487`). Read-only routes
// (`hermes_cli/web_routers/sessions.py:182, 739`); we never re-implement their projection.
import type { HistoryTurn } from "../shared/host-contract.js";
import { canonicalHome, ControlError, discoverEndpoint, mintTicket } from "./control.js";
import { NATIVE_HTTP_HEADER, type GatewayEndpoint } from "./types.js";

/** A REST list row: the keys bb reads (`contract/used-surface.json` `rest.list`); the rest rides as unknown. */
export interface RestSessionRow {
  /** A rotated chain lists its tip only. */
  id: string;
  title: string | null;
  /** `local` for gateway rows (the surface is in `created_source`); `desktop` for a dashboard (Conduit) row. */
  source: string | null;
  created_source: string | null;
  /** The lineage root of a gateway-owned row (also on a rotated tip); null on a legacy row (D16). */
  chat_id: string | null;
  /** A rotated chain's root id, on the tip's projected row (`hermes_state_session_list.py:39`); a legacy chain's only lineage. */
  _lineage_root_id?: string;
  /** 0 or 1. The list leaves hidden sessions out (the Bot Chat included): find those by `session.list`. */
  hidden: number;
  archived: boolean;
  cwd: string | null;
  message_count: number;
  /** Activity heartbeats only: null on older rows; a rotated chain shows its root's. Read `last_active`. */
  last_activity_at: number | null;
  /** max(heartbeat, newest message, start), Unix seconds (`hermes_state_common.py:258-274`). */
  last_active?: number | null;
}

export interface SessionsPage {
  sessions: RestSessionRow[];
  total: number;
}

/** A message row of the display projection (`rest.messages`), oldest first, compression ancestors included. */
export interface RestMessage {
  session_id: string;
  /** Stable across compaction clones and pages; row ids aren't (R1 M2). A clone may be listed twice (A8). */
  message_uid: string;
  role: string;
  content: string | null;
  /** On projected rows only (a steer's words, a withheld prompt, a compaction carrier): show it instead of `content`. */
  display_content?: string;
  /** `hidden`: model-facing only; `steer`: a mid-turn steer, part of the running turn. */
  display_kind?: string | null;
  /** `submission_id` starts `bb:` on bb's own submits, queued ones included (A4). */
  display_metadata: { submission_id?: string } | null;
  timestamp: number;
  tool_calls: unknown[] | null;
  tool_call_id: string | null;
  tool_name: string | null;
  reasoning: string | null;
}

export interface MessagesPage {
  /** The chain's current tip: Hermes resolves any id of the chain to it. */
  session_id: string;
  messages: RestMessage[];
  pagination: { limit: number; offset: number; order: string; returned: number };
}

export class HistoryError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`history_http_${status}:${detail}`);
  }
}

export interface ReadOptions {
  /** How long a read waits for the gateway (restart, 02 §History reader); default 20 s, under host RPC's 30 s. */
  waitMs?: number;
}

const RETRY_MS = [1000, 2000, 5000];

/** `GET /api/sessions?profile=<name>`: one page, max 100 rows (`limit`, `offset`, `order`, `archived`, …). */
export function listSessions(
  rootHome: string,
  profile: string,
  query: { limit?: number; offset?: number; order?: "created" | "recent"; archived?: "exclude" | "only" | "include"; min_messages?: number } = {},
  opts?: ReadOptions,
): Promise<SessionsPage> {
  return get<SessionsPage>(rootHome, profile, "/api/sessions", query, opts);
}

/**
 * `GET /api/sessions/{id}/messages?profile=<name>`: one page, max 500 rows. Pass `order: "oldest"` with an
 * explicit `limit` to page from the root; `include_compacted` adds rows an in-place compaction set inactive.
 */
export function readMessages(
  rootHome: string,
  profile: string,
  sessionId: string,
  query: { limit?: number; offset?: number; order?: "oldest" | "latest"; include_compacted?: boolean } = {},
  opts?: ReadOptions,
): Promise<MessagesPage> {
  return get<MessagesPage>(rootHome, profile, `/api/sessions/${encodeURIComponent(sessionId)}/messages`, query, opts);
}

const CHAIN_PAGE = 500;

/**
 * Every message of a chain, root to tip (02 §History reader): `order=oldest`, `include_compacted=true`, pages
 * of 500 by `offset` until a short page. A rotated chain lists cloned rows twice: `groupTurns` dedupes them.
 */
export async function readChain(rootHome: string, profile: string, sessionId: string, opts?: ReadOptions): Promise<{ session_id: string; messages: RestMessage[] }> {
  const messages: RestMessage[] = [];
  for (let offset = 0; ; ) {
    // Hermes' default offset is 0; leaving it out keeps the first read identical to a plain one.
    const page = await readMessages(rootHome, profile, sessionId, { order: "oldest", limit: CHAIN_PAGE, include_compacted: true, ...(offset ? { offset } : {}) }, opts);
    messages.push(...page.messages);
    offset += page.messages.length;
    if (page.messages.length < CHAIN_PAGE) return { session_id: page.session_id, messages };
  }
}

/** One turn of a chain, as Hermes' own view shows it, with full rows for rendering. */
export interface ChainTurn {
  /** The user row's `message_uid`, else (hidden or no user row) the first reply row's. */
  anchor_uid: string;
  /** The row that opened the turn; null when the turn starts with reply rows. A hidden one stays here. */
  user: RestMessage | null;
  /** Mid-turn steers (`display_kind: steer` user rows): part of this turn, never anchors. */
  steers: RestMessage[];
  /** Assistant and tool rows, in order; hidden rows left out. */
  replies: RestMessage[];
  /** The user row's `display_metadata.submission_id` (`bb:` on bb's own sends; A4: none on steers or `/retry`). */
  submission_id: string | null;
  /** Unix ms of the anchor row. */
  ts: number;
}

/**
 * Hermes rows → turns by 02 §Mapping db anchor rules and T0.5 (A8): dedupe by `message_uid` (first wins); a
 * user row opens a turn unless it is a steer, which joins the running turn; hidden reply rows are skipped;
 * a turn whose user row is hidden anchors on its first reply, and waits for one to appear.
 */
export function groupTurns(messages: RestMessage[]): ChainTurn[] {
  const seen = new Set<string>();
  const open: { user: RestMessage | null; steers: RestMessage[]; replies: RestMessage[] }[] = [];
  for (const m of messages) {
    if (seen.has(m.message_uid)) continue;
    seen.add(m.message_uid);
    const opens = m.role === "user" && m.display_kind !== "steer";
    if (opens) open.push({ user: m, steers: [], replies: [] });
    else if (m.role !== "user" && m.display_kind === "hidden") continue;
    else {
      if (!open.length) open.push({ user: null, steers: [], replies: [] });
      const turn = open.at(-1)!;
      (m.role === "user" ? turn.steers : turn.replies).push(m);
    }
  }
  const turns: ChainTurn[] = [];
  for (const t of open) {
    const anchor = t.user && t.user.display_kind !== "hidden" ? t.user : t.replies[0];
    if (!anchor) continue;
    turns.push({
      anchor_uid: anchor.message_uid,
      ...t,
      submission_id: t.user?.display_metadata?.submission_id ?? null,
      ts: Math.round(anchor.timestamp * 1000),
    });
  }
  return turns;
}

/** The host contract's view of a turn; the caller sets `complete`. */
export function summarizeTurn(turn: ChainTurn): Omit<HistoryTurn, "complete"> {
  const hidden = turn.user?.display_kind === "hidden";
  return {
    anchor_uid: turn.anchor_uid,
    user_text: turn.user && !hidden ? (turn.user.display_content ?? turn.user.content) : null,
    user_hidden: hidden,
    submission_id: turn.submission_id,
    reply_uids: turn.replies.map((m) => m.message_uid),
    ts: turn.ts,
  };
}

/** The served `profile_id` of a profile name: `default` is the root, others live in `<root>/profiles/<name>`. */
function profileId(endpoint: GatewayEndpoint, rootHome: string, profile: string): string {
  const want = canonicalHome(profile === "default" ? rootHome : `${canonicalHome(rootHome)}/profiles/${profile}`);
  const served = endpoint.servedProfiles.find((p) => canonicalHome(p.home) === want);
  if (!served) throw new ControlError("profile_not_served");
  return served.profile_id;
}

async function get<T>(rootHome: string, profile: string, path: string, query: object, opts: ReadOptions = {}): Promise<T> {
  const params = new URLSearchParams({ profile });
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  const deadline = Date.now() + (opts.waitMs ?? 20_000);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      const endpoint = await discoverEndpoint(rootHome);
      const ticket = await mintTicket(endpoint, "native-http", profileId(endpoint, rootHome, profile));
      // Node's fetch sends no Origin; the gateway refuses any (`native_http.py:207`).
      res = await fetch(`${endpoint.apiOrigin}${path}?${params}`, { headers: { [NATIVE_HTTP_HEADER]: ticket } });
    } catch (err) {
      // The gateway is restarting (no socket, not ready, listener gone): wait, never start one.
      const retryable = err instanceof TypeError || (err instanceof ControlError && /^(no_gateway|not_ready:|control_)/.test(err.reason));
      const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!;
      if (!retryable || Date.now() + delay > deadline) throw err;
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    if (res.ok) return (await res.json()) as T;
    const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    throw new HistoryError(res.status, typeof body?.detail === "string" ? body.detail.slice(0, 200) : "");
  }
}

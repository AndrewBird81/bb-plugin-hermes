// History reads for the server (02 §Contracts, §History reader): REST list rows, chat turns and the Bot Chat lookup.
// Read-only Hermes routes; outputs hold ids, titles and bounded fields only (never `system_prompt`,
// `model_config` or `origin_json`, 02 §bb access and security).
import { HermesRpcError, type HermesClient } from "../hermes/client.js";
import { groupTurns, listSessions, summarizeTurn, type RestMessage, type RestSessionRow, type SessionsPage } from "../hermes/history.js";
import type { ProfileRow } from "../hermes/types.js";
import type { BotChat, HistoryTurn, SessionRow } from "../shared/host-contract.js";

/** The REST list's page cap (`le=100`, `hermes_cli/web_routers/sessions.py:182`). */
export const LIST_PAGE = 100;

/** Hermes REST times are Unix seconds (float); the host contract speaks Unix ms. */
const toMs = (s: number | null | undefined) => (typeof s === "number" && Number.isFinite(s) ? Math.round(s * 1000) : null);

export function toSessionRow(r: RestSessionRow): SessionRow {
  return {
    session_id: r.id,
    lineage_root: r.chat_id ?? r.id,
    title: r.title ?? null,
    source: r.source ?? null,
    created_source: r.created_source ?? null,
    hidden: Boolean(r.hidden),
    archived: Boolean(r.archived),
    cwd: r.cwd ?? null,
    message_count: Number.isInteger(r.message_count) ? r.message_count : 0,
    last_activity_at: toMs(r.last_activity_at),
    legacy: !r.chat_id,
  };
}

export type ListPage = (query: { limit: number; offset?: number; order: "recent"; archived: "include" }) => Promise<SessionsPage>;

/**
 * Every list page (`order=recent`, archived included), rows active since `since` (Unix ms). Stops at a
 * short or last page, or at a page with no row that recent. A row seen on two pages (activity moved it
 * meanwhile) counts once.
 */
export async function listAllSessions(page: ListPage, since?: number): Promise<SessionRow[]> {
  const rows = new Map<string, SessionRow>();
  const recent = (r: SessionRow) => since === undefined || (r.last_activity_at !== null && r.last_activity_at >= since);
  for (let offset = 0; ; offset += LIST_PAGE) {
    const res = await page({ order: "recent", archived: "include", limit: LIST_PAGE, ...(offset ? { offset } : {}) });
    const mapped = res.sessions.map(toSessionRow);
    for (const r of mapped) if (recent(r) && !rows.has(r.session_id)) rows.set(r.session_id, r);
    if (res.sessions.length < LIST_PAGE || offset + LIST_PAGE >= res.total || !mapped.some(recent)) break;
  }
  return [...rows.values()];
}

export function listProfileSessions(rootHome: string, profile: string, since?: number): Promise<SessionRow[]> {
  return listAllSessions((q) => listSessions(rootHome, profile, q, { waitMs: 10_000 }), since);
}

/**
 * The Bot Chat, read-only (lead decision from the isolated evidence in `isolated/access.isolated.test.ts`):
 * `profiles.list{profile, include_sessions:true}` → this profile's `canonical_session`, which Hermes fills
 * only for a Bot Chat it owns (`gateway/session_group_controls.py:305-346`: "Discovery is read-only"). A
 * legacy Conduit-made Bot Chat reads as `none` until a first bb send's title lookup adopts it (bridge, D16):
 * `session.list{title}` adopts, so the worker never calls it. Only ids leave: never the row's `preview`.
 */
export async function findBotChat(client: HermesClient, profile: string): Promise<BotChat> {
  let profiles: ProfileRow[];
  try {
    profiles = (await client.profilesList({ profile, include_sessions: true })).profiles;
  } catch (err) {
    if (err instanceof HermesRpcError && err.reason === "runtime_coordination_required") return { state: "held" };
    throw err;
  }
  // This profile's row comes first; match by name all the same.
  const chat = profiles.find((p) => p.name === profile)?.canonical_session;
  if (!chat?.id) return { state: "none" };
  return { state: "found", lineage_root: chat.id, session_id: chat.resolved_id || chat.id, legacy: false };
}

/**
 * A16: host RPC output is capped at 8 MiB (bb's host limits). `readTurns` keeps its answer under half of
 * that, newest turns first, and says `truncated` when it leaves older ones out.
 */
export const TURNS_MAX_BYTES = 4 * 1024 * 1024;

export interface TurnsQuery {
  after_uid?: string;
  since?: number;
  /** Is the chat's tip (or its lineage root) running a turn now? */
  running: () => Promise<boolean>;
  maxBytes?: number;
}

/**
 * A chat's turns, root to tip (02 §Contracts `readTurns`): every message of the chain grouped by the anchor
 * rules (`groupTurns`). `after_uid`: only turns after that anchor (unknown → every turn). `since` (Unix ms):
 * only turns from then on. `complete`: a later turn exists, or the chat isn't running. `truncated`: older
 * turns exist that the answer leaves out, by `since` or by the size cap.
 */
export async function readHistoryTurns(chain: { session_id: string; messages: RestMessage[] }, q: TurnsQuery): Promise<{ session_id: string; turns: HistoryTurn[]; truncated: boolean }> {
  let turns = groupTurns(chain.messages).map(summarizeTurn);
  const after = q.after_uid ? turns.findIndex((t) => t.anchor_uid === q.after_uid) : -1;
  if (after >= 0) turns = turns.slice(after + 1);
  let truncated = false;
  if (q.since !== undefined) {
    const kept = turns.filter((t) => t.ts >= q.since!);
    truncated = kept.length < turns.length;
    turns = kept;
  }
  const running = turns.length ? await q.running().catch(() => true) : false;
  const out: HistoryTurn[] = turns.map((t, i) => ({ ...t, complete: i < turns.length - 1 || !running }));
  const max = q.maxBytes ?? TURNS_MAX_BYTES;
  let bytes = 0;
  let first = out.length;
  while (first > 0) {
    const size = Buffer.byteLength(JSON.stringify(out[first - 1])) + 1;
    if (bytes + size > max) break;
    bytes += size;
    first--;
  }
  return { session_id: chain.session_id, turns: out.slice(first), truncated: truncated || first > 0 };
}

/** Is `ids` running, per the live `session.list` (02 §Contracts `readTurns`)? */
export async function isRunning(client: HermesClient, profile: string, ids: string[]): Promise<boolean> {
  const { sessions } = await client.sessionList({ profile, include_hidden: true });
  return sessions.some((s) => s.running && (ids.includes(s.session_id) || (s.resolved_id != null && ids.includes(s.resolved_id))));
}

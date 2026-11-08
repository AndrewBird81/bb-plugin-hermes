// History reads for the server (02 §Contracts, §History reader): REST list rows and the Bot Chat lookup.
// Read-only Hermes routes; outputs hold ids, titles and bounded fields only (never `system_prompt`,
// `model_config` or `origin_json`, 02 §bb access and security).
import { HermesRpcError, type HermesClient } from "../hermes/client.js";
import { listSessions, type RestSessionRow, type SessionsPage } from "../hermes/history.js";
import type { BotChat, SessionRow } from "../shared/host-contract.js";

/** The REST list's page cap (`le=100`, `hermes_cli/web_routers/sessions.py:182`). */
export const LIST_PAGE = 100;
export const BOT_CHAT_TITLE = "Bot Chat";

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

/** A canonical title-lookup row (`gateway/session_controls.py` `list_sessions`, title branch). */
interface TitleRow {
  /** The logical id (`chat_id`, or an adopted legacy row's own id): what resume and submit address. */
  session_id: string;
  /** The row holding the title: the physical tip once a rotating compaction moved the title to it. */
  id?: string;
  resolved_id?: string | null;
  title?: string;
}

/**
 * S8 step 1: `session.list{profile, title:"Bot Chat", include_hidden:true}`. Never creates.
 * `runtime_coordination_required` (Conduit holds an unadopted Bot Chat, S8 E6) → `held`.
 */
export async function findBotChat(client: HermesClient, profile: string): Promise<BotChat> {
  let rows: TitleRow[];
  try {
    rows = (await client.sessionList({ profile, title: BOT_CHAT_TITLE, include_hidden: true })).sessions as unknown as TitleRow[];
  } catch (err) {
    if (err instanceof HermesRpcError && err.reason === "runtime_coordination_required") return { state: "held" };
    throw err;
  }
  const row = rows[0];
  if (!row?.session_id) return { state: "none" };
  // Hermes' title lookup resolves through `resolve_local_target`: a gateway-owned chat answers with its
  // `chat_id`, and an unadopted legacy row is adopted by the lookup itself (or refused while held), so a
  // found Bot Chat is never legacy here.
  return { state: "found", lineage_root: row.session_id, session_id: row.id ?? row.resolved_id ?? row.session_id, legacy: false };
}

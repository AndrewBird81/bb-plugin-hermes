// An independent count of the chats a bot's switch-on would import (03 P2 gate, 01 §7 AC): read from the
// profile's `state.db` with `sqlite3 -readonly` only (no gateway, no REST, no ticket), so the owner can run it
// against a live Hermes. Re-implements the rules from the plan, not `src/`:
//   - surface (`source`, or `created_source` for `source=local`) ∈ {cli, tui, gui, desktop};
//   - one per chat: `chat_id` (when it names a row: a chat app stores its platform's chat id there), else the row's id; rows the REST list leaves out (compression continuations,
//     delegates, `tool` children: `hermes_state_sessions.py:126-129`) never count on their own;
//   - not hidden, ≥ 1 message, not titled `Bot Chat` (the bot thread holds it), not bb-created (a `bb:`
//     create `request_id` or first-turn `submission_id`);
//   - activity = max(`last_activity_at`, newest message, `started_at`) over the chat ≥ since.
// `--data-db <plugin data.db>` subtracts what bb already holds: bindings and tombstones of that profile.
//   npx tsx e2e/eligibility.ts --folder <hermes folder> --profile <name> [--since <unix s>] [--data-db <path>] [--list]
// Prints one JSON object; `--list` adds the chats (ids, titles: keep the output out of the repo on live).
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export const SURFACES = new Set(["cli", "tui", "gui", "desktop"]);
export const BOT_CHAT = "Bot Chat";
const DAY = 86_400;

export type Reason = "source" | "hidden" | "empty" | "bb-created" | "inactive";

export interface Chat {
  lineage_root: string;
  /** The row the REST list shows for it (its compression tip). */
  session_id: string;
  title: string | null;
  surface: string | null;
  archived: boolean;
  /** Unix seconds. */
  last_active: number;
}

export interface Result {
  profile: string;
  profile_home: string;
  /** Unix seconds. */
  since: number;
  /** Eligible and active chats bb doesn't hold yet: what a switch-on imports. */
  would_import: number;
  /** Eligible and active chats in all, held by bb or not. */
  eligible: number;
  held: { bound: number; tombstoned: number };
  /** The profile's Bot Chat (a visible-list title or a hidden one): the bot thread's, never counted. */
  bot_chat: { present: boolean; active: boolean };
  out: Record<Reason, number>;
  chats?: Chat[];
}

interface Row {
  id: string;
  source: string | null;
  created_source: string | null;
  chat_id: string | null;
  parent: string | null;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  last_activity_at: number | null;
  title: string | null;
  hidden: number;
  archived: number;
  branched: number;
  delegate: number;
  reset: number;
  session_key: string | null;
  last_message: number | null;
  messages: number;
  first_submission: string | null;
  request_id: string | null;
}

/** `sqlite3 -readonly -json`: never a write, never a lock beyond a reader's. */
export function query<T>(db: string, sql: string): T[] {
  const out = execFileSync("sqlite3", ["-readonly", "-json", db, sql], { encoding: "utf8", maxBuffer: 256 << 20 });
  return out.trim() ? (JSON.parse(out) as T[]) : [];
}

const marker = (name: string) => `(CASE WHEN json_valid(s.model_config) THEN json_extract(s.model_config, '$.${name}') END) IS NOT NULL`;

// Only the columns the rules need: never `system_prompt`, `model_config` values, `origin_json` or message text.
const SESSIONS_SQL = `
SELECT s.id, s.source, s.created_source, s.chat_id, s.parent_session_id AS parent, s.started_at, s.ended_at, s.end_reason,
  s.last_activity_at, s.title, s.hidden, s.archived, s.session_key,
  ${marker("_branched_from")} AS branched, ${marker("_delegate_from")} AS delegate, ${marker("_reset_from")} AS reset,
  (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id) AS last_message,
  (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messages,
  (SELECT CASE WHEN json_valid(m.display_metadata) THEN json_extract(m.display_metadata, '$.submission_id') END
     FROM messages m WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.id LIMIT 1) AS first_submission,
  (SELECT CASE WHEN json_valid(k.value) THEN json_extract(k.value, '$.request_id') END
     FROM state_meta k WHERE k.key = 'gateway.local_policy.v1:' || s.id) AS request_id
FROM sessions s`;

/** Hermes' reset end reasons (`hermes_state_common.py:179`): a same-key child after one is a new conversation. */
const RESET_ENDS = new Set(["session_reset", "session_switch", "idle", "daily", "suspended", "resume_pending_expired"]);

export function surfaceOf(r: { source: string | null; created_source: string | null }): string | null {
  return r.source === "local" ? r.created_source : r.source;
}

export function profileHome(folder: string, profile: string): string {
  const home = profile === "default" ? folder : path.join(folder, "profiles", profile);
  return existsSync(home) ? realpathSync(home) : home;
}

export function count(opts: { folder: string; profile: string; since?: number; dataDb?: string; list?: boolean }): Result {
  const home = profileHome(opts.folder, opts.profile);
  const db = path.join(home, "state.db");
  if (!existsSync(db)) throw new Error(`no state.db in ${home}`);
  const since = opts.since ?? Math.floor(Date.now() / 1000) - 30 * DAY;
  const rows = query<Row>(db, SESSIONS_SQL);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map<string, Row[]>();
  for (const r of rows) if (r.parent) children.set(r.parent, [...(children.get(r.parent) ?? []), r]);

  // The REST list's rows (`_LISTABLE_CHILD_SQL`, no delegate): roots, branch and reset children.
  const branchChild = (r: Row) => {
    const p = byId.get(r.parent!);
    return !!r.branched || (!!p && p.end_reason === "branched" && p.ended_at !== null && r.started_at >= p.ended_at);
  };
  const resetChild = (r: Row) => {
    const p = byId.get(r.parent!);
    return !!r.reset || (!!p && RESET_ENDS.has(p.end_reason ?? "") && !!r.session_key && r.session_key === p.session_key);
  };
  const listed = (r: Row) => !r.delegate && (!r.parent || branchChild(r) || resetChild(r));
  // A compression continuation (`_CHAIN_STEP_SQL`): the newest one is the chain's tip.
  const continuation = (r: Row) => !r.branched && !r.delegate && !resetChild(r) && r.source !== "tool";
  const tipOf = (r: Row): Row => {
    for (let cur = r, seen = new Set<string>(); ; ) {
      seen.add(cur.id);
      if (cur.end_reason !== "compression") return cur;
      const next = (children.get(cur.id) ?? []).filter((c) => continuation(c) && !seen.has(c.id)).sort((a, b) => b.started_at - a.started_at)[0];
      if (!next) return cur;
      cur = next;
    }
  };

  // One chat per `chat_id` (else the row's id): every row of it, listed or not, for activity and messages. Only a
  // `chat_id` naming a row of this store is a lineage root: a chat app's rows carry the platform's chat id there.
  const key = (r: Row) => (r.chat_id && byId.has(r.chat_id) ? r.chat_id : r.id);
  const groups = new Map<string, Row[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);

  const held = new Set<string>();
  const tombs = new Set<string>();
  if (opts.dataDb) {
    const h = `'${home.replaceAll("'", "''")}'`;
    const ids = (sql: string) => query<{ id: string }>(opts.dataDb!, sql).map((x) => x.id);
    for (const id of ids(`SELECT lineage_root AS id FROM bindings WHERE profile_home = ${h} AND lineage_root IS NOT NULL UNION SELECT session_id FROM bindings WHERE profile_home = ${h} AND session_id IS NOT NULL`)) held.add(id);
    for (const id of ids(`SELECT lineage_root AS id FROM tombstones WHERE profile_home = ${h}`)) tombs.add(id);
  }

  const out: Record<Reason, number> = { source: 0, hidden: 0, empty: 0, "bb-created": 0, inactive: 0 };
  const result: Result = { profile: opts.profile, profile_home: home, since, would_import: 0, eligible: 0, held: { bound: 0, tombstoned: 0 }, bot_chat: { present: false, active: false }, out };
  const chats: Chat[] = [];
  for (const [root, all] of groups) {
    const heads = all.filter(listed);
    if (!heads.length) continue;
    // The conversation's row: its latest listed segment (a reset lineage lists once, `exclude_superseded_segments`).
    const head = heads.sort((a, b) => b.started_at - a.started_at)[0]!;
    const tip = tipOf(head);
    const title = tip.title ?? head.title;
    const lastActive = Math.max(...all.map((r) => Math.max(r.last_activity_at ?? 0, r.last_message ?? 0, r.started_at)));
    const active = lastActive >= since;
    if (title === BOT_CHAT) {
      result.bot_chat = { present: true, active: result.bot_chat.active || active };
      continue;
    }
    const first = all.filter((r) => !r.parent).sort((a, b) => a.started_at - b.started_at)[0] ?? head;
    const reason: Reason | null = !SURFACES.has(surfaceOf(head) ?? "")
      ? "source"
      : head.hidden
        ? "hidden"
        : all.every((r) => r.messages < 1)
          ? "empty"
          : all.some((r) => r.request_id?.startsWith("bb:")) || first.first_submission?.startsWith("bb:")
            ? "bb-created"
            : !active
              ? "inactive"
              : null;
    if (reason) {
      out[reason]++;
      continue;
    }
    result.eligible++;
    const ids = [root, ...all.map((r) => r.id)];
    if (ids.some((id) => tombs.has(id))) result.held.tombstoned++;
    else if (ids.some((id) => held.has(id))) result.held.bound++;
    else {
      result.would_import++;
      chats.push({ lineage_root: root, session_id: tip.id, title, surface: surfaceOf(head), archived: !!head.archived, last_active: lastActive });
    }
  }
  if (opts.list) result.chats = chats.sort((a, b) => a.last_active - b.last_active);
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const folder = flag("folder");
  const profile = flag("profile");
  if (!folder || !profile) {
    console.error("usage: npx tsx e2e/eligibility.ts --folder <hermes folder> --profile <name> [--since <unix s>] [--data-db <plugin data.db>] [--list]");
    process.exit(2);
  }
  const since = flag("since");
  console.log(JSON.stringify(count({ folder, profile, since: since ? Number(since) : undefined, dataDb: flag("data-db"), list: args.includes("--list") }), null, 1));
}

// Mapping db (02 §Mapping db): bindings, turns, bots, tombstones, kv. Ids, states and times only:
// no transcript text in any column (02 §bb access and security).
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type Db = ReturnType<BbPluginApi["storage"]["database"]>;

/** Append-only: never edit or reorder a shipped entry, only push new ones (one transaction at load). */
export const MIGRATIONS = [
  `CREATE TABLE bindings (
    thread_id TEXT PRIMARY KEY,
    profile_home TEXT NOT NULL,
    lineage_root TEXT,
    session_id TEXT,
    expected_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('bot', 'chat', 'mirror')),
    source TEXT,
    tag TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'replaying', 'live')),
    legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1)),
    archived_by_switch INTEGER NOT NULL DEFAULT 0 CHECK (archived_by_switch IN (0, 1)),
    title_set TEXT,
    UNIQUE (profile_home, lineage_root)
  );
  CREATE UNIQUE INDEX bindings_one_bot ON bindings (profile_home) WHERE kind = 'bot';
  CREATE TABLE turns (
    thread_id TEXT NOT NULL,
    anchor_uid TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('replay', 'mirror', 'bb')),
    state TEXT NOT NULL CHECK (state IN ('queued', 'done', 'partial')),
    reply_uids TEXT NOT NULL DEFAULT '[]',
    at INTEGER NOT NULL,
    PRIMARY KEY (thread_id, anchor_uid)
  );
  CREATE TABLE bots (
    profile_home TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    enabled_at INTEGER
  );
  CREATE TABLE tombstones (
    profile_home TEXT NOT NULL,
    lineage_root TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (profile_home, lineage_root)
  );
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // P1: the describe facts `deriveProviderOptions` needs before the worker answers; the wake cursor;
  // a rest wake's prior state, so a failed send (or boot recovery) reverts it instead of deleting it.
  `ALTER TABLE bots ADD COLUMN handle TEXT;
  ALTER TABLE bots ADD COLUMN cwd TEXT;
  ALTER TABLE bindings ADD COLUMN cursor_uid TEXT;
  ALTER TABLE turns ADD COLUMN prev_state TEXT CHECK (prev_state IN ('done', 'partial'));`,
];

export function openMappingDb(bb: BbPluginApi): Db {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  return db;
}

export type BindingKind = "bot" | "chat" | "mirror";
export type BindingState = "pending" | "replaying" | "live";

export interface Binding {
  thread_id: string;
  profile_home: string;
  /** Null until the first send creates the session. */
  lineage_root: string | null;
  session_id: string | null;
  expected_id: string | null;
  kind: BindingKind;
  source: string | null;
  tag: string | null;
  state: BindingState;
  legacy: boolean;
  archived_by_switch: boolean;
  /** sha256 hex of the last title the plugin set (title follow, T2.3); never the text, which can quote a message. */
  title_set: string | null;
  /** Wakes read turns after this anchor: every turn up to it is shown and complete. Null → every turn. */
  cursor_uid: string | null;
}

interface BindingRow extends Omit<Binding, "legacy" | "archived_by_switch"> {
  legacy: number;
  archived_by_switch: number;
}

const fromRow = (row: BindingRow | undefined): Binding | null =>
  row ? { ...row, legacy: row.legacy === 1, archived_by_switch: row.archived_by_switch === 1 } : null;

/** Throws on a second thread for one `(profile_home, lineage_root)` or a second bot thread per profile. */
export function insertBinding(db: Db, binding: Omit<Binding, "cursor_uid"> & { cursor_uid?: string | null }): void {
  db.prepare(
    `INSERT INTO bindings (thread_id, profile_home, lineage_root, session_id, expected_id, kind, source, tag, state, legacy, archived_by_switch, title_set, cursor_uid)
     VALUES (@thread_id, @profile_home, @lineage_root, @session_id, @expected_id, @kind, @source, @tag, @state, @legacy, @archived_by_switch, @title_set, @cursor_uid)`,
  ).run({ cursor_uid: null, ...binding, legacy: binding.legacy ? 1 : 0, archived_by_switch: binding.archived_by_switch ? 1 : 0 });
}

type BindingPatch = Partial<Pick<Binding, "lineage_root" | "session_id" | "state" | "legacy" | "archived_by_switch" | "title_set" | "cursor_uid" | "tag">>;

export function updateBinding(db: Db, threadId: string, patch: BindingPatch): void {
  const keys = Object.keys(patch) as (keyof BindingPatch)[];
  if (!keys.length) return;
  const values: Record<string, unknown> = { thread_id: threadId };
  for (const key of keys) values[key] = typeof patch[key] === "boolean" ? (patch[key] ? 1 : 0) : patch[key];
  db.prepare(`UPDATE bindings SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE thread_id = @thread_id`).run(values);
}

/** The binding and its turns; `thread.deleted`. */
export function deleteBinding(db: Db, threadId: string): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM turns WHERE thread_id = ?`).run(threadId);
    db.prepare(`DELETE FROM bindings WHERE thread_id = ?`).run(threadId);
  })();
}

export function bindingsOf(db: Db, profileHome: string): Binding[] {
  return (db.prepare(`SELECT * FROM bindings WHERE profile_home = ? ORDER BY rowid`).all(profileHome) as BindingRow[]).map((r) => fromRow(r)!);
}

export function allBindings(db: Db): Binding[] {
  return (db.prepare(`SELECT * FROM bindings ORDER BY rowid`).all() as BindingRow[]).map((r) => fromRow(r)!);
}

export function botBinding(db: Db, profileHome: string): Binding | null {
  return fromRow(db.prepare(`SELECT * FROM bindings WHERE profile_home = ? AND kind = 'bot'`).get(profileHome) as BindingRow | undefined);
}

/** A row of `bots`: the describe facts the server keeps, so provider options work before the worker answers. */
export interface BotRecord {
  profile_home: string;
  name: string;
  handle: string | null;
  cwd: string | null;
  enabled: boolean;
  enabled_at: number | null;
}

interface BotRecordRow extends Omit<BotRecord, "enabled"> {
  enabled: number;
}

const botFromRow = (row: BotRecordRow | undefined): BotRecord | null => (row ? { ...row, enabled: row.enabled === 1 } : null);

export function botRecord(db: Db, profileHome: string): BotRecord | null {
  return botFromRow(db.prepare(`SELECT * FROM bots WHERE profile_home = ?`).get(profileHome) as BotRecordRow | undefined);
}

export function botByName(db: Db, name: string): BotRecord | null {
  return botFromRow(db.prepare(`SELECT * FROM bots WHERE name = ? ORDER BY enabled DESC LIMIT 1`).get(name) as BotRecordRow | undefined);
}

export function enabledBots(db: Db): BotRecord[] {
  return (db.prepare(`SELECT * FROM bots WHERE enabled = 1 ORDER BY profile_home`).all() as BotRecordRow[]).map((r) => botFromRow(r)!);
}

/** Describe facts only; the switch is `setBotEnabled`. True when a stored fact changed. */
export function upsertBot(db: Db, bot: { profile_home: string; name: string; handle: string | null; cwd: string | null }): boolean {
  return (
    db
      .prepare(
        `INSERT INTO bots (profile_home, name, handle, cwd) VALUES (@profile_home, @name, @handle, @cwd)
         ON CONFLICT (profile_home) DO UPDATE SET name = excluded.name, handle = excluded.handle, cwd = excluded.cwd
         WHERE name IS NOT excluded.name OR handle IS NOT excluded.handle OR cwd IS NOT excluded.cwd`,
      )
      .run(bot).changes === 1
  );
}

/** `enabled_at` moves only when the switch goes from off to on. */
export function setBotEnabled(db: Db, profileHome: string, on: boolean, at: number): void {
  db.prepare(`UPDATE bots SET enabled_at = CASE WHEN @on = 1 AND enabled = 0 THEN @at ELSE enabled_at END, enabled = @on WHERE profile_home = @home`).run({
    on: on ? 1 : 0,
    at,
    home: profileHome,
  });
}

export function bindingByThread(db: Db, threadId: string): Binding | null {
  return fromRow(db.prepare(`SELECT * FROM bindings WHERE thread_id = ?`).get(threadId) as BindingRow | undefined);
}

export function bindingByLineage(db: Db, profileHome: string, lineageRoot: string): Binding | null {
  return fromRow(
    db.prepare(`SELECT * FROM bindings WHERE profile_home = ? AND lineage_root = ?`).get(profileHome, lineageRoot) as BindingRow | undefined,
  );
}

/**
 * For `diagnostics` (03 §Phase gates). A duplicate is a second binding for one Hermes chat: its
 * identity is the lineage root, else the bb-created `expected_id` (a side chat re-listed before its
 * first boundary). `UNIQUE` covers lineage roots alone, so this catches a pending row that collides.
 */
export function bindingCounts(db: Db): { total: number; duplicates: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COUNT(COALESCE(lineage_root, expected_id))
                - COUNT(DISTINCT profile_home || char(0) || COALESCE(lineage_root, expected_id)) AS duplicates
       FROM bindings`,
    )
    .get() as { total: number; duplicates: number };
  return { total: row.total, duplicates: row.duplicates };
}

export type TurnKind = "replay" | "mirror" | "bb";
export type TurnState = "queued" | "done" | "partial";

export interface TurnRow {
  thread_id: string;
  anchor_uid: string;
  kind: TurnKind;
  state: TurnState;
  reply_uids: string[];
  at: number;
  /** Set while a rest wake is queued: the state to go back to if it fails. */
  prev_state: "done" | "partial" | null;
}

const turnFromRow = (row: (Omit<TurnRow, "reply_uids"> & { reply_uids: string }) | undefined): TurnRow | null =>
  row ? { ...row, reply_uids: JSON.parse(row.reply_uids) as string[] } : null;

/**
 * Wake atomicity (R1 M1): true only if this call inserted the `queued` row, so only then send.
 * `at`: the anchor's Hermes time (Unix ms). `reply_uids`: the reply rows the wake will show.
 */
export function claimTurn(db: Db, turn: { thread_id: string; anchor_uid: string; kind: TurnKind; at: number; reply_uids?: string[] }): boolean {
  return (
    db
      .prepare(
        `INSERT OR IGNORE INTO turns (thread_id, anchor_uid, kind, state, reply_uids, at) VALUES (@thread_id, @anchor_uid, @kind, 'queued', @reply_uids, @at)`,
      )
      .run({ ...turn, reply_uids: JSON.stringify(turn.reply_uids ?? []) }).changes === 1
  );
}

/** A rest wake (`mirror{rest:true}`): claims a shown turn again, once, for its new reply rows. */
export function claimRest(db: Db, threadId: string, anchorUid: string, replyUids: string[]): boolean {
  return (
    db
      .prepare(
        `UPDATE turns SET prev_state = state, state = 'queued', reply_uids = ?
         WHERE thread_id = ? AND anchor_uid = ? AND kind IN ('mirror', 'replay') AND state IN ('done', 'partial')`,
      )
      .run(JSON.stringify(replyUids), threadId, anchorUid).changes === 1
  );
}

/**
 * A failed send frees its claim, so the next re-list can wake it again (R1 M1): a new claim is deleted;
 * a rest claim goes back to its prior state (with no reply uids, so the rest is woken again).
 */
export function releaseTurn(db: Db, threadId: string, anchorUid: string): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM turns WHERE thread_id = ? AND anchor_uid = ? AND state = 'queued' AND prev_state IS NULL`).run(threadId, anchorUid);
    db.prepare(
      `UPDATE turns SET state = prev_state, prev_state = NULL, reply_uids = '[]' WHERE thread_id = ? AND anchor_uid = ? AND state = 'queued' AND prev_state IS NOT NULL`,
    ).run(threadId, anchorUid);
  })();
}

export function turnRow(db: Db, threadId: string, anchorUid: string): TurnRow | null {
  return turnFromRow(db.prepare(`SELECT * FROM turns WHERE thread_id = ? AND anchor_uid = ?`).get(threadId, anchorUid) as never);
}

export function queuedTurnsOf(db: Db, threadId: string): TurnRow[] {
  return (db.prepare(`SELECT * FROM turns WHERE thread_id = ? AND state = 'queued' ORDER BY at, rowid`).all(threadId) as never[]).map((r) => turnFromRow(r)!);
}

/** A queued turn's bb turn ran: `done`, or `partial` when more reply rows can still come. */
export function settleTurn(db: Db, threadId: string, anchorUid: string, state: "done" | "partial", replyUids?: string[]): void {
  db.prepare(
    `UPDATE turns SET state = @state, prev_state = NULL, reply_uids = COALESCE(@reply_uids, reply_uids) WHERE thread_id = @thread_id AND anchor_uid = @anchor_uid`,
  ).run({ state, reply_uids: replyUids ? JSON.stringify(replyUids) : null, thread_id: threadId, anchor_uid: anchorUid });
}

/** bb's own turn as Hermes stored it (`persisted-turn`, A37): never mirrored. A row already there stays. */
export function recordBbTurn(db: Db, threadId: string, anchorUid: string, replyUids: string[], at: number): void {
  db.prepare(`INSERT OR IGNORE INTO turns (thread_id, anchor_uid, kind, state, reply_uids, at) VALUES (?, ?, 'bb', 'done', ?, ?)`).run(
    threadId,
    anchorUid,
    JSON.stringify(replyUids),
    at,
  );
}

export function hasTurns(db: Db, threadId: string, kind: TurnKind): boolean {
  return db.prepare(`SELECT 1 FROM turns WHERE thread_id = ? AND kind = ? LIMIT 1`).get(threadId, kind) !== undefined;
}

export function addTombstone(db: Db, profileHome: string, lineageRoot: string, at: number): void {
  db.prepare(`INSERT OR IGNORE INTO tombstones (profile_home, lineage_root, at) VALUES (?, ?, ?)`).run(profileHome, lineageRoot, at);
}

/** Boot recovery (02 flow 9): `queued` rows; the caller re-sends those with no bb turn, or deletes them. */
export function queuedTurns(db: Db): { thread_id: string; anchor_uid: string; kind: TurnKind; at: number }[] {
  return db.prepare(`SELECT thread_id, anchor_uid, kind, at FROM turns WHERE state = 'queued' ORDER BY at, rowid`).all() as {
    thread_id: string;
    anchor_uid: string;
    kind: TurnKind;
    at: number;
  }[];
}

export function getKv(db: Db, key: string): unknown {
  const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}

export function setKv(db: Db, key: string, value: unknown): void {
  db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
}

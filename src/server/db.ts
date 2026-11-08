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
}

interface BindingRow extends Omit<Binding, "legacy" | "archived_by_switch"> {
  legacy: number;
  archived_by_switch: number;
}

const fromRow = (row: BindingRow | undefined): Binding | null =>
  row ? { ...row, legacy: row.legacy === 1, archived_by_switch: row.archived_by_switch === 1 } : null;

/** Throws on a second thread for one `(profile_home, lineage_root)` or a second bot thread per profile. */
export function insertBinding(db: Db, binding: Binding): void {
  db.prepare(
    `INSERT INTO bindings (thread_id, profile_home, lineage_root, session_id, expected_id, kind, source, tag, state, legacy, archived_by_switch, title_set)
     VALUES (@thread_id, @profile_home, @lineage_root, @session_id, @expected_id, @kind, @source, @tag, @state, @legacy, @archived_by_switch, @title_set)`,
  ).run({ ...binding, legacy: binding.legacy ? 1 : 0, archived_by_switch: binding.archived_by_switch ? 1 : 0 });
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

/** Wake atomicity (R1 M1): true only if this call inserted the `queued` row, so only then send. */
export function claimTurn(db: Db, turn: { thread_id: string; anchor_uid: string; kind: TurnKind; at: number }): boolean {
  return (
    db
      .prepare(`INSERT OR IGNORE INTO turns (thread_id, anchor_uid, kind, state, at) VALUES (@thread_id, @anchor_uid, @kind, 'queued', @at)`)
      .run(turn).changes === 1
  );
}

/** A failed send deletes its claim, so the next re-list can wake it again (R1 M1). */
export function releaseTurn(db: Db, threadId: string, anchorUid: string): void {
  db.prepare(`DELETE FROM turns WHERE thread_id = ? AND anchor_uid = ? AND state = 'queued'`).run(threadId, anchorUid);
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

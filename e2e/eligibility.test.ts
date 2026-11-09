// e2e/eligibility.ts on a small state.db built here (Hermes' column names, `hermes_state_common.py:461-560`)
// and a plugin data.db built from the server's own migrations:
//   npx vitest run --config e2e/vitest.config.ts e2e/eligibility.test.ts
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/server/db.js";
import { removeDir, tempDir } from "../test/fake-hermes/wire.js";
import { count } from "./eligibility.js";

const folder = tempDir("eligibility-");
afterAll(() => removeDir(folder));
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

const SCHEMA = `
CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, created_source TEXT, session_key TEXT, chat_id TEXT,
  model_config TEXT, system_prompt TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, end_reason TEXT,
  message_count INTEGER DEFAULT 0, title TEXT, last_activity_at REAL, archived INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
  timestamp REAL NOT NULL, display_metadata TEXT, message_uid TEXT);
CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT);`;

interface S {
  id: string;
  source?: string;
  created_source?: string | null;
  chat_id?: string | null;
  parent?: string;
  started?: number;
  ended?: number;
  end_reason?: string;
  title?: string;
  hidden?: boolean;
  archived?: boolean;
  activity?: number | null;
  model_config?: object;
  /** Message times (days ago); the first is a user row. */
  messages?: number[];
  submission?: string;
  request_id?: string;
}

function stateDb(profile: string, sessions: S[]) {
  const home = profile === "default" ? folder : path.join(folder, "profiles", profile);
  mkdirSync(home, { recursive: true });
  const db = new Database(path.join(home, "state.db"));
  db.exec(SCHEMA);
  for (const s of sessions) {
    const started = NOW - (s.started ?? 1) * DAY;
    db.prepare(`INSERT INTO sessions (id, source, created_source, chat_id, parent_session_id, started_at, ended_at, end_reason, message_count, title, last_activity_at, archived, hidden, model_config, system_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'secret prompt')`).run(
      s.id, s.source ?? "local", s.created_source === undefined ? "cli" : s.created_source, s.chat_id === undefined ? s.id : s.chat_id, s.parent ?? null, started,
      s.ended !== undefined ? NOW - s.ended * DAY : null, s.end_reason ?? null, (s.messages ?? [1]).length, s.title ?? null,
      s.activity === undefined ? null : s.activity === null ? null : NOW - s.activity * DAY, s.archived ? 1 : 0, s.hidden ? 1 : 0, s.model_config ? JSON.stringify(s.model_config) : null,
    );
    for (const [i, ago] of (s.messages ?? [1]).entries()) {
      db.prepare("INSERT INTO messages (session_id, role, content, timestamp, display_metadata, message_uid) VALUES (?, ?, 'text', ?, ?, ?)").run(
        s.id, i % 2 ? "assistant" : "user", NOW - ago * DAY, i === 0 && s.submission ? JSON.stringify({ submission_id: s.submission }) : null, `${s.id}-${i}`,
      );
    }
    if (s.request_id) db.prepare("INSERT INTO state_meta (key, value) VALUES (?, ?)").run(`gateway.local_policy.v1:${s.id}`, JSON.stringify({ request_id: s.request_id, session_id: s.id }));
  }
  db.close();
  return home;
}

const home = stateDb("neo", [
  { id: "cli", messages: [2, 2] },
  { id: "tui", created_source: "tui" },
  { id: "gui", created_source: "gui" },
  { id: "desktop", created_source: "desktop", title: "Planning" },
  // A legacy dashboard (Conduit) row: `source=desktop`, no `chat_id`.
  { id: "conduit", source: "desktop", created_source: null, chat_id: null },
  { id: "archived", archived: true },
  // Activity from the newest message, also when `last_activity_at` is null and the chat started long ago.
  { id: "old-but-recent", started: 90, messages: [90, 3] },
  { id: "heartbeat", started: 90, messages: [90], activity: 1 },
  // A rotated chain: one chat, the tip's title.
  { id: "root", end_reason: "compression", ended: 2, started: 5, messages: [5, 5], title: "Before" },
  { id: "tip", parent: "root", chat_id: "root", started: 2, messages: [2], title: "After" },
  // Out.
  { id: "cron", created_source: "cron" },
  { id: "oneshot", created_source: "oneshot" },
  { id: "acp", created_source: "acp" },
  // A chat app's rows carry the platform's chat id: two sessions, not one chat.
  { id: "discord", source: "discord", created_source: null, chat_id: "channel-1" },
  { id: "discord-2", source: "discord", created_source: "discord", chat_id: "channel-1" },
  { id: "unknown", created_source: "unknown" },
  { id: "hidden", hidden: true },
  { id: "empty", messages: [] },
  { id: "bb-side", created_source: "desktop", request_id: "bb:thr_side" },
  { id: "bb-first", submission: "bb:thr_x:req1" },
  { id: "inactive", started: 40, messages: [40, 40] },
  // A delegate child and a non-listed continuation never count on their own.
  { id: "delegate", parent: "cli", chat_id: "delegate", model_config: { _delegate_from: "cli" } },
  // The Bot Chat: hidden, its own thread's.
  { id: "botchat", created_source: "desktop", hidden: true, title: "Bot Chat" },
]);

describe("e2e/eligibility", () => {
  it("counts each eligible chat once and says why the others stay out", () => {
    const r = count({ folder, profile: "neo", list: true });
    expect(r.profile_home).toBe(home);
    expect(r.chats!.map((c) => c.lineage_root).sort()).toEqual(["archived", "cli", "conduit", "desktop", "gui", "heartbeat", "old-but-recent", "root", "tui"]);
    expect(r.would_import).toBe(9);
    expect(r.eligible).toBe(9);
    expect(r.out).toEqual({ source: 6, hidden: 1, empty: 1, "bb-created": 2, inactive: 1 });
    expect(r.bot_chat).toEqual({ present: true, active: true });
    const root = r.chats!.find((c) => c.lineage_root === "root")!;
    expect(root).toMatchObject({ session_id: "tip", title: "After", surface: "cli" });
    expect(r.chats!.find((c) => c.lineage_root === "archived")!.archived).toBe(true);
    expect(r.chats!.find((c) => c.lineage_root === "conduit")!.surface).toBe("desktop");
  });

  it("--since moves the window", () => {
    expect(count({ folder, profile: "neo", since: NOW - 100 * DAY }).would_import).toBe(10);
    expect(count({ folder, profile: "neo", since: NOW - 2.5 * DAY }).would_import).toBe(8);
  });

  it("--data-db subtracts bindings and tombstones of that profile only", () => {
    const file = path.join(folder, "data.db");
    const db = new Database(file);
    for (const m of MIGRATIONS) db.exec(m);
    const bind = db.prepare("INSERT INTO bindings (thread_id, profile_home, lineage_root, session_id, kind, state) VALUES (?, ?, ?, ?, ?, 'live')");
    bind.run("thr_1", home, "cli", "cli", "mirror");
    bind.run("thr_2", home, "root", "tip", "mirror");
    bind.run("thr_3", path.join(folder, "profiles", "other"), "tui", "tui", "mirror");
    db.prepare("INSERT INTO tombstones (profile_home, lineage_root, at) VALUES (?, ?, 0)").run(home, "gui");
    db.close();
    const r = count({ folder, profile: "neo", dataDb: file });
    expect(r.held).toEqual({ bound: 2, tombstoned: 1 });
    expect(r.would_import).toBe(6);
    expect(r.eligible).toBe(9);
  });

  it("reads no message text or prompt", () => {
    expect(JSON.stringify(count({ folder, profile: "neo", list: true }))).not.toMatch(/secret prompt|"text"/);
  });
});

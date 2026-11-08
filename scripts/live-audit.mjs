#!/usr/bin/env node
// Read-only audit of a Hermes folder for writes bb could have made (03 §Rules: live Hermes is read-only).
//   node scripts/live-audit.mjs [--folder ~/.hermes] [--since <unix seconds>]
// Per profile: sessions started since `--since` by source, sessions bb would create (`request_id` / `submission_id`
// starting `bb:`, `turn_author` bb), and the plugin's skill dir. `sqlite3 -readonly` only; never reads `.env`.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const folder = arg("--folder", "~/.hermes").replace(/^~(?=\/|$)/, os.homedir());
const since = Number(arg("--since", "0"));

const query = (db, sql) => {
  const run = spawnSync("sqlite3", ["-readonly", "-json", `file:${db}?mode=ro`, sql], { encoding: "utf8" });
  if (run.status !== 0) return { error: run.stderr.trim().slice(0, 200) };
  return run.stdout.trim() ? JSON.parse(run.stdout) : [];
};

const homes = [["default", folder]];
const profilesDir = path.join(folder, "profiles");
if (existsSync(profilesDir)) for (const name of readdirSync(profilesDir).sort()) homes.push([name, path.join(profilesDir, name)]);

const report = { folder: arg("--folder", "~/.hermes"), since, profiles: {} };
for (const [name, home] of homes) {
  const db = path.join(home, "state.db");
  if (!existsSync(db)) continue;
  report.profiles[name] = {
    sessions_since: query(db, `SELECT source, created_source, hidden, count(*) AS n FROM sessions WHERE started_at >= ${since} GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`),
    bb_admissions: query(db, `SELECT count(*) AS n FROM session_admissions WHERE request_id LIKE 'bb:%' OR payload_json LIKE '%"bb:%'`)[0]?.n ?? null,
    bb_messages: query(db, `SELECT count(*) AS n FROM messages WHERE display_metadata LIKE '%"bb:%'`)[0]?.n ?? null,
    skill_dir: existsSync(path.join(home, "skills", "bb-plugin-hermes")),
  };
}
console.log(JSON.stringify(report, null, 1));

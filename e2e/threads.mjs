#!/usr/bin/env node
// Every Hermes thread of the isolated bb, one line each: binding, title, read state, archive, pin, push level, and
// whether bb's titleFallback shows a marker (P2 checks 1, 9). `node e2e/threads.mjs [--json]`
import { execFileSync } from "node:child_process";
const sbb = (...a) => JSON.parse(execFileSync(new URL("./sbb", import.meta.url).pathname, a, { encoding: "utf8", maxBuffer: 64 << 20 }));
const db = `${process.env.HOME}/.bb-hermes-e2e/plugins/hermes/data.db`;
const bindings = Object.fromEntries(
  JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", db, "SELECT thread_id, kind, state, lineage_root, profile_home FROM bindings"], { encoding: "utf8" }) || "[]").map((b) => [b.thread_id, b]),
);
const rows = [];
for (const t of sbb("thread", "list", "--json", "--include-archived", "--include-hidden").filter((t) => t.providerId === "hermes")) {
  const full = sbb("thread", "get", t.id, "--json").thread;
  const level = sbb("push-notifications", "thread", t.id, "--json");
  const b = bindings[t.id];
  rows.push({
    id: t.id,
    kind: b?.kind ?? "unbound",
    state: b?.state ?? null,
    profile: b?.profile_home.split("/").at(-1) ?? null,
    lineage_root: b?.lineage_root ?? null,
    title: full.title,
    visibility: full.visibility,
    archived: full.archivedAt !== null,
    pinned: full.pinnedAt !== null,
    read: full.latestAttentionAt === null || (full.lastReadAt ?? 0) >= full.latestAttentionAt,
    marker_in_fallback: /<hermes-bb>/.test(full.titleFallback ?? ""),
    level: level.level ?? level.resolved ?? level,
  });
}
if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 1));
else for (const r of rows) console.log([r.id, r.kind, r.state, r.profile, r.archived ? "archived" : "-", r.pinned ? "pinned" : "-", r.read ? "read" : "UNREAD", r.marker_in_fallback ? "MARKER" : "-", JSON.stringify(r.level), JSON.stringify(r.title)].join("\t"));

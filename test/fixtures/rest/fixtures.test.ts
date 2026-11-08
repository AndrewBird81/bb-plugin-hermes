// The recorded REST projection (T0.5, 03 §Recorded fixtures): what bb may rely on, and the traps.
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { missingRestKeys } from "../../../src/hermes/contract.js";
import type { MessagesPage, RestMessage, SessionsPage } from "../../../src/hermes/history.js";
import type { RecordedExchange } from "../../fake-hermes/index.js";

const dir = import.meta.dirname;
const names = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "live-list-keys.json").map((f) => f.slice(0, -5));
const load = (name: string) => JSON.parse(readFileSync(path.join(dir, `${name}.json`), "utf8")) as { notes: Record<string, any>; exchanges: RecordedExchange[] };
const lists = (name: string) => load(name).exchanges.filter((x) => x.path === "/api/sessions").map((x) => x.body as SessionsPage);
const pages = (name: string) => load(name).exchanges.filter((x) => x.path.endsWith("/messages")).map((x) => ({ query: x.query, ...(x.body as MessagesPage) }));
const used = JSON.parse(readFileSync(path.join(dir, "../../../contract/used-surface.json"), "utf8"));

/** Turns as bb groups them: dedupe by `message_uid` (first wins), a user row opens a turn, steers and hidden rows don't count. */
function turns(rows: RestMessage[]): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const m of rows) {
    if (seen.has(m.message_uid)) continue;
    seen.add(m.message_uid);
    if (m.display_kind === "hidden" && m.role !== "user") continue;
    if (m.role === "user" && m.display_kind !== "steer") out.push([m.message_uid]);
    else out.at(-1)?.push(m.message_uid);
  }
  return out;
}

describe("recorded REST fixtures", () => {
  it("cover every scenario of 03 §Recorded fixtures", () => {
    for (const n of ["create", "compaction-in-place", "compaction-rotating", "retry", "steer", "hidden-prompt", "legacy", "conduit-held"]) expect(names).toContain(n);
  });

  it("hold no credentials, user ids, origin_json or home paths", () => {
    for (const n of names) {
      const text = readFileSync(path.join(dir, `${n}.json`), "utf8");
      expect(text, n).not.toContain(os.homedir());
      expect(text, n).not.toMatch(/"(origin_json|user_id|session_key|gateway_input_owner|ticket|api_key)": "(?!<redacted>)/);
      expect(text, n).not.toMatch(/uid:\d+/);
    }
  });

  it("A1: every key bb reads is present in the list and message rows", () => {
    for (const n of names) {
      for (const x of load(n).exchanges) {
        expect(x.status, n).toBe(200);
        const body = x.body as SessionsPage & MessagesPage;
        expect(missingRestKeys(used.rest, x.path === "/api/sessions" ? body : null, x.path === "/api/sessions" ? null : body), n).toEqual([]);
      }
    }
    expect(missingRestKeys(used.rest, { sessions: [{ id: "x" }] }, null)).toContain("rest:list.title");
  });

  it("A1: gateway rows are source local with the surface in created_source and a chat_id; the list hides hidden rows", () => {
    const [list] = lists("create");
    expect(list!.sessions[0]).toMatchObject({ source: "local", created_source: "cli", chat_id: load("create").notes.session, hidden: 0, archived: false });
    // The Bot Chat is hidden: not in the REST list (look it up with session.list), but readable by id.
    const bot = load("bot-chat").notes.session;
    expect(lists("bot-chat")[0]!.sessions.map((s) => s.id)).not.toContain(bot);
    expect(pages("bot-chat")[0]!.messages.map((m) => m.content)).toEqual(["hello bot", "echo(2): hello bot"]);
  });

  it("A4: bb's submission_id persists on submits, queued and hidden prompts; a repeated one runs once", () => {
    const sub = (m: RestMessage) => m.display_metadata?.submission_id;
    expect(pages("create")[0]!.messages.filter((m) => m.role === "user").map(sub)).toEqual(["bb:thr_rec_create:1", "bb:thr_rec_create:2"]);
    expect(load("create").notes.repeated_submit).toMatchObject({ status: "terminal", outcome: "completed" });
    const steer = pages("steer")[0]!.messages;
    expect(steer.filter((m) => m.role === "user").map((m) => [m.display_kind ?? null, sub(m) ?? null, m.display_content ?? null])).toEqual([
      [null, "bb:thr_rec_steer:1", null],
      [null, "bb:thr_rec_steer:2", null],
      // A steer is a user row of its own, with no submission_id: part of the running turn, never an anchor.
      ["steer", null, "steer words"],
      [null, "bb:thr_rec_steer:3", null],
    ]);
    expect(pages("hidden-prompt")[0]!.messages[0]).toMatchObject({ display_kind: "hidden", display_metadata: { submission_id: "bb:thr_rec_hidden:1" } });
  });

  it("/retry adds a new user row with a new uid and no submission_id; the first turn stays", () => {
    const rows = pages("retry")[0]!.messages;
    expect(rows.map((m) => [m.role, m.content, m.display_metadata?.submission_id ?? null])).toEqual([
      ["user", "first ask", "bb:thr_rec_retry:1"],
      ["assistant", "echo(2): first ask", null],
      ["user", "first ask", null],
      ["assistant", "echo(4): first ask", null],
    ]);
    expect(turns(rows)).toHaveLength(2);
  });

  it("A8: in place, read with include_compacted, deduped by uid: the same turns before and after", () => {
    const before = pages("compaction-in-place-before").find((p) => p.query.include_compacted)!;
    const after = pages("compaction-in-place");
    const full = after.find((p) => p.query.include_compacted)!;
    expect(turns(full.messages).slice(0, 4)).toEqual(turns(before.messages));
    expect(turns(full.messages)).toHaveLength(5);
    // The default view drops compacted rows: turn 3's reply then sits under turn 2 (a false "new reply").
    const active = turns(after.find((p) => !p.query.include_compacted)!.messages);
    expect(active).toHaveLength(4);
    expect(active[1]).not.toEqual(turns(before.messages)[1]);
  });

  it("A8: rotating, the tip lists cloned rows twice with the same uid; deduped, the same turns", () => {
    const before = turns(pages("compaction-rotating-before")[0]!.messages);
    const [byRoot, byTip] = pages("compaction-rotating");
    const rows = byRoot!.messages;
    expect(new Set(rows.map((m) => m.message_uid)).size).toBeLessThan(rows.length);
    expect(turns(rows).slice(0, before.length)).toEqual(before);
    expect(turns(rows)).toHaveLength(before.length + 1);
    // Any id of the chain resolves to the tip; the list shows the tip, its chat_id the root.
    expect(byRoot!.session_id).toBe(byTip!.session_id);
    const tip = lists("compaction-rotating")[0]!.sessions.find((s) => s.id === byTip!.session_id)!;
    expect(tip.chat_id).toBe(load("compaction-rotating").notes.root);
  });

  it("legacy: a dashboard (Conduit) row is source desktop with no chat_id", () => {
    const id = load("legacy").notes.session;
    const row = lists("legacy")[0]!.sessions.find((s) => s.id === id)!;
    expect(row).toMatchObject({ source: "desktop", created_source: "desktop", chat_id: null });
    expect(pages("legacy")[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("A48: REST reads a chat Conduit holds, and the read adopts nothing", () => {
    const { notes } = load("conduit-held");
    expect(notes.canonical_resume_while_held).toBe("runtime_coordination_required");
    expect(pages("conduit-held")[0]!.messages.map((m) => m.content)).toEqual(["conduit holds this chat", "echo(2): conduit holds this chat"]);
    for (const list of lists("conduit-held")) expect(list.sessions.find((s) => s.id === notes.session)).toMatchObject({ source: "desktop", chat_id: null });
  });

  it("live (read only): every served profile answered; its list rows have the recorded keys", () => {
    const live = JSON.parse(readFileSync(path.join(dir, "live-list-keys.json"), "utf8")) as { results: string[]; list_row_keys: Record<string, string[]> };
    expect(live.results.every((r) => r === "ok")).toBe(true);
    const recorded = new Set(names.flatMap((n) => lists(n).flatMap((l) => l.sessions.flatMap((s) => Object.keys(s)))));
    // Rotated tips carry the lineage keys; the live first pages had none.
    expect(Object.keys(live.list_row_keys).sort()).toEqual([...recorded].filter((k) => !["_lineage_ids", "_lineage_root_id", "continuation_kind"].includes(k)).sort());
    for (const k of used.rest.list) expect(live.list_row_keys[k], k).toBeDefined();
    for (const types of Object.values(live.list_row_keys)) for (const t of types) expect(["string", "number", "boolean", "null", "array", "object"]).toContain(t);
  });

  it("A36: the root profile is readable through the same socket too", () => {
    expect(lists("default-profile")[0]).toMatchObject({ sessions: [], total: 0 });
  });
});

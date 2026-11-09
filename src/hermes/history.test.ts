import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startFakeHermes, type FakeHermes } from "../../test/fake-hermes/index.js";
import { removeDir, tempDir } from "../../test/fake-hermes/wire.js";
import { groupTurns, HistoryError, listSessions, readChain, readMessages, summarizeTurn, type ChainTurn, type MessagesPage, type RestMessage } from "./history.js";

const fixture = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, "../../test/fixtures/rest", `${name}.json`), "utf8"));
const RECORDINGS = readdirSync(path.join(import.meta.dirname, "../../test/fixtures/rest")).filter((f) => f.endsWith(".json") && f !== "live-list-keys.json").map((f) => f.slice(0, -5));
/** Each recorded messages page: its recording, query and rows. */
const pages = (name: string): (MessagesPage & { query: Record<string, string> })[] =>
  fixture(name).exchanges.filter((x: { path: string }) => x.path.endsWith("/messages")).map((x: { query: Record<string, string>; body: MessagesPage }) => ({ query: x.query, ...x.body }));
const page = (name: string, compacted = false) => pages(name).find((p) => Boolean(p.query.include_compacted) === compacted)!.messages;
/** A turn as uids: [anchor, steers…, replies…]. */
const uids = (t: ChainTurn) => [t.anchor_uid, ...t.steers.map((m) => m.message_uid), ...t.replies.map((m) => m.message_uid)];
const ALL = { order: "recent", archived: "include", limit: 100 } as const;
const PAGE = { order: "oldest", limit: 500 } as const;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function fake(opts: Parameters<typeof startFakeHermes>[0]): Promise<FakeHermes> {
  const f = await startFakeHermes(opts);
  cleanups.push(() => f.stop());
  return f;
}

describe("history reader", () => {
  it("reads the list and a transcript over a fresh native-http ticket per request, bound to the profile", async () => {
    const f = await fake({ rest: ["compaction-rotating"] });
    const rec = fixture("compaction-rotating");
    const list = await listSessions(f.folder, "bob", ALL);
    expect(list).toEqual(rec.exchanges[0].body);
    const page = await readMessages(f.folder, "bob", rec.notes.root, PAGE);
    expect(page).toEqual(rec.exchanges[1].body);
    const bob = path.join(f.folder, "profiles/bob");
    expect(f.tickets).toEqual([
      { purpose: "native-http", profile_id: bob, scope: "profile" },
      { purpose: "native-http", profile_id: bob, scope: "profile" },
    ]);
    expect(f.requests).toEqual([]); // no canonical call
  });

  it("fails clearly: unrecorded reads, unserved profiles", async () => {
    const f = await fake({ rest: ["create"], unserved: ["solo"] });
    await expect(readMessages(f.folder, "alex", "nope", PAGE)).rejects.toEqual(new HistoryError(404, "not recorded"));
    await expect(listSessions(f.folder, "solo")).rejects.toMatchObject({ reason: "profile_not_served" });
  });

  it("waits for a gateway that is restarting, then reads", async () => {
    const folder = path.join(tempDir("hist-"), "hermes");
    cleanups.push(() => removeDir(path.dirname(folder)));
    mkdirSync(folder);
    const read = listSessions(folder, "default", ALL, { waitMs: 10_000 });
    await new Promise((r) => setTimeout(r, 300));
    await fake({ folder, rest: ["default-profile"] });
    expect(await read).toMatchObject({ sessions: [], total: 0 });
  });

  it("gives up after waitMs when no gateway comes", async () => {
    const folder = tempDir("hist-none-");
    cleanups.push(() => removeDir(folder));
    await expect(listSessions(folder, "default", {}, { waitMs: 1500 })).rejects.toMatchObject({ reason: "no_gateway" });
  });
});

describe("readChain", () => {
  it("reads the whole chain oldest first with compacted rows, and returns the tip", async () => {
    const f = await fake({ rest: ["compaction-in-place"] });
    const rec = fixture("compaction-in-place");
    const chain = await readChain(f.folder, "alex", rec.notes.session);
    expect(chain).toEqual({ session_id: rec.notes.session, messages: page("compaction-in-place", true) });
  });

  it("pages by offset until a short page", async () => {
    const f = await fake({ rest: ["create"] });
    const row = page("create")[0]!;
    const rows = Array.from({ length: 503 }, (_, i): RestMessage => ({ ...row, message_uid: `u${i}` }));
    const real = globalThis.fetch;
    const queries: Record<string, string>[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/messages")) return real(input, init);
      const q = Object.fromEntries(url.searchParams);
      queries.push(q);
      const offset = Number(q.offset ?? 0);
      const messages = rows.slice(offset, offset + Number(q.limit));
      return new Response(JSON.stringify({ session_id: "tip", messages, pagination: { limit: 500, offset, order: "oldest", returned: messages.length } }));
    });
    cleanups.push(() => spy.mockRestore());
    const chain = await readChain(f.folder, "alex", "root");
    expect(chain.session_id).toBe("tip");
    expect(chain.messages.map((m) => m.message_uid)).toEqual(rows.map((m) => m.message_uid));
    expect(queries).toEqual([
      { profile: "alex", order: "oldest", limit: "500", include_compacted: "true" },
      { profile: "alex", order: "oldest", limit: "500", include_compacted: "true", offset: "500" },
    ]);
  });
});

describe("groupTurns", () => {
  it("every recording: unique anchors, no steer or hidden-reply anchor, every shown row in exactly one turn", () => {
    for (const name of RECORDINGS) {
      for (const p of pages(name)) {
        const turns = groupTurns(p.messages);
        const anchors = turns.map((t) => t.anchor_uid);
        expect(new Set(anchors).size, name).toBe(anchors.length);
        const byUid = new Map(p.messages.map((m) => [m.message_uid, m] as const));
        for (const a of anchors) expect(byUid.get(a)!.display_kind, name).not.toBe("steer");
        const placed = turns.flatMap((t) => [...(t.user ? [t.user] : []), ...t.steers, ...t.replies].map((m) => m.message_uid));
        const shown = [...byUid.values()].filter((m) => !(m.display_kind === "hidden" && m.role !== "user")).map((m) => m.message_uid);
        expect(placed.sort(), name).toEqual(shown.sort());
        for (const t of turns) expect(t.replies.every((m) => m.role !== "user" && m.display_kind !== "hidden"), name).toBe(true);
      }
    }
  });

  it("compaction in place: the same turns before and after, plus the new one", () => {
    const before = groupTurns(page("compaction-in-place-before", true)).map(uids);
    const after = groupTurns(page("compaction-in-place", true));
    expect(after.slice(0, 4).map(uids)).toEqual(before);
    expect(after).toHaveLength(5);
    // The compaction carrier keeps turn 3's reply uid; Hermes' view shows its display_content.
    expect(after[2]!.replies[0]).toMatchObject({ display_content: expect.stringMatching(/^echo\(6\)/) });
  });

  it("compaction rotating: the same turns read by root and by tip, plus the new one", () => {
    const before = groupTurns(page("compaction-rotating-before")).map(uids);
    const [byRoot, byTip] = pages("compaction-rotating");
    for (const p of [byRoot!, byTip!]) {
      const turns = groupTurns(p.messages);
      expect(turns.slice(0, 8).map(uids)).toEqual(before);
      expect(turns).toHaveLength(9);
      expect(turns[8]!.user!.content).toBe("after rotation");
    }
  });

  it("/retry: exactly one more turn, the retried message and its new reply, with no submission_id", () => {
    const turns = groupTurns(page("retry"));
    expect(turns.map((t) => [t.user!.content, t.replies.map((m) => m.content), t.submission_id])).toEqual([
      ["first ask", ["echo(2): first ask"], "bb:thr_rec_retry:1"],
      ["first ask", ["echo(4): first ask"], null],
    ]);
  });

  it("a steer joins the running turn, with its tool rows; it is never an anchor", () => {
    const turns = groupTurns(page("steer"));
    expect(turns.map((t) => [t.user!.content, t.steers.map((m) => m.display_content), t.replies.map((m) => m.role)])).toEqual([
      ["start", [], ["assistant"]],
      ["please use a tool", ["steer words"], ["assistant", "tool", "assistant"]],
      ["queued behind", [], ["assistant"]],
    ]);
  });

  it("a hidden-prompt turn anchors on its first reply and keeps the hidden row and its submission_id", () => {
    const rows = page("hidden-prompt");
    const [hidden, visible] = groupTurns(rows);
    expect(hidden).toMatchObject({ anchor_uid: rows[1]!.message_uid, user: { display_kind: "hidden" }, submission_id: "bb:thr_rec_hidden:1" });
    expect(visible!.anchor_uid).toBe(rows[2]!.message_uid);
    // Not yet answered: no anchor yet, so no turn.
    expect(groupTurns(rows.slice(0, 1))).toEqual([]);
  });

  it("legacy and Conduit-held rows group normally", () => {
    for (const name of ["legacy", "conduit-held"]) {
      const rows = page(name);
      expect(groupTurns(rows).map(uids), name).toEqual([[rows[0]!.message_uid, rows[1]!.message_uid]]);
      expect(groupTurns(rows)[0]!.submission_id).toBeNull();
    }
  });

  it("reply rows before any user row form a turn anchored on the first of them", () => {
    const rows = page("create");
    const turns = groupTurns(rows.slice(1));
    expect(turns.map((t) => [t.anchor_uid, t.user?.message_uid ?? null])).toEqual([
      [rows[1]!.message_uid, null],
      [rows[2]!.message_uid, rows[2]!.message_uid],
    ]);
  });
});

describe("summarizeTurn", () => {
  it("maps to the host contract's HistoryTurn, less complete", () => {
    const rows = page("steer");
    const [, steered] = groupTurns(rows);
    expect(summarizeTurn(steered!)).toEqual({
      anchor_uid: rows[2]!.message_uid,
      user_text: "please use a tool",
      user_hidden: false,
      submission_id: "bb:thr_rec_steer:2",
      reply_uids: [rows[3]!.message_uid, rows[4]!.message_uid, rows[6]!.message_uid],
      ts: Math.round(rows[2]!.timestamp * 1000),
    });
    const [hidden] = groupTurns(page("hidden-prompt"));
    expect(summarizeTurn(hidden!)).toMatchObject({ user_text: null, user_hidden: true, submission_id: "bb:thr_rec_hidden:1" });
  });
});

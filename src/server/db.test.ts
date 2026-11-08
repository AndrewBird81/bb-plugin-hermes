import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  bindingByLineage,
  bindingByThread,
  bindingCounts,
  claimTurn,
  getKv,
  insertBinding,
  openMappingDb,
  queuedTurns,
  releaseTurn,
  setKv,
  type Binding,
} from "./db.js";

const binding = (over: Partial<Binding>): Binding => ({
  thread_id: "thr_a",
  profile_home: "/h/profiles/neo",
  lineage_root: null,
  session_id: null,
  expected_id: null,
  kind: "chat",
  source: null,
  tag: null,
  state: "pending",
  legacy: false,
  archived_by_switch: false,
  title_set: null,
  ...over,
});

const tables = (db: ReturnType<typeof openMappingDb>) =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map(
    (r) => r.name,
  );

describe("mapping db", () => {
  it("creates the 02 tables; a re-run and a reload are no-ops", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "hermes" });
    const db = openMappingDb(bb);
    const before = tables(db);
    expect(before).toEqual(expect.arrayContaining(["bindings", "bindings_one_bot", "bots", "kv", "tombstones", "turns"]));
    insertBinding(db, binding({}));

    openMappingDb(bb);
    expect(tables(db)).toEqual(before);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM _bb_migrations`).get()).toEqual({ n: 1 });

    const { bb: next } = await harness.lifecycle.reload(() => {});
    const reopened = openMappingDb(next);
    expect(tables(reopened)).toEqual(before);
    expect(bindingByThread(reopened, "thr_a")?.thread_id).toBe("thr_a");
  });

  it("keeps one thread per Hermes chat and one bot thread per profile", () => {
    const { bb } = createFakePluginHost();
    const db = openMappingDb(bb);
    insertBinding(db, binding({ thread_id: "thr_1", lineage_root: "root_1", state: "live" }));
    expect(() => insertBinding(db, binding({ thread_id: "thr_2", lineage_root: "root_1" }))).toThrow(/UNIQUE/);
    // Same root in another profile, and several pending rows, are fine.
    insertBinding(db, binding({ thread_id: "thr_3", profile_home: "/h", lineage_root: "root_1" }));
    insertBinding(db, binding({ thread_id: "thr_4" }));
    insertBinding(db, binding({ thread_id: "thr_5" }));

    insertBinding(db, binding({ thread_id: "thr_bot", kind: "bot" }));
    expect(() => insertBinding(db, binding({ thread_id: "thr_bot2", kind: "bot" }))).toThrow(/UNIQUE/);
    insertBinding(db, binding({ thread_id: "thr_bot3", profile_home: "/h", kind: "bot" }));
    expect(() => insertBinding(db, binding({ thread_id: "thr_x", kind: "other" as Binding["kind"] }))).toThrow(/CHECK/);
  });

  it("looks bindings up by thread and by lineage", () => {
    const { bb } = createFakePluginHost();
    const db = openMappingDb(bb);
    const row = binding({ thread_id: "thr_1", lineage_root: "root_1", session_id: "tip_1", kind: "mirror", source: "local", tag: "CLI", state: "live", legacy: true });
    insertBinding(db, row);
    expect(bindingByThread(db, "thr_1")).toEqual(row);
    expect(bindingByLineage(db, row.profile_home, "root_1")).toEqual(row);
    expect(bindingByLineage(db, "/other", "root_1")).toBeNull();
    expect(bindingByThread(db, "thr_missing")).toBeNull();
  });

  it("counts a pending side chat colliding with a bound root as a duplicate", () => {
    const { bb } = createFakePluginHost();
    const db = openMappingDb(bb);
    insertBinding(db, binding({ thread_id: "thr_1", lineage_root: "local-abc" }));
    insertBinding(db, binding({ thread_id: "thr_2" }));
    expect(bindingCounts(db)).toEqual({ total: 2, duplicates: 0 });
    insertBinding(db, binding({ thread_id: "thr_3", expected_id: "local-abc" }));
    expect(bindingCounts(db)).toEqual({ total: 3, duplicates: 1 });
  });

  it("claims a turn once; a release frees it; queued rows list for boot recovery", () => {
    const { bb } = createFakePluginHost();
    const db = openMappingDb(bb);
    const turn = { thread_id: "thr_1", anchor_uid: "uid_1", kind: "mirror" as const, at: 1 };
    // 3 re-lists during one outside turn → 1 wake (03 §Unit).
    expect([claimTurn(db, turn), claimTurn(db, turn), claimTurn(db, turn)]).toEqual([true, false, false]);
    expect(queuedTurns(db)).toEqual([turn]);

    releaseTurn(db, "thr_1", "uid_1");
    expect(queuedTurns(db)).toEqual([]);
    expect(claimTurn(db, turn)).toBe(true);

    // A done turn is never released.
    db.prepare(`UPDATE turns SET state = 'done'`).run();
    releaseTurn(db, "thr_1", "uid_1");
    expect(claimTurn(db, turn)).toBe(false);
    expect(queuedTurns(db)).toEqual([]);
  });

  it("stores kv values as JSON", () => {
    const { bb } = createFakePluginHost();
    const db = openMappingDb(bb);
    expect(getKv(db, "worker_boot_id")).toBeNull();
    setKv(db, "worker_boot_id", "boot_1");
    setKv(db, "worker_boot_id", "boot_2");
    expect(getKv(db, "worker_boot_id")).toBe("boot_2");
  });
});

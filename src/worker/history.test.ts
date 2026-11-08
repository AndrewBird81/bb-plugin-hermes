// T1.7 on the strict fake: worker.json, model prewarm (A16), Bot Chat lookup, REST list rows, change watch,
// the REST half of the version check, and no Hermes I/O for off bots.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import { Refusal, startFakeHermes, type FakeOptions } from "../../test/fake-hermes/index.js";
import { removeDir, tempDir } from "../../test/fake-hermes/wire.js";
import type { SessionsPage } from "../hermes/history.js";
import { bridgeDataDir, modelsFile, WORKER_FILE } from "../shared/bridge-files.js";
import { createHostEntry, type HostEntryOptions } from "./entry.js";
import { listAllSessions, toSessionRow } from "./sessions.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setup(opts: FakeOptions = {}, entry: HostEntryOptions = {}) {
  const fake = await startFakeHermes({ profiles: ["alex", "bob"], ...opts });
  cleanups.push(() => fake.stop());
  writeFileSync(path.join(fake.folder, "profiles", "alex", "config.yaml"), "terminal:\n  cwd: ~/notes\n");
  const base = tempDir("data-");
  cleanups.push(() => removeDir(base));
  const dataDir = path.join(base, "plugins", "hermes", "host-data");
  const h = experimental_createHostEntryHarness(
    createHostEntry({ connection: { backoffMs: [10] }, changes: { intervalMs: 40, debounceMs: 20 }, modelsWaitMs: 300, ...entry }),
    { experimental_paths: { dataDir, tempDir: dataDir } },
  );
  cleanups.push(() => h.experimental_dispose());
  const [, alex, bob] = fake.profiles.map((p) => p.home) as [string, string, string];
  return { fake, h, dataDir, bridgeDir: bridgeDataDir(dataDir), root: fake.folder, alex, bob };
}

/** Nothing in this run touched `home`'s profile: no routed call, no REST ticket for it (02 §Invariants). */
function untouched(fake: Awaited<ReturnType<typeof setup>>["fake"], name: string, home: string) {
  expect(fake.requests.filter((r) => r.profile === name || r.params.profile === name)).toEqual([]);
  expect(fake.tickets.filter((t) => t.profile_id === home)).toEqual([]);
}

describe("worker.json", () => {
  it("lists the enabled bots for bridges and is rewritten only when it changes", async () => {
    const { h, bridgeDir, root, alex, bob, fake } = await setup();
    const out = await h.experimental_call("ensureWatch", { root, enabled_bots: [alex] });
    const file = path.join(bridgeDir, WORKER_FILE);
    const first = JSON.parse(readFileSync(file, "utf8"));
    expect(first).toEqual({ root, worker_boot_id: out.worker_boot_id, written_at: expect.any(Number), enabled: [{ profile: "alex", profile_home: alex, bot_label: "Alex", cwd: "~/notes" }] });

    await sleep(5);
    await h.experimental_call("ensureWatch", { root, enabled_bots: [alex] });
    expect(JSON.parse(readFileSync(file, "utf8")).written_at).toBe(first.written_at);

    await h.experimental_call("ensureWatch", { root, enabled_bots: [alex, root] });
    expect(JSON.parse(readFileSync(file, "utf8")).enabled.map((b: { bot_label: string }) => b.bot_label)).toEqual(["Alex", "Hermes"]);
    untouched(fake, "bob", bob);
  });

  it("is written with no bot on, so bridges know this machine runs Hermes", async () => {
    const { h, bridgeDir, root } = await setup();
    await h.experimental_call("ensureWatch", { root, enabled_bots: [] });
    expect(JSON.parse(readFileSync(path.join(bridgeDir, WORKER_FILE), "utf8")).enabled).toEqual([]);
  });
});

describe("models (A16)", () => {
  it("prewarms enabled bots in the background; a prewarmed call answers from memory", async () => {
    const { fake, h, bridgeDir, root, alex, bob } = await setup();
    let calls = 0;
    fake.handle("model.options", async () => {
      calls++;
      await sleep(200); // a cold catalog fetch (r11 §1: ~15 s live)
      return { providers: [{ slug: "stub", name: "Stub", is_current: true, models: ["stub", "big"], total_models: 2, capabilities: { big: { reasoning: true } } }], model: "stub", provider: "stub" };
    });
    await h.experimental_call("ensureWatch", { root, enabled_bots: [alex] });
    await until(() => existsSync(modelsFile(bridgeDir, alex)));
    expect(fake.requests.filter((r) => r.method === "model.options").map((r) => r.params)).toEqual([{ profile: "alex" }]);

    const t0 = performance.now();
    const catalog = await h.experimental_call("models", { root, profile_home: alex });
    const ms = performance.now() - t0;
    expect(catalog).toMatchObject({ profile_home: alex, current: "stub/stub", models: [{ id: "stub/stub", reasoning: false }, { id: "stub/big", reasoning: true }] });
    expect(ms).toBeLessThan(100);
    expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(modelsFile(bridgeDir, alex), "utf8"))).toEqual(catalog);
    untouched(fake, "bob", bob);
  });

  it("a cold call waits for the fetch; a hung one falls back to the last-known file", async () => {
    const { fake, h, bridgeDir, root, alex } = await setup();
    await h.experimental_call("ensureWatch", { root, enabled_bots: [] });
    expect((await h.experimental_call("models", { root, profile_home: alex })).current).toBe("stub/stub");

    const { fake: f2, h: h2, bridgeDir: d2, root: r2, alex: a2 } = await setup();
    f2.handle("model.options", () => new Promise(() => {}));
    await h2.experimental_call("ensureWatch", { root: r2, enabled_bots: [] });
    await expect(h2.experimental_call("models", { root: r2, profile_home: a2 })).rejects.toThrow("models_timeout");
    const last = { profile_home: a2, current: "x/y", models: [], fetched_at: 1 };
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.dirname(modelsFile(d2, a2)), { recursive: true });
    writeFileSync(modelsFile(d2, a2), JSON.stringify(last));
    expect(await h2.experimental_call("models", { root: r2, profile_home: a2 })).toEqual(last);
    expect([fake.violations, f2.violations, bridgeDir]).toEqual([[], [], bridgeDir]);
  });
});

describe("findBotChat", () => {
  const row = (session_id: string, id: string) => ({ session_id, id, resolved_id: session_id, title: "Bot Chat", root_title: "Bot Chat", source: "local", started_at: 1, message_count: 2, running: false });

  it("found / none / held, read-only, routed to the bot", async () => {
    const { fake, h, root, alex } = await setup();
    let answer: () => unknown = () => ({ sessions: [row("local-abc", "local-abc")], scope: "stored" });
    fake.handle("session.list", () => answer());
    expect(await h.experimental_call("findBotChat", { root, profile_home: alex })).toEqual({ state: "found", lineage_root: "local-abc", session_id: "local-abc", legacy: false });
    answer = () => ({ sessions: [row("local-abc", "tip-2")], scope: "stored" });
    expect(await h.experimental_call("findBotChat", { root, profile_home: alex })).toMatchObject({ lineage_root: "local-abc", session_id: "tip-2" });
    answer = () => ({ sessions: [], scope: "stored" });
    expect(await h.experimental_call("findBotChat", { root, profile_home: alex })).toEqual({ state: "none" });
    answer = () => {
      throw new Refusal("runtime_coordination_required");
    };
    expect(await h.experimental_call("findBotChat", { root, profile_home: alex })).toEqual({ state: "held" });
    expect(fake.requests.filter((r) => r.method === "session.list").map((r) => [r.profile, r.params])).toEqual(
      Array(4).fill(["alex", { profile: "alex", title: "Bot Chat", include_hidden: true }]),
    );
    expect(fake.requests.map((r) => r.method).filter((m) => m !== "session.list" && m !== "profiles.list")).toEqual([]);
    expect(fake.violations).toEqual([]);
  });

  it("no gateway → a bounded refusal", async () => {
    const root = tempDir("empty-");
    cleanups.push(() => removeDir(root));
    const h = experimental_createHostEntryHarness(createHostEntry({ connection: { backoffMs: [10] }, settleMs: 50 }));
    cleanups.push(() => h.experimental_dispose());
    await expect(h.experimental_call("findBotChat", { root, profile_home: path.join(root, "profiles", "alex") })).rejects.toThrow("not_connected:no_gateway");
  });
});

describe("listSessions", () => {
  it("maps REST rows (recorded): lineage root, legacy, ms times; since filters", async () => {
    const { h, root, alex, fake } = await setup({ rest: ["legacy"] });
    const { sessions } = await h.experimental_call("listSessions", { root, profile_home: alex });
    expect(sessions).toHaveLength(6);
    const legacy = sessions.find((s) => s.legacy)!;
    expect(legacy).toEqual({
      session_id: "legacy_rec_1",
      lineage_root: "legacy_rec_1",
      title: "Stub chat #6",
      source: "desktop",
      created_source: "desktop",
      hidden: false,
      archived: false,
      cwd: null,
      message_count: 2,
      last_activity_at: 1794165216476,
      legacy: true,
    });
    expect(sessions.filter((s) => !s.legacy).every((s) => s.lineage_root === s.session_id && s.source === "local")).toBe(true);
    const since = (await h.experimental_call("listSessions", { root, profile_home: alex, since: 1794165213720 })).sessions;
    expect(since.map((s) => s.title)).toEqual(["Stub chat #6", "Stub chat #5", "Stub chat #4"]);
    expect(fake.tickets.filter((t) => t.purpose === "native-http").every((t) => t.profile_id === alex)).toBe(true);
  });

  it("pages by 100 until a short or last page, stops at an all-old page, counts a moved row once", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ id: `s${i}`, chat_id: `s${i}`, title: null, source: "local", created_source: "cli", hidden: 0, archived: false, cwd: null, message_count: 1, last_activity_at: 1000 - i }));
    const queries: object[] = [];
    const page = async (q: { limit: number; offset?: number }): Promise<SessionsPage> => {
      queries.push(q);
      const off = q.offset ?? 0;
      return { sessions: [...(off ? [rows[off - 1]!] : []), ...rows.slice(off, off + q.limit)].slice(0, q.limit), total: rows.length };
    };
    expect((await listAllSessions(page)).length).toBe(250);
    expect(queries).toEqual([
      { order: "recent", archived: "include", limit: 100 },
      { order: "recent", archived: "include", limit: 100, offset: 100 },
      { order: "recent", archived: "include", limit: 100, offset: 200 },
    ]);
    queries.length = 0;
    const recent = await listAllSessions(page, 960_000);
    expect(recent.map((r) => r.session_id)).toEqual(rows.slice(0, 41).map((r) => r.id));
    expect(queries).toHaveLength(2);
  });

  it("toSessionRow never carries prompts or configs", () => {
    const raw = { id: "a", chat_id: null, title: "t", source: "desktop", created_source: null, hidden: 1, archived: true, cwd: null, message_count: 3, last_activity_at: null, system_prompt: "x", model_config: "{}", origin_json: "{}" };
    expect(toSessionRow(raw as never)).toEqual({ session_id: "a", lineage_root: "a", title: "t", source: "desktop", created_source: null, hidden: true, archived: true, cwd: null, message_count: 3, last_activity_at: null, legacy: true });
  });
});

describe("change watch", () => {
  it("WAL stat of enabled bots and sessions.changed → one debounced changed signal; off bots never", async () => {
    const { fake, h, root, alex, bob } = await setup();
    await h.experimental_call("ensureWatch", { root, enabled_bots: [alex] });
    const changed = () => h.experimental_getSignals().filter((s) => s.signal === "changed").map((s) => s.payload);

    writeFileSync(path.join(alex, "state.db-wal"), "a");
    writeFileSync(path.join(alex, "state.db"), "b");
    await until(() => changed().length === 1);
    expect(changed()).toEqual([{ profile_homes: [alex] }]);

    writeFileSync(path.join(bob, "state.db-wal"), "x");
    await sleep(150);
    expect(changed()).toHaveLength(1);

    fake.emit({ type: "sessions.changed", payload: {} });
    await until(() => changed().length === 2);
    expect(changed()[1]).toEqual({ profile_homes: [alex] });

    // Switched off: no more stats or hints for it.
    await h.experimental_call("ensureWatch", { root, enabled_bots: [] });
    writeFileSync(path.join(alex, "state.db-wal"), "more");
    fake.emit({ type: "sessions.changed", payload: {} });
    await sleep(150);
    expect(changed()).toHaveLength(2);
    untouched(fake, "bob", bob);
  });
});

describe("version check, REST half (flow 11)", () => {
  it("key-checks one list page and one messages page of an enabled bot, once per instance", async () => {
    const { fake, h, root, alex } = await setup({ rest: ["legacy"] });
    expect(await h.experimental_call("ensureWatch", { root, enabled_bots: [] })).toMatchObject({ supported: true });
    expect(fake.tickets.filter((t) => t.purpose === "native-http")).toEqual([]);
    expect(await h.experimental_call("ensureWatch", { root, enabled_bots: [alex] })).toMatchObject({ supported: true, detail: null });
    expect((await h.experimental_call("diagnostics", null)).version).toMatchObject({ supported: true, missing: [] });
    const reads = fake.tickets.filter((t) => t.purpose === "native-http").length;
    expect(reads).toBe(2);
    await h.experimental_call("ensureWatch", { root, enabled_bots: [alex] });
    expect(fake.tickets.filter((t) => t.purpose === "native-http").length).toBe(reads);
  });
});

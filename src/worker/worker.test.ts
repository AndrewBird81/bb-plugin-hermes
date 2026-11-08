import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { CODE_VERSION, startFakeHermes, type FakeOptions } from "../../test/fake-hermes/index.js";
import { removeDir, tempDir } from "../../test/fake-hermes/wire.js";
import { botHandle, terminalCwd } from "./describe.js";
import { createHostEntry } from "./entry.js";
import { boundedCode, expandRoot } from "./watch.js";
import { CONTRACT_FILE, hermesVersion } from "./version.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await tick(5);
  }
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** The strict fake with config files for `describe`. `solo` is a profile folder the gateway doesn't serve. */
async function hermes(opts: FakeOptions = {}) {
  const fake = await startFakeHermes({ profiles: ["alex"], unserved: ["solo"], ...opts });
  cleanups.push(() => fake.stop());
  writeFileSync(path.join(fake.folder, "config.yaml"), "model:\n  default: x\nterminal:\n  backend: local\n  cwd: ~/src # projects\n");
  writeFileSync(path.join(fake.folder, "profiles", "alex", "config.yaml"), "terminal:\n  cwd: .\n");
  writeFileSync(path.join(fake.folder, "profiles", "solo", "config.yaml"), "terminal:\n  cwd: /work\n");
  // Hermes lists every profile folder, served or not (`hermes_cli/profiles.py:983-1001`); the fake lists served ones only.
  const sockets: WebSocket[] = [];
  fake.handle("profiles.list", (_p, { socket }) => {
    sockets.push(socket);
    const rows = [...fake.profiles, { name: "solo", home: path.join(fake.folder, "profiles", "solo") }];
    return { profiles: rows.map((p) => ({ name: p.name, path: p.home, is_default: p.name === "default" })), bot_mode_protocol: true, install_id: "" };
  });
  return { fake, sockets };
}

function harness(dataDir = "/private/tmp/bb-hermes-test/none") {
  const h = experimental_createHostEntryHarness(createHostEntry({ connection: { backoffMs: [10] } }), {
    experimental_paths: { dataDir, tempDir: dataDir },
  });
  cleanups.push(() => h.experimental_dispose());
  return h;
}

const watch = (root: string) => ({ root, enabled_bots: [] });

describe("ensureWatch", () => {
  it("connects with one host-scoped connection, checks the version and signals", async () => {
    const { fake } = await hermes();
    const h = harness();
    const out = await h.experimental_call("ensureWatch", watch(fake.folder));
    expect(out).toMatchObject({ connected: true, instance_id: fake.instanceId, version: CODE_VERSION, supported: true, detail: null });
    expect(out.worker_boot_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.tickets).toEqual([{ purpose: "interactive", profile_id: fake.folder, scope: "host" }]);

    // Idempotent: the same connection, no new ticket.
    expect(await h.experimental_call("ensureWatch", watch(fake.folder))).toEqual(out);
    expect(fake.tickets).toHaveLength(1);
    expect(h.experimental_getSignals()).toEqual([{ signal: "watch", payload: { state: "connected", worker_boot_id: out.worker_boot_id, instance_id: fake.instanceId } }]);
    expect(h.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    expect(fake.violations).toEqual([]);
  });

  it("reports no_gateway on an empty folder and starts nothing", async () => {
    const root = tempDir("empty-");
    cleanups.push(() => removeDir(root));
    const h = harness();
    const out = await h.experimental_call("ensureWatch", watch(root));
    expect(out).toMatchObject({ connected: false, instance_id: null, version: null, supported: null, detail: "no_gateway" });
    expect(readdirSync(root)).toEqual([]);
    expect(h.experimental_getSignals()).toEqual([]);
  });

  it("a changed contract → supported:false with the missing methods and params", async () => {
    const { fake } = await hermes({ contract: "changed", codeVersion: "0.23.0" });
    const h = harness();
    expect(await h.experimental_call("ensureWatch", watch(fake.folder))).toMatchObject({ connected: true, version: "0.23.0", supported: false, detail: "missing:2" });
    expect((await h.experimental_call("diagnostics", null)).version).toMatchObject({ supported: false, missing: ["param:prompt.submit.turn_author", "method:session.steer"] });
  });

  it("no contract file → supported:null (version unknown)", async () => {
    const { fake } = await hermes();
    rmSync(path.join(fake.folder, CONTRACT_FILE));
    const out = await harness().experimental_call("ensureWatch", watch(fake.folder));
    expect(out).toMatchObject({ connected: true, version: CODE_VERSION, supported: null, detail: null });
  });

  it("gateway restart → reconnect, same boot id, new instance_id, re-checked version, signals both ways", async () => {
    const { fake } = await hermes();
    const h = harness();
    const first = await h.experimental_call("ensureWatch", watch(fake.folder));
    const before = fake.instanceId;
    await fake.restart({ contract: "changed" });
    await until(() => h.experimental_getSignals().length === 3);
    const again = await h.experimental_call("ensureWatch", watch(fake.folder));
    expect(again).toMatchObject({ connected: true, instance_id: fake.instanceId, worker_boot_id: first.worker_boot_id, supported: false });
    expect(fake.instanceId).not.toBe(before);
    expect(h.experimental_getSignals().map((s) => (s.signal === "watch" ? [s.payload.state, s.payload.instance_id] : null))).toEqual([
      ["connected", before],
      ["disconnected", null],
      ["connected", fake.instanceId],
    ]);
  });

  it("a changed root drops the old connection", async () => {
    const a = await hermes();
    const b = await hermes();
    const h = harness();
    await h.experimental_call("describe", { root: a.fake.folder });
    const out = await h.experimental_call("ensureWatch", watch(b.fake.folder));
    expect(out).toMatchObject({ connected: true, instance_id: b.fake.instanceId });
    await until(() => a.sockets[0]!.readyState === 3);
  });

  it("dispose closes the socket", async () => {
    const { fake, sockets } = await hermes();
    const h = harness();
    await h.experimental_call("describe", { root: fake.folder });
    expect(sockets[0]!.readyState).toBe(1);
    await h.experimental_dispose();
    await until(() => sockets[0]!.readyState === 3);
  });
});

describe("describe", () => {
  it("lists served and unserved profiles with handle and terminal cwd", async () => {
    const { fake } = await hermes();
    const out = await harness().experimental_call("describe", { root: fake.folder });
    expect(out.uid).toBe(process.getuid!());
    expect(out.profiles).toEqual([
      { name: "default", home: fake.folder, handle: "hermes", terminal_cwd: "~/src", served: true },
      { name: "alex", home: path.join(fake.folder, "profiles", "alex"), handle: "alex", terminal_cwd: null, served: true },
      { name: "solo", home: path.join(fake.folder, "profiles", "solo"), handle: "solo", terminal_cwd: "/work", served: false },
    ]);
    expect(fake.requests.map((r) => [r.method, r.params, r.refused])).toEqual([["profiles.list", { include_sessions: false }, undefined]]);
  });

  it("fails with a bounded code when there is no gateway", async () => {
    const root = tempDir("empty-");
    cleanups.push(() => removeDir(root));
    await expect(harness().experimental_call("describe", { root })).rejects.toThrow("not_connected:no_gateway");
  });
});

describe("diagnostics", () => {
  it("reports the worker, the watch with the root as configured, and live and dead bridges", async () => {
    const base = tempDir("data-");
    cleanups.push(() => removeDir(base));
    const dataDir = path.join(base, "plugins", "hermes", "host-data");
    const bridgeDir = path.join(base, "plugins", "hermes", "bridge-data", "bridges");
    mkdirSync(path.join(dataDir, "bridges"), { recursive: true });
    mkdirSync(bridgeDir, { recursive: true });
    let dead = 4_000_000;
    while (alive(dead)) dead--;
    writeFileSync(path.join(dataDir, "bridges", `${process.pid}.json`), JSON.stringify({ build: "aaa", threadId: null, startedAt: 1 }));
    writeFileSync(path.join(bridgeDir, `${dead}.json`), JSON.stringify({ build: "bbb", threadId: "thr_x", startedAt: 2 }));
    writeFileSync(path.join(bridgeDir, "9.json"), "{half");

    const h = harness(dataDir);
    const before = await h.experimental_call("diagnostics", null);
    expect(before.watch).toEqual({ root: null, state: "idle", instance_id: null, since: null, last_error: null });

    await h.experimental_call("ensureWatch", { root: "~/.bb-hermes-test-absent", enabled_bots: [] });
    const out = await h.experimental_call("diagnostics", null);
    expect(out).toMatchObject({ pid: process.pid, build: "dev", worker_boot_id: before.worker_boot_id, version: { supported: null } });
    expect(out.watch).toMatchObject({ root: "~/.bb-hermes-test-absent", last_error: "no_gateway", state: expect.stringMatching(/^(connecting|disconnected)$/) });
    expect(out.bridges).toEqual([
      { pid: process.pid, build: "aaa", thread_id: null, started_at: 1, alive: true },
      { pid: dead, build: "bbb", thread_id: "thr_x", started_at: 2, alive: false },
    ]);
    expect(JSON.stringify(out)).not.toContain(homedir());
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

describe("helpers", () => {
  it("hermesVersion: code_version, else the short code_sha", () => {
    const ep = { codeVersion: null, codeSha: "c314285f077e91937c" } as Parameters<typeof hermesVersion>[0];
    expect(hermesVersion(ep)).toBe("c314285f07");
    expect(hermesVersion({ ...ep, codeVersion: "0.22.6" })).toBe("0.22.6");
    expect(hermesVersion({ ...ep, codeSha: null })).toBeNull();
  });

  it("terminalCwd reads terminal.cwd only", () => {
    expect(terminalCwd("terminal:\n  cwd: /work\n")).toBe("/work");
    expect(terminalCwd("terminal:\n  cwd: \"~/a b\" # c\n")).toBe("~/a b");
    expect(terminalCwd("terminal:\n  cwd: .\n")).toBeNull();
    expect(terminalCwd("other:\n  cwd: /x\nterminal:\n  backend: local\n")).toBeNull();
    expect(terminalCwd("")).toBeNull();
  });

  it("botHandle: default is @hermes unless a profile holds that name", () => {
    expect(botHandle("default", ["default", "alex"])).toBe("hermes");
    expect(botHandle("default", ["default", "hermes"])).toBe("default");
    expect(botHandle("alex", ["default", "alex"])).toBe("alex");
  });

  it("expandRoot and boundedCode", () => {
    expect(expandRoot("~")).toBe(homedir());
    expect(expandRoot("~/.hermes")).toBe(path.join(homedir(), ".hermes"));
    expect(expandRoot("/abs")).toBe("/abs");
    expect(boundedCode("not_ready:draining")).toBe("not_ready:draining");
    expect(boundedCode("PermissionError: stale runtime instance")).toBe("error");
    expect(boundedCode(null)).toBeNull();
  });

  it("src/worker spawns no process and never reads .env", () => {
    const dir = import.meta.dirname;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      expect(readFileSync(path.join(dir, f), "utf8"), f).not.toMatch(/child_process|["'][^"'\n]*\.env["']/);
    }
  });
});

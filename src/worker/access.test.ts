import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import { removeDir, tempDir } from "../../test/fake-hermes/wire.js";
import {
  bbTarget,
  hermesCli,
  MARKER_FILE,
  profileNameFromHome,
  refreshPrompts,
  renderSkill,
  SKILL_DIR,
  WRAPPER_PATH,
  wrapperScript,
  type RefreshResult,
} from "./access.js";
import { createHostEntry } from "./entry.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();
}

const script = (file: string, body: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};

/** A Hermes folder with profiles `alex` and `bob`, a stub `bb`, and a worker dataDir. */
function setup() {
  const base = tempDir("access-");
  cleanups.push(() => removeDir(base));
  const root = path.join(base, "hermes");
  for (const p of ["profiles/alex/skills/own-skill", "profiles/bob"]) mkdirSync(path.join(root, p), { recursive: true });
  writeFileSync(path.join(root, "profiles/alex/skills/own-skill/SKILL.md"), "the bot's own skill\n");
  const bb = script(path.join(base, "bb-app", "bb"), "echo bb");
  const dataDir = path.join(base, "plugins", "hermes", "host-data");
  return { base, root, bb, dataDir, alex: path.join(root, "profiles", "alex"), bob: path.join(root, "profiles", "bob") };
}

function harness(dataDir: string, refresh: (...a: Parameters<typeof refreshPrompts>) => Promise<RefreshResult>) {
  const h = experimental_createHostEntryHarness(createHostEntry({ access: { refresh } }), { experimental_paths: { dataDir, tempDir: dataDir } });
  cleanups.push(() => h.experimental_dispose());
  return h;
}

/** The daemon's per-call environment (A44), for one test. */
function withEnv(vars: Record<string, string | undefined>) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  cleanups.push(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
}

describe("bbTarget (A44)", () => {
  const exists = (...files: string[]) => (f: string) => files.includes(f);

  it("uses BB_CLI, else bb on PATH, else nothing", () => {
    expect(bbTarget({ BB_CLI: "/opt/bb/bb", PATH: "/usr/bin" }, exists("/opt/bb/bb"))?.bb).toBe("/opt/bb/bb");
    expect(bbTarget({ BB_CLI: "/gone/bb", PATH: "/usr/bin:/opt/x" }, exists("/opt/x/bb"))?.bb).toBe("/opt/x/bb");
    expect(bbTarget({ BB_CLI: "relative/bb", PATH: "rel:/usr/bin" }, exists("relative/bb", "rel/bb"))).toBeNull();
    expect(bbTarget({ PATH: "/usr/bin" }, exists())).toBeNull();
  });

  it("sets BB_SERVER_URL only when bb's default would miss the server", () => {
    const at = (BB_SERVER_URL?: string) => bbTarget({ BB_CLI: "/b/bb", BB_SERVER_URL }, exists("/b/bb"))?.serverUrl;
    expect(at(undefined)).toBeNull();
    expect(at("http://127.0.0.1:38886")).toBeNull();
    expect(at("http://localhost:38886/")).toBeNull();
    expect(at("https://bb.example.test")).toBe("https://bb.example.test");
    expect(at("http://127.0.0.1:48886")).toBe("http://127.0.0.1:48886");
    expect(at("http://127.0.0.1:38886/proxy")).toBe("http://127.0.0.1:38886/proxy");
  });

  it("sets BB_HOST_DAEMON_PORT only when it isn't the default", () => {
    const at = (BB_HOST_DAEMON_PORT?: string) => bbTarget({ BB_CLI: "/b/bb", BB_HOST_DAEMON_PORT }, exists("/b/bb"))?.daemonPort;
    expect(at(undefined)).toBeNull();
    expect(at("38887")).toBeNull();
    expect(at("48887")).toBe("48887");
    expect(at("x; rm")).toBeNull();
  });

  it("the wrapper runs a `#!/usr/bin/env node` bb with a PATH that has no node", () => {
    const { base, dataDir } = setup();
    const bb = script(path.join(base, "bb-js", "bb"), "");
    writeFileSync(bb, "#!/usr/bin/env node\nconsole.log(['bb', process.env.BB_SERVER_URL, ...process.argv.slice(2)].join(' '));\n");
    const target = bbTarget({ BB_CLI: bb, BB_SERVER_URL: "http://127.0.0.1:48886" })!;
    expect(target.nodeDir).toBe(path.dirname(process.execPath));
    const wrapper = path.join(dataDir, WRAPPER_PATH);
    mkdirSync(path.dirname(wrapper), { recursive: true });
    writeFileSync(wrapper, wrapperScript(target), { mode: 0o755 });
    const minimal = { PATH: "/usr/bin:/bin", HOME: base };
    expect(spawnSync("/bin/sh", ["-c", "command -v node"], { env: minimal }).status).not.toBe(0);
    const run = spawnSync(wrapper, ["thread", "list"], { env: minimal, encoding: "utf8" });
    expect([run.status, run.stdout.trim(), run.stderr]).toEqual([0, "bb http://127.0.0.1:48886 thread list", ""]);
  });

  it("wrapper: exports only what it needs, quotes, execs bb", () => {
    expect(wrapperScript({ bb: "/opt/bb/bb", serverUrl: null, daemonPort: null, nodeDir: "/opt/node/bin" })).toBe(
      "#!/bin/sh\n# bb for Hermes bots, written by the bb Hermes plugin (bb-plugin-hermes). Rewritten when bb moves: don't edit.\nPATH=/opt/node/bin:\"$PATH\"\nexport PATH\nexec /opt/bb/bb \"$@\"\n",
    );
    const remote = wrapperScript({ bb: "/Apps/b b/bb", serverUrl: "https://bb.example.test/a'b", daemonPort: "48887", nodeDir: "/n o/bin" });
    expect(remote).toContain(`PATH='/n o/bin':"$PATH"\nexport PATH\n`);
    expect(remote).toContain("BB_SERVER_URL='https://bb.example.test/a'\\''b'\nexport BB_SERVER_URL\n");
    expect(remote).toContain("BB_HOST_DAEMON_PORT=48887\nexport BB_HOST_DAEMON_PORT\n");
    expect(remote).toContain(`exec '/Apps/b b/bb' "$@"`);
  });
});

describe("helpers", () => {
  it("profileNameFromHome: default is the root, others live in profiles/", () => {
    const { root, alex } = setup();
    expect(profileNameFromHome(root, root)).toBe("default");
    expect(profileNameFromHome(root, alex)).toBe("alex");
    expect(profileNameFromHome(root, path.join(root, "elsewhere"))).toBeNull();
    expect(profileNameFromHome(root, path.join(alex, "profiles", "x"))).toBeNull();
  });

  it("hermesCli: the install's launcher, then its venv; never PATH", () => {
    const has = (...f: string[]) => (x: string) => f.includes(x);
    expect(hermesCli("/h", has("/h/hermes-agent/.hermes/bin/hermes", "/h/hermes-agent/venv/bin/hermes"))).toBe("/h/hermes-agent/.hermes/bin/hermes");
    expect(hermesCli("/h", has("/h/hermes-agent/venv/bin/hermes", "/usr/bin/hermes"))).toBe("/h/hermes-agent/venv/bin/hermes");
    expect(hermesCli("/h", has("/usr/bin/hermes"))).toBeNull();
  });

  it("renders the skill with the wrapper path, quoted when needed", () => {
    expect(renderSkill("/d/bin/bb-hermes")).toContain("`/d/bin/bb-hermes thread list --json`");
    expect(renderSkill("/d d/bin/bb-hermes")).toContain("`'/d d/bin/bb-hermes' thread list --json`");
    expect(renderSkill("/x")).not.toContain("{{BB}}");
  });
});

describe("refreshPrompts", () => {
  it("runs `-p <profile> sessions refresh-prompts --json` with HERMES_HOME = the folder", async () => {
    const { base, root } = setup();
    const log = path.join(base, "args.txt");
    const cli = script(path.join(base, "bin", "hermes"), `echo "$HERMES_HOME|$*" > '${log}'`);
    expect(await refreshPrompts(cli, root, "alex", { PATH: "/usr/bin:/bin", HERMES_HOME: "/elsewhere" })).toEqual({ refreshed: true, detail: null });
    expect(readFileSync(log, "utf8").trim()).toBe(`${root}|-p alex sessions refresh-prompts --json`);
  });

  it("a failure or a hang → refreshed:false with a bounded detail", async () => {
    const { base, root } = setup();
    expect(await refreshPrompts(script(path.join(base, "f", "hermes"), "echo 'secret path /x' >&2; exit 3"), root, "alex", {})).toEqual({ refreshed: false, detail: "refresh_failed:3" });
    expect(await refreshPrompts(script(path.join(base, "s", "hermes"), "sleep 1"), root, "alex", {}, 100)).toEqual({ refreshed: false, detail: "refresh_timeout" });
    expect(await refreshPrompts(path.join(base, "none", "hermes"), root, "alex", {})).toEqual({ refreshed: false, detail: "refresh_spawn:ENOENT" });
  });
});

describe("setBotAccess", () => {
  it("fresh → 0 files; on → skill + marker + wrapper, then refresh; off → 0 files, wrapper gone", async () => {
    const { root, alex, bb, dataDir } = setup();
    withEnv({ BB_CLI: bb, BB_SERVER_URL: "https://bb.example.test", BB_HOST_DAEMON_PORT: undefined });
    const calls: unknown[][] = [];
    const h = harness(dataDir, async (...a) => (calls.push(a.slice(0, 3)), { refreshed: true, detail: null }));
    script(path.join(root, "hermes-agent", ".hermes", "bin", "hermes"), "exit 0");
    expect(files(path.join(alex, SKILL_DIR))).toEqual([]);
    expect(files(dataDir)).toEqual([]);

    const on = await h.experimental_call("setBotAccess", { root, profile_home: alex, on: true, enabled_bots: [alex] });
    expect(on).toEqual({ skill: "written", wrapper: "written", refreshed: true, detail: null });
    expect(files(path.join(alex, SKILL_DIR))).toEqual([MARKER_FILE, "SKILL.md"]);
    const wrapper = path.join(dataDir, WRAPPER_PATH);
    expect(readFileSync(path.join(alex, SKILL_DIR, "SKILL.md"), "utf8")).toContain(`\`${wrapper} thread list --json\``);
    expect(JSON.parse(readFileSync(path.join(alex, SKILL_DIR, MARKER_FILE), "utf8"))).toEqual({ plugin: "bb-plugin-hermes", version: expect.any(String), profile_home: alex });
    expect(readFileSync(wrapper, "utf8")).toContain(`BB_SERVER_URL=https://bb.example.test\nexport BB_SERVER_URL\nPATH=${path.dirname(process.execPath)}:"$PATH"\nexport PATH\nexec ${bb} "$@"`);
    expect(calls).toEqual([[path.join(root, "hermes-agent", ".hermes", "bin", "hermes"), root, "alex"]]);
    expect(readFileSync(path.join(alex, "skills/own-skill/SKILL.md"), "utf8")).toBe("the bot's own skill\n");

    // Again: nothing to write, still refreshed (a retry after a failed refresh must reach the sessions).
    expect(await h.experimental_call("setBotAccess", { root, profile_home: alex, on: true, enabled_bots: [alex] })).toEqual({ skill: "current", wrapper: "current", refreshed: true, detail: null });

    const off = await h.experimental_call("setBotAccess", { root, profile_home: alex, on: false, enabled_bots: [] });
    expect(off).toEqual({ skill: "removed", wrapper: "removed", refreshed: true, detail: null });
    expect(existsSync(path.join(alex, SKILL_DIR))).toBe(false);
    expect(files(dataDir)).toEqual([]);
    expect(files(path.join(alex, "skills"))).toEqual(["own-skill/SKILL.md"]);
    expect(calls).toHaveLength(3);
  });

  it("off while another bot is on keeps the wrapper", async () => {
    const { root, alex, bob, bb, dataDir } = setup();
    withEnv({ BB_CLI: bb, BB_SERVER_URL: undefined, BB_HOST_DAEMON_PORT: undefined, PATH: path.join(root, "nobin") });
    const h = harness(dataDir, async () => ({ refreshed: true, detail: null }));
    script(path.join(root, "hermes-agent", "venv", "bin", "hermes"), "exit 0");
    await h.experimental_call("setBotAccess", { root, profile_home: alex, on: true, enabled_bots: [alex] });
    await h.experimental_call("setBotAccess", { root, profile_home: bob, on: true, enabled_bots: [alex, bob] });
    expect(await h.experimental_call("setBotAccess", { root, profile_home: alex, on: false, enabled_bots: [bob] })).toMatchObject({ skill: "removed", wrapper: "kept" });
    expect(files(dataDir)).toEqual([WRAPPER_PATH]);
    expect(files(path.join(bob, SKILL_DIR))).toEqual([MARKER_FILE, "SKILL.md"]);
    expect(await h.experimental_call("setBotAccess", { root, profile_home: bob, on: false, enabled_bots: [] })).toMatchObject({ skill: "removed", wrapper: "removed" });
    expect(files(dataDir)).toEqual([]);
  });

  it("a foreign dir is untouched, on and off", async () => {
    const { root, alex, bb, dataDir } = setup();
    withEnv({ BB_CLI: bb });
    let refreshes = 0;
    const h = harness(dataDir, async () => (refreshes++, { refreshed: true, detail: null }));
    script(path.join(root, "hermes-agent", "venv", "bin", "hermes"), "exit 0");
    const dir = path.join(alex, SKILL_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "someone else's\n");
    expect(await h.experimental_call("setBotAccess", { root, profile_home: alex, on: true, enabled_bots: [alex] })).toEqual({ skill: "foreign", wrapper: "written", refreshed: false, detail: "skill_foreign" });
    writeFileSync(path.join(dir, MARKER_FILE), JSON.stringify({ plugin: "another-plugin" }));
    expect(await h.experimental_call("setBotAccess", { root, profile_home: alex, on: false, enabled_bots: [] })).toEqual({ skill: "foreign", wrapper: "removed", refreshed: false, detail: "skill_foreign" });
    expect(files(dir)).toEqual([MARKER_FILE, "SKILL.md"]);
    expect(readFileSync(path.join(dir, "SKILL.md"), "utf8")).toBe("someone else's\n");
    expect(refreshes).toBe(0);
  });

  it("refresh failure, no hermes, no bb, a home outside the folder → bounded details", async () => {
    const { root, alex, bb, dataDir } = setup();
    withEnv({ BB_CLI: bb, PATH: path.join(root, "nobin") });
    const h = harness(dataDir, async () => ({ refreshed: false, detail: "refresh_failed:1" }));
    expect(await h.experimental_call("setBotAccess", { root, profile_home: alex, on: true, enabled_bots: [alex] })).toEqual({ skill: "written", wrapper: "written", refreshed: false, detail: "hermes_not_found" });
    script(path.join(root, "hermes-agent", "venv", "bin", "hermes"), "exit 0");
    expect(await h.experimental_call("setBotAccess", { root, profile_home: alex, on: true, enabled_bots: [alex] })).toEqual({ skill: "current", wrapper: "current", refreshed: false, detail: "refresh_failed:1" });
    expect(await h.experimental_call("setBotAccess", { root, profile_home: "/private/tmp/bb-hermes-test/x", on: true, enabled_bots: [alex] })).toMatchObject({ detail: "profile_outside_root", skill: "absent" });
    withEnv({ BB_CLI: undefined });
    expect(await h.experimental_call("setBotAccess", { root, profile_home: path.join(root, "profiles", "bob"), on: true, enabled_bots: [alex] })).toEqual({ skill: "absent", wrapper: "absent", refreshed: false, detail: "bb_not_found" });
  });

  it("the real refresh run with a stub hermes: exit 0 → refreshed", async () => {
    const { base, root, alex, bb, dataDir } = setup();
    withEnv({ BB_CLI: bb });
    const log = path.join(base, "ran.txt");
    script(path.join(root, "hermes-agent", "venv", "bin", "hermes"), `echo "$HERMES_HOME $*" >> '${log}'`);
    const h = experimental_createHostEntryHarness(createHostEntry(), { experimental_paths: { dataDir, tempDir: dataDir } });
    cleanups.push(() => h.experimental_dispose());
    expect(await h.experimental_call("setBotAccess", { root, profile_home: alex, on: true, enabled_bots: [alex] })).toMatchObject({ refreshed: true, detail: null });
    expect(readFileSync(log, "utf8")).toBe(`${root} -p alex sessions refresh-prompts --json\n`);
  });
});

describe("ensureWatch keeps the wrapper current", () => {
  it("rewrites it when bb or its server moves, only while a bot is on", async () => {
    const { root, alex, bb, dataDir } = setup();
    const h = harness(dataDir, async () => ({ refreshed: true, detail: null }));
    const wrapper = path.join(dataDir, WRAPPER_PATH);
    withEnv({ BB_CLI: bb, BB_SERVER_URL: "https://bb.example.test", BB_HOST_DAEMON_PORT: undefined });
    await h.experimental_call("ensureWatch", { root, enabled_bots: [] });
    expect(existsSync(wrapper)).toBe(false);
    await h.experimental_call("ensureWatch", { root, enabled_bots: [alex] });
    expect(readFileSync(wrapper, "utf8")).toContain("BB_SERVER_URL=https://bb.example.test\n");
    withEnv({ BB_SERVER_URL: "https://bb2.example.test" });
    await h.experimental_call("ensureWatch", { root, enabled_bots: [alex] });
    expect(readFileSync(wrapper, "utf8")).toContain("BB_SERVER_URL=https://bb2.example.test\n");
  });
});

// `setBotAccess` (02 flow 1 step 2, §bb access and security, A43–A45): an enabled bot gets the shared
// wrapper `<worker dataDir>/bin/bb-hermes` and the plugin skill in `<profile home>/skills/bb-plugin-hermes/`,
// then `hermes -p <profile> sessions refresh-prompts` makes continuing sessions pick the change up.
// The only file in src/worker that runs a process. Never touches the bot's other skills, `config.yaml` or `.env`.
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import skillTemplate from "../../assets/skill/SKILL.md" with { type: "text" };
import pkg from "../../package.json" with { type: "json" };
import { canonicalHome } from "../hermes/control.js";
import type { BotAccess } from "../shared/host-contract.js";

export const PLUGIN = "bb-plugin-hermes";
export const SKILL_DIR = path.join("skills", PLUGIN);
export const MARKER_FILE = ".bb-plugin-hermes.json";
export const WRAPPER_PATH = path.join("bin", "bb-hermes");

/** What `bb` targets with no `BB_SERVER_URL` / `BB_HOST_DAEMON_PORT` (bb's CLI defaults). */
const DEFAULT_SERVER_ORIGINS = new Set(["http://127.0.0.1:38886", "http://localhost:38886"]);
const DEFAULT_DAEMON_PORT = "38887";

export interface BbTarget {
  /** Absolute path of the `bb` executable. */
  bb: string;
  /** Set in the wrapper only when bb's default would miss the server (remote, or a non-default port). */
  serverUrl: string | null;
  daemonPort: string | null;
}

const isExecutable = (file: string) => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

function onPath(name: string, envPath: string | undefined, exists: (file: string) => boolean): string | null {
  for (const dir of (envPath ?? "").split(path.delimiter)) {
    if (dir && path.isAbsolute(dir) && exists(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

function isDefaultServer(url: string): boolean {
  try {
    const u = new URL(url);
    return DEFAULT_SERVER_ORIGINS.has(u.origin) && (u.pathname === "/" || u.pathname === "");
  } catch {
    return false;
  }
}

/**
 * A44: how the Hermes machine reaches bb, from the environment the daemon gives each host call
 * (`BB_CLI`, `BB_SERVER_URL`, `BB_HOST_DAEMON_PORT`, `PATH` with bb's directory). Read it at the start
 * of a call: the worker restores its own environment after the call. Null: no `bb` found.
 */
export function bbTarget(env: NodeJS.ProcessEnv, exists: (file: string) => boolean = isExecutable): BbTarget | null {
  const cli = env.BB_CLI?.trim();
  const bb = cli && path.isAbsolute(cli) && exists(cli) ? cli : onPath("bb", env.PATH, exists);
  if (!bb) return null;
  const server = env.BB_SERVER_URL?.trim();
  const port = env.BB_HOST_DAEMON_PORT?.trim();
  return {
    bb,
    serverUrl: server && !isDefaultServer(server) ? server : null,
    daemonPort: port && /^\d{1,5}$/.test(port) && port !== DEFAULT_DAEMON_PORT ? port : null,
  };
}

const shellQuote = (s: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

export function wrapperScript(target: BbTarget): string {
  return [
    "#!/bin/sh",
    `# bb for Hermes bots, written by the bb Hermes plugin (${PLUGIN}). Rewritten when bb moves: don't edit.`,
    ...(target.serverUrl ? [`BB_SERVER_URL=${shellQuote(target.serverUrl)}`, "export BB_SERVER_URL"] : []),
    ...(target.daemonPort ? [`BB_HOST_DAEMON_PORT=${target.daemonPort}`, "export BB_HOST_DAEMON_PORT"] : []),
    `exec ${shellQuote(target.bb)} "$@"`,
    "",
  ].join("\n");
}

/** The bundled skill with the wrapper's absolute path. */
export function renderSkill(wrapper: string): string {
  return skillTemplate.replaceAll("{{BB}}", shellQuote(wrapper));
}

export function markerJson(profileHome: string): string {
  return JSON.stringify({ plugin: PLUGIN, version: pkg.version, profile_home: profileHome }, null, 2) + "\n";
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function writeWhole(file: string, content: string, mode: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content, { mode });
  await rename(tmp, file);
}

/** Write `content` unless the file already holds it. */
async function ensureFile(file: string, content: string, mode: number): Promise<"written" | "current"> {
  if ((await readText(file)) === content) return "current";
  await writeWhole(file, content, mode);
  return "written";
}

/** null: no dir; true: our marker is in it; false: anything else is there. */
async function ownsSkillDir(dir: string): Promise<boolean | null> {
  if (!(await stat(dir).catch(() => null))) return null;
  const marker = await readText(path.join(dir, MARKER_FILE));
  try {
    return marker !== null && (JSON.parse(marker) as { plugin?: unknown }).plugin === PLUGIN;
  } catch {
    return false;
  }
}

/** On: marker first (so a half-written dir is still ours), then `SKILL.md`. A dir without our marker is `foreign`. */
export async function writeSkill(profileFsHome: string, profileHome: string, wrapper: string): Promise<BotAccess["skill"]> {
  const dir = path.join(profileFsHome, SKILL_DIR);
  if ((await ownsSkillDir(dir)) === false) return "foreign";
  const marker = await ensureFile(path.join(dir, MARKER_FILE), markerJson(profileHome), 0o644);
  const skill = await ensureFile(path.join(dir, "SKILL.md"), renderSkill(wrapper), 0o644);
  return marker === "current" && skill === "current" ? "current" : "written";
}

/** Off: delete the dir only when our marker is in it. */
export async function removeSkill(profileFsHome: string): Promise<BotAccess["skill"]> {
  const dir = path.join(profileFsHome, SKILL_DIR);
  const owned = await ownsSkillDir(dir);
  if (owned === null) return "absent";
  if (!owned) return "foreign";
  await rm(dir, { recursive: true, force: true });
  return "removed";
}

export async function writeWrapper(dataDir: string, target: BbTarget): Promise<"written" | "current"> {
  return ensureFile(path.join(dataDir, WRAPPER_PATH), wrapperScript(target), 0o755);
}

export async function removeWrapper(dataDir: string): Promise<"removed" | "absent"> {
  const file = path.join(dataDir, WRAPPER_PATH);
  if ((await readText(file)) === null) return "absent";
  await rm(file, { force: true });
  return "removed";
}

/** The `-p` name of a profile home: `default` for the root, else its folder under `<root>/profiles/`. */
export function profileNameFromHome(rootHome: string, profileHome: string): string | null {
  const root = canonicalHome(rootHome);
  const home = canonicalHome(profileHome);
  if (home === root) return "default";
  return path.dirname(home) === path.join(root, "profiles") ? path.basename(home) : null;
}

/**
 * The Hermes CLI of the install under `rootHome`: the installer's launcher (`scripts/install.sh`), then its
 * venv. Never `hermes` from `PATH`: a CLI whose checkout belongs to another data root first "prepares
 * dependencies for this data root", a ~1 GB install into the folder (seen on isolated Hermes c314285f07).
 * Other layouts → null (`hermes_not_found`), as the version check reports them unknown (A51).
 */
export function hermesCli(rootHome: string, exists: (file: string) => boolean = isExecutable): string | null {
  for (const rel of [[".hermes", "bin", "hermes"], ["venv", "bin", "hermes"]]) {
    const file = path.join(rootHome, "hermes-agent", ...rel);
    if (exists(file)) return file;
  }
  return null;
}

export interface RefreshResult {
  refreshed: boolean;
  /** Bounded: `refresh_failed:<exit>`, `refresh_timeout` (still running), `refresh_spawn:<code>`. */
  detail: string | null;
}

export const REFRESH_TIMEOUT_MS = 20_000;

/**
 * `hermes -p <profile> sessions refresh-prompts --json` against this folder only (`HERMES_HOME` = the
 * expanded root): it records a refresh epoch in the profile's `state.db` and needs no gateway
 * (`hermes_cli/sessions_cmd.py:1309`). Output is never forwarded.
 */
export function refreshPrompts(
  cli: string,
  rootHome: string,
  profile: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = REFRESH_TIMEOUT_MS,
): Promise<RefreshResult> {
  return new Promise((resolve) => {
    const child = spawn(cli, ["-p", profile, "sessions", "refresh-prompts", "--json"], {
      cwd: rootHome,
      env: { ...env, HERMES_HOME: rootHome },
      stdio: ["ignore", "ignore", "ignore"],
    });
    // Past the deadline the run is left to finish on its own (Hermes may be repairing its install):
    // killing it could leave that half done. The answer is then unknown.
    const timer = setTimeout(() => {
      child.unref();
      resolve({ refreshed: false, detail: "refresh_timeout" });
    }, timeoutMs);
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ refreshed: false, detail: `refresh_spawn:${err.code ?? "error"}`.slice(0, 64) });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(code === 0 ? { refreshed: true, detail: null } : { refreshed: false, detail: `refresh_failed:${code ?? signal}` });
    });
  });
}

export interface AccessInput {
  /** Expanded root. */
  rootHome: string;
  profileHome: string;
  on: boolean;
  enabledBots: string[];
  /** The worker's own dataDir: the wrapper lives in `bin/`. */
  dataDir: string;
  /** The call's environment (A44). */
  env: NodeJS.ProcessEnv;
  refresh?: typeof refreshPrompts;
  exists?: (file: string) => boolean;
}

export async function setBotAccess(input: AccessInput): Promise<BotAccess> {
  const { rootHome, profileHome, on, dataDir, env } = input;
  const name = profileNameFromHome(rootHome, profileHome);
  if (!name) return { skill: "absent", wrapper: "absent", refreshed: false, detail: "profile_outside_root" };
  const fsHome = canonicalHome(profileHome);
  const wrapperFile = path.join(dataDir, WRAPPER_PATH);
  const othersOn = input.enabledBots.some((h) => h !== profileHome);
  const target = bbTarget(env, input.exists);

  let skill: BotAccess["skill"];
  let wrapper: BotAccess["wrapper"];
  if (on) {
    if (!target) return { skill: "absent", wrapper: "absent", refreshed: false, detail: "bb_not_found" };
    wrapper = await writeWrapper(dataDir, target);
    skill = await writeSkill(fsHome, profileHome, wrapperFile);
  } else {
    skill = await removeSkill(fsHome);
    if (othersOn) {
      if (target) await writeWrapper(dataDir, target);
      wrapper = "kept";
    } else wrapper = await removeWrapper(dataDir);
  }
  if (skill === "foreign") return { skill, wrapper, refreshed: false, detail: "skill_foreign" };
  const cli = hermesCli(rootHome, input.exists);
  if (!cli) return { skill, wrapper, refreshed: false, detail: "hermes_not_found" };
  const { refreshed, detail } = await (input.refresh ?? refreshPrompts)(cli, rootHome, name, env);
  return { skill, wrapper, refreshed, detail };
}

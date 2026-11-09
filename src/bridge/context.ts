// Which Hermes chat a command is for (02 §Provider options): the server's thread view when it has bound the
// thread, else (a fresh New Thread or `bb thread spawn --provider hermes --option profile=<bot>`, A18) the session
// option and the worker's `enabled` list; with no bot given, what an untouched chip shows (`fallbackBot`). Every
// refusal is a user-facing sentence, for the app and the CLI alike (01 §2, §9).
import { botLabel } from "../shared/bots.js";
import { type EnabledBot, fallbackBot, type WorkerFile } from "../shared/bridge-files.js";
import { NO_BOT_TEXT, NO_BOT_TITLE, otherMachineText, type ProviderOptions, readProviderOptions, switchedOffText, type ThreadView } from "../shared/provider-options.js";
import { expandHome, readWorkerFile, sameFolder, type ThreadEntry } from "./files.js";

/** A refusal shown to the user as the turn's error. */
export class UserFacingError extends Error {}

export const NOT_CONNECTED_TEXT = "Hermes isn't connected: pick the Hermes machine in the Hermes plugin settings.";
/** No bot given and none to fall back to: none is on, or (rare) none that's on is served by the gateway. */
export const noBotText = (enabled: readonly EnabledBot[]) =>
  enabled.length ? "No Hermes bot that's on is served by this machine's gateway." : `${NO_BOT_TITLE}. ${NO_BOT_TEXT}`;

export interface ThreadContext {
  /** The Hermes folder, expanded on this machine. */
  root: string;
  kind: ThreadView["kind"];
  profile: string;
  profileHome: string;
  botLabel: string;
  lineageRoot: string | null;
  sessionId: string | null;
  legacy: boolean;
  /** Where the chat works: bb's folder in a project (D54), else the bot's `terminal.cwd`, else null (→ `~`). */
  cwd: string | null;
  /** The server hasn't bound this thread yet: the bridge derived it. */
  derived: boolean;
}

export interface ResolveInput {
  providerOptions: unknown;
  sessionOptions?: Record<string, string | boolean> | undefined;
  /** What the bridge remembers for this thread (the `init` marker's profile). */
  saved?: ThreadEntry | undefined;
  dataDir: string;
  /** bb's folder for the thread (`thread/start`, `thread/resume`). */
  cwd?: string | undefined;
}

/** The server's options, or a refusal. Checks the machine before anything touches Hermes. */
export function resolveContext(input: ResolveInput): ThreadContext {
  const options: ProviderOptions | null = readProviderOptions(input.providerOptions);
  if (!options?.machine) throw new UserFacingError(NOT_CONNECTED_TEXT);
  const worker: WorkerFile | null = readWorkerFile(input.dataDir);
  if (!worker || !sameFolder(worker.root, options.folder)) {
    // An unnamed machine: its id, which `--machine` takes too.
    throw new UserFacingError(otherMachineText(options.machine.name ?? options.machine.id));
  }
  const root = expandHome(options.folder);
  const view = options.thread;
  const project = options.project && input.cwd ? input.cwd : null;
  if (view) {
    if (!view.enabled) throw new UserFacingError(switchedOffText(view.bot_label));
    return {
      root,
      kind: view.kind,
      profile: view.profile,
      profileHome: view.profile_home,
      botLabel: view.bot_label,
      lineageRoot: view.lineage_root,
      sessionId: view.session_id,
      legacy: view.legacy,
      cwd: project ?? view.cwd,
      derived: false,
    };
  }
  const asked = typeof input.sessionOptions?.profile === "string" ? input.sessionOptions.profile : (input.saved?.profile ?? null);
  const bot = asked ? worker.enabled.find((b) => b.profile === asked) : fallbackBot(worker.enabled);
  if (!bot) throw new UserFacingError(asked ? switchedOffText(botLabel(asked)) : noBotText(worker.enabled));
  return {
    root,
    kind: input.saved?.bot ? "bot" : "chat",
    profile: bot.profile,
    profileHome: bot.profile_home,
    botLabel: bot.bot_label,
    lineageRoot: null,
    sessionId: null,
    legacy: false,
    cwd: project ?? bot.cwd,
    derived: true,
  };
}

/** `providerThreadId` (02 §Mapping db identity rules). */
export const botIdentity = (profileHome: string) => `${profileHome}#bot`;
export const chatIdentity = (profileHome: string, lineageRoot: string) => `${profileHome}#${lineageRoot}`;
export const isPending = (providerThreadId: string) => providerThreadId.startsWith("pending:");

// Which Hermes chat a command is for (02 §Provider options): the server's thread view when it has bound the
// thread, else (a fresh `bb thread spawn --provider hermes --option profile=<bot>`, A18) the session option
// and the worker's `enabled` list. Every refusal is a user-facing sentence (01 §2, §9).
import { botLabel } from "../shared/bots.js";
import type { EnabledBot, WorkerFile } from "../shared/bridge-files.js";
import { otherMachineText, type ProviderOptions, readProviderOptions, switchedOffText, type ThreadView } from "../shared/provider-options.js";
import { expandHome, readWorkerFile, sameFolder, type ThreadEntry } from "./files.js";

/** A refusal shown to the user as the turn's error. */
export class UserFacingError extends Error {}

export const NOT_CONNECTED_TEXT = "Hermes isn't connected: pick the Hermes machine in the Hermes plugin settings.";
export const noBotText = (enabled: readonly EnabledBot[]) =>
  enabled.length
    ? `Pick a bot: add \`--option profile=<bot>\` (switched on: ${enabled.map((b) => b.profile).join(", ")}).`
    : "No bot is switched on in the Hermes plugin settings.";

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
  /** `terminal.cwd`, else null (→ `~`). */
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
}

/** The server's options, or a refusal. Checks the machine before anything touches Hermes. */
export function resolveContext(input: ResolveInput): ThreadContext {
  const options: ProviderOptions | null = readProviderOptions(input.providerOptions);
  if (!options?.machine) throw new UserFacingError(NOT_CONNECTED_TEXT);
  const worker: WorkerFile | null = readWorkerFile(input.dataDir);
  if (!worker || !sameFolder(worker.root, options.folder)) {
    throw new UserFacingError(otherMachineText(options.machine.name ?? "the Hermes machine"));
  }
  const root = expandHome(options.folder);
  const view = options.thread;
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
      cwd: view.cwd,
      derived: false,
    };
  }
  const asked = typeof input.sessionOptions?.profile === "string" ? input.sessionOptions.profile : (input.saved?.profile ?? null);
  const bot = asked ? worker.enabled.find((b) => b.profile === asked) : worker.enabled.find((b) => b.profile === "default");
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
    cwd: bot.cwd,
    derived: true,
  };
}

/** `providerThreadId` (02 §Mapping db identity rules). */
export const botIdentity = (profileHome: string) => `${profileHome}#bot`;
export const chatIdentity = (profileHome: string, lineageRoot: string) => `${profileHome}#${lineageRoot}`;
export const isPending = (providerThreadId: string) => providerThreadId.startsWith("pending:");

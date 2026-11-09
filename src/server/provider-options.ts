// `deriveProviderOptions` (02 §Placement, §Provider options): the folder, the machine and this thread's
// binding, read synchronously from settings and the mapping db on every bridge command. Keep it fast.
import type { PluginProviderOptionsContext } from "@get-bb/plugin-sdk";
import { botLabel } from "../shared/bots.js";
import type { ProviderOptions, ThreadView } from "../shared/provider-options.js";
import { DEFAULT_FOLDER } from "../shared/settings.js";
import { bindingByThread, botRecord, getKv, type Db } from "./db.js";

/** kv: the folder the machine was set with; a different folder setting means no Hermes I/O (R8). */
export const MACHINE_FOLDER_KEY = "machine_folder";

export function machineFolder(db: Db): string | null {
  const value = getKv(db, MACHINE_FOLDER_KEY);
  return typeof value === "string" ? value : null;
}

/** kv: `{id, name}` of the Hermes machine as `hosts.list` last named it, for "Hermes runs on <machine>". */
export const MACHINE_NAME_KEY = "machine_name";

/** The saved name of machine `id`; null if never seen (or another machine's). */
export function machineName(db: Db, id: string): string | null {
  const value = getKv(db, MACHINE_NAME_KEY) as { id?: unknown; name?: unknown } | null;
  return value?.id === id && typeof value.name === "string" ? value.name : null;
}

/** The saved Hermes machine with its name, if it is valid for this folder (a moved folder means no Hermes I/O, R8). */
export function hermesMachine(db: Db, folder: string): { id: string; name: string | null } | null {
  const machine = getKv(db, "machine");
  const saved = machineFolder(db);
  if (typeof machine !== "string" || !machine || (saved !== null && saved !== folder)) return null;
  return { id: machine, name: machineName(db, machine) };
}

function threadView(db: Db, threadId: string): ThreadView | null {
  const binding = bindingByThread(db, threadId);
  const bot = binding ? botRecord(db, binding.profile_home) : null;
  if (!binding || !bot) return null;
  return {
    kind: binding.kind,
    profile: bot.name,
    profile_home: binding.profile_home,
    bot_label: botLabel(bot.name, bot.handle),
    enabled: bot.enabled,
    lineage_root: binding.lineage_root,
    session_id: binding.session_id,
    legacy: binding.legacy,
    cwd: bot.cwd,
  };
}

export function deriveProviderOptions(db: Db, { settings, threadId }: Pick<PluginProviderOptionsContext, "settings" | "threadId">): ProviderOptions {
  const folder = typeof settings.folder === "string" && settings.folder !== "" ? settings.folder : DEFAULT_FOLDER;
  return { folder, machine: hermesMachine(db, folder), thread: threadView(db, threadId) };
}

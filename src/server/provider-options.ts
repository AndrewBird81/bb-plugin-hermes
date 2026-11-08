// `deriveProviderOptions` (02 §Placement): the folder, the machine and this thread's binding, read
// synchronously from settings and the mapping db on every bridge command. The server seam fills `thread`.
import type { PluginProviderOptionsContext } from "@get-bb/plugin-sdk";
import type { ProviderOptions } from "../shared/provider-options.js";
import { DEFAULT_FOLDER } from "../shared/settings.js";
import { getKv, type Db } from "./db.js";

export function deriveProviderOptions(db: Db, { settings }: Pick<PluginProviderOptionsContext, "settings" | "threadId">): ProviderOptions {
  const folder = typeof settings.folder === "string" && settings.folder !== "" ? settings.folder : DEFAULT_FOLDER;
  const machine = getKv(db, "machine");
  return { folder, machine: typeof machine === "string" && machine ? { id: machine, name: null } : null, thread: null };
}

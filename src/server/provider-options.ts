// `deriveProviderOptions` (02 §Placement, §Provider options): the folder, the machine and this thread's
// binding, read synchronously from settings and the mapping db on every bridge command. Keep it fast.
import type { PluginProviderOptionsContext } from "@get-bb/plugin-sdk";
import { botLabel } from "../shared/bots.js";
import type { ProviderOptions, ThreadView } from "../shared/provider-options.js";
import { DEFAULT_FOLDER } from "../shared/settings.js";
import { SOURCE_TAGS, type SourceTag } from "../shared/sources.js";
import { bindingByThread, botRecord, getKv, type Db } from "./db.js";

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
    tag: (SOURCE_TAGS as readonly string[]).includes(binding.tag ?? "") ? (binding.tag as SourceTag) : null,
    cwd: bot.cwd,
  };
}

export function deriveProviderOptions(db: Db, { settings, threadId }: Pick<PluginProviderOptionsContext, "settings" | "threadId">): ProviderOptions {
  const folder = typeof settings.folder === "string" && settings.folder !== "" ? settings.folder : DEFAULT_FOLDER;
  const machine = getKv(db, "machine");
  return {
    folder,
    machine: typeof machine === "string" && machine ? { id: machine, name: null } : null,
    thread: threadView(db, threadId),
  };
}

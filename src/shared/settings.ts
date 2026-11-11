// Connection settings (01 §1, 02 §Placement). The folder is a `bb.settings` field, so bridges get it
// through `deriveProviderOptions`. The machine lives in the mapping db's `kv`, set by `setConnection`:
// the app's Connection section picks it by name, and bb's settings form never shows a host id.
import type { PluginSettingDescriptors, PluginSettingsHandle } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const DEFAULT_FOLDER = "~/.hermes";

/** A bb host id; "" = not set (no Hermes I/O, R3 M3). */
export const machineSchema = z.string().regex(/^([A-Za-z0-9_-]{1,64})?$/, "Pick a bb machine.");

/** Absolute, or under the Hermes machine's home (`~` is expanded there, by the worker). */
export const folderSchema = z
  .string()
  .max(1024)
  .regex(/^(~|~\/.+|\/.+)$/, "Use an absolute path or one starting with ~/.");

export const settingsDescriptors = {
  folder: {
    type: "string",
    label: "Hermes folder",
    description: "Hermes' home on the Hermes machine.",
    default: DEFAULT_FOLDER,
    experimental_schema: folderSchema,
  },
  models: {
    type: "string",
    label: "Models",
    description:
      "Show only these models in Hermes chats, one provider/model per line (e.g. openai-codex/gpt-6.1-sol). Each bot shows the ones it has. Empty: all of them. \"The bot's model\" is always offered.",
    default: "",
    experimental_multiline: true,
  },
} satisfies PluginSettingDescriptors;

/** The `models` setting as ids: one per line (or comma), trimmed, no blanks or repeats. Empty = every model. */
export const parseModels = (text: string): string[] => [...new Set(text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];

export interface ConnectionSettings {
  machine: string;
  folder: string;
}

export type SettingsHandle = PluginSettingsHandle<typeof settingsDescriptors>;

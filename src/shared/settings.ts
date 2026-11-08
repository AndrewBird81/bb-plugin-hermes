// Plugin settings (01 §1, 02 §Placement): the Hermes machine and folder. Server-side `bb.settings.define`;
// the app reads them with `useSettings()` and writes them through the `setConnection` RPC.
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
  machine: {
    type: "string",
    label: "Hermes machine",
    description: "The bb machine that runs Hermes. Empty: not connected.",
    default: "",
    experimental_schema: machineSchema,
  },
  folder: {
    type: "string",
    label: "Hermes folder",
    description: "Hermes' home on that machine.",
    default: DEFAULT_FOLDER,
    experimental_schema: folderSchema,
  },
} satisfies PluginSettingDescriptors;

export interface ConnectionSettings {
  machine: string;
  folder: string;
}

export type SettingsHandle = PluginSettingsHandle<typeof settingsDescriptors>;

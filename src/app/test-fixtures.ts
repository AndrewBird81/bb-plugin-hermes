// Shared fixtures for the app's slot tests.
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { BotRow, Health, ThreadInfo } from "../shared/rpc-contract.js";
import { DEFAULT_FOLDER } from "../shared/settings.js";

export const loadApp = () => loadPluginApp(() => import("../../app.js"));

export function bot(name: string, extra: Partial<BotRow> = {}): BotRow {
  return {
    profile: name,
    profile_home: `/hermes/profiles/${name}`,
    bot_label: name.charAt(0).toUpperCase() + name.slice(1),
    served: true,
    enabled: false,
    thread_id: null,
    import_count: null,
    ...extra,
  };
}

export function info(kind: ThreadInfo["kind"], extra: Partial<ThreadInfo> = {}): ThreadInfo {
  return { kind, profile_home: "/hermes/profiles/neo", bot_label: "Neo", enabled: true, tag: null, ...extra };
}

export function health(state: Health["state"], name: string | null = "studio"): Health {
  return {
    state,
    machine: { id: "host_a", name, online: state !== "machine_offline" },
    folder: DEFAULT_FOLDER,
    connected: state === "connected",
    version: null,
    supported: null,
    detail: null,
    worker_last_seen_at: null,
  };
}

/** The fields the app reads; the rest of bb's row is irrelevant here. */
export function thread(id: string, extra: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return { id, providerId: "hermes", isUnread: false, displayTitle: id, ...extra } as PluginSidebarThread;
}

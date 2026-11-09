// App (app seam): settings sections, row badge, thread banners and the Hermes icon.
import type { definePluginApp } from "@get-bb/plugin-sdk/app";
import { BotSwitches } from "./bot-switches.js";
import { ConnectionSection } from "./connection-section.js";
import { HermesIcon } from "./hermes-icon.js";
import { RowBadge, useRowData, type RowData } from "./row-badge.js";
import { OfflineBanner, StatusBanner } from "./thread-banners.js";
import { HERMES_PROVIDER } from "./thread-info.js";

type Setup = Parameters<typeof definePluginApp>[0];

export const registerApp: Setup = (app) => {
  // The composer and pickers draw this wherever bb renders the Hermes provider's icon (A52).
  app.slots.experimental_providerIcon({ providerKind: "agent", providerId: HERMES_PROVIDER, icon: HermesIcon });
  app.slots.settingsSection({
    id: "connection",
    title: "Connection",
    description: "The bb machine that runs Hermes, and how the plugin reaches it.",
    component: ConnectionSection,
  });
  app.slots.settingsSection({
    id: "bots",
    title: "Bots",
    description: "Which Hermes bots you use in bb. Every bot starts off.",
    component: BotSwitches,
  });
  app.slots.experimental_threadRowMetadata<RowData>({ id: "hermes", useData: useRowData, component: RowBadge });
  app.composer.customize({
    id: "hermes-thread",
    scopes: ["thread"],
    banners: [
      { id: "status", component: StatusBanner },
      { id: "offline", component: OfflineBanner },
    ],
  });
};

// App (app seam): the settings section (T0.10); later the rail panel, row badge and banners.
import type { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ConnectionSection } from "./connection-section.js";

type Setup = Parameters<typeof definePluginApp>[0];

export const registerApp: Setup = (app) => {
  app.slots.settingsSection({
    id: "connection",
    title: "Connection",
    description: "The bb machine that runs Hermes, and how the plugin reaches it.",
    component: ConnectionSection,
  });
};

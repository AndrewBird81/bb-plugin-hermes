// bb.app entry: wiring only.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { registerApp } from "./src/app/index.js";

export default definePluginApp(registerApp);

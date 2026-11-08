// The two-client harness on an isolated Hermes (T1.13): `npx vitest run --config e2e/vitest.config.ts`.
import { defineConfig } from "vitest/config";
import base from "../vitest.config.js";

export default defineConfig({
  // `.md` as text, like the root config.
  plugins: base.plugins,
  test: {
    include: ["e2e/**/*.test.ts"],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
});

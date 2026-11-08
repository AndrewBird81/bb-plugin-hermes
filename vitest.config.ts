import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // `.md` imports are text, as bb's host build bundles them (`with { type: "text" }`).
  plugins: [{ name: "md-text", enforce: "pre", load: (id) => (id.endsWith(".md") ? `export default ${JSON.stringify(readFileSync(id, "utf8"))};` : null) }],
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "test/**/*.test.ts"],
    testTimeout: 15_000,
  },
});

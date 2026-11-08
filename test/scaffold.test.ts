import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("manifest", () => {
  it("declares the three entries and the icon", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.bb).toMatchObject({ server: "./server.ts", app: "./app.tsx", host: "./host.ts", branding: { icon: "./assets/hermes.svg" } });
  });
});

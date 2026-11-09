import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HERMES_PATHS, HermesIcon } from "./hermes-icon.js";

describe("Hermes icon", () => {
  it("the inline icon is assets/hermes.svg", () => {
    const asset = readFileSync("assets/hermes.svg", "utf8");
    expect([...asset.matchAll(/ d="([^"]+)"/g)].map((m) => m[1])).toEqual(HERMES_PATHS);
    // The Hermes Agent mark needs even-odd filling: both draw with it.
    expect(asset).toContain('fill-rule="evenodd"');
    expect(renderToStaticMarkup(<HermesIcon />)).toContain('fill-rule="evenodd"');
  });
});

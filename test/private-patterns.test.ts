import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs script module, no declarations
import { GENERIC_PATTERNS, TIME_ZONE_PATTERNS } from "../scripts/private-patterns.mjs";

type Pattern = [string, RegExp];
const hits = (patterns: Pattern[], text: string) => patterns.filter(([, rx]) => new RegExp(rx.source, rx.flags).test(text)).map(([name]) => name);
// Built from parts, so this file passes the guard it tests.
const zone = (abbr: string, offset: string) => `(${abbr}, UTC${offset})`;
const line = (z: string) => `Conversation started: Sunday, November 08, 2026 ${z}\nModel: stub`;

describe("check-private time-zone guard", () => {
  it("catches a local zone in Hermes' prompt line and passes the UTC one", () => {
    expect(hits(TIME_ZONE_PATTERNS, line(zone("C" + "ST", "-" + "06:00")))).toEqual(["local time zone", "local time zone"]);
    expect(hits(TIME_ZONE_PATTERNS, line(zone("C" + "DT", "-" + "05:00")))).not.toEqual([]);
    expect(hits(TIME_ZONE_PATTERNS, line(zone("JST", "+" + "09:00")))).toEqual(["local time zone"]);
    expect(hits(TIME_ZONE_PATTERNS, line(`(${"America" + "/" + "Chicago"}, CST, UTC-` + "06:00)"))).not.toEqual([]);
    expect(hits(TIME_ZONE_PATTERNS, line(zone("UTC", "+00:00")))).toEqual([]);
  });

  it("catches other spellings of the owner's zone", () => {
    expect(hits(TIME_ZONE_PATTERNS, `Sun Nov 08 2026 16:20:00 GMT-${"0600"} (${"Central"} Standard Time)`)).toHaveLength(2);
    expect(hits(TIME_ZONE_PATTERNS, "Mon Nov 09 2026 00:15:42 GMT+0000 (Coordinated Universal Time)")).toEqual([]);
  });

  it("ignores base64 noise and is part of the generic checks", () => {
    expect(hits(TIME_ZONE_PATTERNS, "AAAACSTBBBCDTqcst==")).toEqual([]);
    expect(GENERIC_PATTERNS).toEqual(expect.arrayContaining(TIME_ZONE_PATTERNS));
  });
});

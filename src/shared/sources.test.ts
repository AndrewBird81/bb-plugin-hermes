import { describe, expect, it } from "vitest";
import { eligibility, formatTag, SOURCE_TAG_PREFIX, type SessionFacts, tagFor } from "./sources.js";

const row = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  source: "local",
  created_source: "cli",
  legacy: false,
  title: "Fix the build",
  hidden: false,
  message_count: 3,
  ...over,
});
const ctx = { bbCreated: false, tombstoned: false };

describe("source allow-list (fails closed)", () => {
  it("tags the four surfaces", () => {
    expect(tagFor(row())).toBe("CLI");
    expect(tagFor(row({ created_source: "tui" }))).toBe("TUI");
    expect(tagFor(row({ created_source: "gui" }))).toBe("Desktop");
    expect(tagFor(row({ source: "desktop", created_source: null, legacy: true }))).toBe("Conduit");
    expect(tagFor(row({ source: "desktop", created_source: null, legacy: false }))).toBe("Desktop");
    expect(tagFor(row({ source: "cli", created_source: null, legacy: true }))).toBe("CLI");
  });

  it("keeps everything else out, unknown labels included", () => {
    for (const r of [
      row({ created_source: "cron" }),
      row({ created_source: "acp" }),
      row({ created_source: "a2a" }),
      row({ created_source: "tool" }),
      row({ created_source: "oneshot" }),
      row({ created_source: null }),
      row({ created_source: "unknown" }),
      row({ created_source: "CLI" }),
      row({ source: "discord", created_source: null }),
      row({ source: "telegram", created_source: "cli" }),
      row({ source: "cron", created_source: "cli" }),
      row({ source: null, created_source: "cli" }),
      row({ created_source: "toString" }),
    ]) {
      expect(eligibility(r, ctx)).toEqual({ kind: "out", reason: "source" });
    }
  });

  it("hidden, empty, bb-created and tombstoned rows stay out", () => {
    expect(eligibility(row({ hidden: true }), ctx)).toEqual({ kind: "out", reason: "hidden" });
    expect(eligibility(row({ message_count: 0 }), ctx)).toEqual({ kind: "out", reason: "empty" });
    expect(eligibility(row(), { ...ctx, bbCreated: true })).toEqual({ kind: "out", reason: "bb-created" });
    expect(eligibility(row(), { ...ctx, tombstoned: true })).toEqual({ kind: "out", reason: "tombstoned" });
  });

  it("a session titled Bot Chat is the bot thread only, whatever its source", () => {
    expect(eligibility(row({ title: "Bot Chat", hidden: true, source: "desktop", created_source: null, legacy: true }), ctx)).toEqual({ kind: "bot" });
    expect(eligibility(row({ title: "Bot Chat", message_count: 0 }), { bbCreated: true, tombstoned: true })).toEqual({ kind: "bot" });
    expect(eligibility(row({ title: "bot chat" }), ctx)).toEqual({ kind: "chat", tag: "CLI" });
  });

  it("accepts a visible chat", () => {
    expect(eligibility(row(), ctx)).toEqual({ kind: "chat", tag: "CLI" });
  });
});

describe("tags", () => {
  it("formats live and imported tags, and the prefix matches both", () => {
    expect(formatTag("CLI")).toBe("[CLI] ");
    const imported = formatTag("Conduit", new Date(Date.UTC(2026, 9, 12, 12)), "UTC");
    expect(imported).toBe("[Conduit · Oct 12] ");
    expect(SOURCE_TAG_PREFIX.test(`${formatTag("TUI")}x`)).toBe(true);
    expect(SOURCE_TAG_PREFIX.test(`${imported}x`)).toBe(true);
    expect(SOURCE_TAG_PREFIX.test("[Discord] x")).toBe(false);
    expect(SOURCE_TAG_PREFIX.test("[CLI]x")).toBe(false);
  });
});

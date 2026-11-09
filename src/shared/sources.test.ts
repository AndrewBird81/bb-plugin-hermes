import { describe, expect, it } from "vitest";
import { eligibility, OUTSIDE_TAG_PREFIX, outsideTag, type SessionFacts } from "./sources.js";

const row = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  source: "local",
  created_source: "cli",
  title: "Fix the build",
  hidden: false,
  message_count: 3,
  ...over,
});
const ctx = { bbCreated: false, tombstoned: false };

describe("source allow-list (fails closed)", () => {
  it("lets the four surfaces in, by their recorded value", () => {
    expect(eligibility(row(), ctx)).toEqual({ kind: "chat", surface: "cli" });
    expect(eligibility(row({ created_source: "tui" }), ctx)).toEqual({ kind: "chat", surface: "tui" });
    expect(eligibility(row({ created_source: "gui" }), ctx)).toEqual({ kind: "chat", surface: "gui" });
    expect(eligibility(row({ source: "desktop", created_source: null }), ctx)).toEqual({ kind: "chat", surface: "desktop" });
    expect(eligibility(row({ source: "cli", created_source: null }), ctx)).toEqual({ kind: "chat", surface: "cli" });
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
    expect(eligibility(row({ title: "Bot Chat", hidden: true, source: "desktop", created_source: null }), ctx)).toEqual({ kind: "bot" });
    expect(eligibility(row({ title: "Bot Chat", message_count: 0 }), { bbCreated: true, tombstoned: true })).toEqual({ kind: "bot" });
    expect(eligibility(row({ title: "bot chat" }), ctx)).toEqual({ kind: "chat", surface: "cli" });
  });

  it("accepts a visible chat", () => {
    expect(eligibility(row(), ctx)).toEqual({ kind: "chat", surface: "cli" });
  });
});

describe("tags", () => {
  it("never name an app: live and imported tags, and the prefix (D15) matches both", () => {
    expect(outsideTag()).toBe("[Outside bb] ");
    const imported = outsideTag(new Date(Date.UTC(2026, 9, 12, 12)), "UTC");
    expect(imported).toBe("[Outside bb · Oct 12] ");
    expect(OUTSIDE_TAG_PREFIX.test(`${outsideTag()}x`)).toBe(true);
    expect(OUTSIDE_TAG_PREFIX.test(`${imported}x`)).toBe(true);
    for (const old of ["[CLI] x", "[Conduit · Oct 12] x", "[Discord] x", "[Outside bb]x", "[outside bb] x"]) expect(OUTSIDE_TAG_PREFIX.test(old)).toBe(false);
  });
});

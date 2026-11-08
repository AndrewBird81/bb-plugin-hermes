import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { describe, expect, it } from "vitest";
import { decodeMarker, encodeMarker, MarkerError, segmentInput } from "./marker.js";

const text = (t: string): PromptInput => ({ type: "text", mentions: [], text: t });
const context = (t: string): PromptInput => ({ type: "text", mentions: [], text: t, visibility: "agent-only" });

describe("marker codec", () => {
  it("round-trips every op", () => {
    for (const m of [
      { op: "init", profile: "neo", bot: true },
      { op: "init", profile: "neo" },
      { op: "bind", profile_home: "/h/neo", lineage_root: "local-1", legacy: true, anchor_uid: "u1", since: 1_700_000_000_000 },
      { op: "replay", anchor_uid: "u2" },
      { op: "mirror", anchor_uid: "u3", rest: true },
    ] as const) {
      const part = encodeMarker(m);
      expect(part.visibility).toBe("agent-only");
      expect(part.text.startsWith("<hermes-bb>")).toBe(true);
      expect(decodeMarker(part.text)).toEqual(m);
    }
  });

  it("returns null for plain text and throws on a bad marker", () => {
    expect(decodeMarker("hello")).toBeNull();
    expect(() => decodeMarker("<hermes-bb>{nope</hermes-bb>")).toThrow(MarkerError);
    expect(() => decodeMarker('<hermes-bb>{"op":"mirror"}</hermes-bb>')).toThrow(MarkerError);
    expect(() => decodeMarker('<hermes-bb>{"op":"wipe","anchor_uid":"x"}</hermes-bb>')).toThrow(MarkerError);
    expect(() => decodeMarker('<hermes-bb>{"op":"replay","anchor_uid":"x","extra":1}</hermes-bb>')).toThrow(MarkerError);
  });

  it("refuses to encode an invalid marker", () => {
    expect(() => encodeMarker({ op: "replay", anchor_uid: "" })).toThrow();
  });
});

describe("segmentInput (R1 M6)", () => {
  const mirror = encodeMarker({ op: "mirror", anchor_uid: "a1" });

  it("plain text is one bb prompt", () => {
    expect(segmentInput([text("hi"), context("bb context")])).toEqual([{ kind: "prompt", parts: [text("hi"), context("bb context")] }]);
  });

  it("a tagged label belongs to its marker", () => {
    expect(segmentInput([text("[CLI] ls -la"), mirror])).toEqual([
      { kind: "marker", marker: { op: "mirror", anchor_uid: "a1" }, label: "[CLI] ls -la" },
    ]);
    expect(segmentInput([text("[Conduit · Oct 12] hey"), mirror])[0]).toMatchObject({ label: "[Conduit · Oct 12] hey" });
  });

  it("a hidden user row's wake has no label", () => {
    expect(segmentInput([mirror])).toEqual([{ kind: "marker", marker: { op: "mirror", anchor_uid: "a1" }, label: null }]);
  });

  it("merged [text, mirror, text] → 2 prompts + 1 marker, in order", () => {
    expect(segmentInput([text("first"), mirror, text("second")]).map((s) => s.kind)).toEqual(["prompt", "marker", "prompt"]);
  });

  it("a bb prompt queued before a wake is not swallowed as its label", () => {
    const segments = segmentInput([text("mine"), text("[TUI] theirs"), mirror, text("after")]);
    expect(segments).toEqual([
      { kind: "prompt", parts: [text("mine")] },
      { kind: "marker", marker: { op: "mirror", anchor_uid: "a1" }, label: "[TUI] theirs" },
      { kind: "prompt", parts: [text("after")] },
    ]);
  });

  it("a bad marker is its own segment and never part of a prompt", () => {
    expect(segmentInput([text("a"), context("<hermes-bb>{}</hermes-bb>"), text("b")]).map((s) => s.kind)).toEqual(["prompt", "invalid", "prompt"]);
  });
});

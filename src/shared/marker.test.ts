import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { describe, expect, it } from "vitest";
import { decodeMarker, encodeMarker, MarkerError, segmentInput, spawnStart } from "./marker.js";

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
      { op: "replay", anchor_uid: "u4", labeled: true },
    ] as const) {
      const part = encodeMarker(m);
      expect(part.visibility).toBe("agent-only");
      expect(part.text.startsWith("<hermes-bb>")).toBe(true);
      expect(decodeMarker(part.text)).toEqual(m);
    }
  });

  it("spawnStart is no marker and no text: bb's titleFallback (every text part, trimmed and joined) stays empty", () => {
    const part = spawnStart();
    expect(decodeMarker(part.text)).toBeNull();
    expect(segmentInput([part])).toEqual([{ kind: "prompt", parts: [part] }]);
    // bb-app 0.49.0 `cleanPromptText`, which `deriveTitleFallback` uses: "" → null fallback.
    expect([part].filter((p) => p.type === "text").map((p) => p.text.trim()).join(" ").trim()).toBe("");
  });

  it("returns null for plain text and throws on a bad marker", () => {
    expect(decodeMarker("hello")).toBeNull();
    expect(() => decodeMarker("<hermes-bb>{nope</hermes-bb>")).toThrow(MarkerError);
    expect(() => decodeMarker('<hermes-bb>{"op":"mirror"}</hermes-bb>')).toThrow(MarkerError);
    expect(() => decodeMarker('<hermes-bb>{"op":"wipe","anchor_uid":"x"}</hermes-bb>')).toThrow(MarkerError);
  });

  it("decodes a field a newer server adds (a bridge keeps old code after an update); encoding stays strict", () => {
    expect(decodeMarker('<hermes-bb>{"op":"replay","anchor_uid":"x","extra":1}</hermes-bb>')).toEqual({ op: "replay", anchor_uid: "x" });
    expect(() => encodeMarker({ op: "replay", anchor_uid: "x", extra: 1 } as never)).toThrow();
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

  const labeledMirror = encodeMarker({ op: "mirror", anchor_uid: "a1", labeled: true });

  it("a labeled marker takes the visible part right before it as its label", () => {
    expect(segmentInput([text("[Outside bb] ls -la"), labeledMirror])).toEqual([
      { kind: "marker", marker: { op: "mirror", anchor_uid: "a1", labeled: true }, label: "[Outside bb] ls -la" },
    ]);
    expect(segmentInput([text("[Outside bb · Oct 12] hey"), labeledMirror])[0]).toMatchObject({ label: "[Outside bb · Oct 12] hey" });
  });

  it("an unlabeled marker takes no label: the user's own text before it is a prompt, even tagged", () => {
    expect(segmentInput([text("[Outside bb] typed by me"), mirror]).map((s) => s.kind)).toEqual(["prompt", "marker"]);
  });

  it("a hidden user row's wake has no label", () => {
    expect(segmentInput([mirror])).toEqual([{ kind: "marker", marker: { op: "mirror", anchor_uid: "a1" }, label: null }]);
  });

  it("merged [text, mirror, text] → 2 prompts + 1 marker, in order", () => {
    expect(segmentInput([text("first"), mirror, text("second")]).map((s) => s.kind)).toEqual(["prompt", "marker", "prompt"]);
  });

  it("a bb prompt queued before a wake is not swallowed as its label", () => {
    const segments = segmentInput([text("mine"), text("[Outside bb] theirs"), labeledMirror, text("after")]);
    expect(segments).toEqual([
      { kind: "prompt", parts: [text("mine")] },
      { kind: "marker", marker: { op: "mirror", anchor_uid: "a1", labeled: true }, label: "[Outside bb] theirs" },
      { kind: "prompt", parts: [text("after")] },
    ]);
  });

  it("an untagged label (bb's own earlier message in an import) belongs to a labeled marker, never a prompt", () => {
    const replay = encodeMarker({ op: "replay", anchor_uid: "a2", labeled: true });
    expect(segmentInput([text("mine"), replay])).toEqual([{ kind: "marker", marker: { op: "replay", anchor_uid: "a2", labeled: true }, label: "mine" }]);
    const bind = encodeMarker({ op: "bind", profile_home: "/h", lineage_root: "r", legacy: false, anchor_uid: "a0", labeled: true });
    expect(segmentInput([text("first"), bind]).map((s) => s.kind)).toEqual(["marker"]);
    // Without `labeled`, an untagged part stays a bb prompt (a send queued before a hidden row's wake).
    expect(segmentInput([text("first"), encodeMarker({ op: "mirror", anchor_uid: "a1" })]).map((s) => s.kind)).toEqual(["prompt", "marker"]);
    // `labeled` with nothing visible before it labels nothing.
    expect(segmentInput([context("ctx"), replay])).toEqual([
      { kind: "prompt", parts: [context("ctx")] },
      { kind: "marker", marker: { op: "replay", anchor_uid: "a2", labeled: true }, label: null },
    ]);
  });

  it("a bad marker is its own segment, takes the visible text before it, and is never part of a prompt", () => {
    const segments = segmentInput([text("a"), context("<hermes-bb>{}</hermes-bb>"), text("b")]);
    expect(segments.map((s) => s.kind)).toEqual(["invalid", "prompt"]);
    expect(segments[0]).toMatchObject({ kind: "invalid", label: "a" });
  });
});

import { describe, expect, it } from "vitest";
import { keyCodeFor, parseKeyChord, parseKeySequence, parseTypeSegments } from "./dom-core.js";

/**
 * The keyboard engine is the part of dom-core that is pure enough to unit test
 * in Node: chord parsing, `<kbd>` markup splitting, and key→code mapping. The
 * DOM-dependent halves (typing, clicking) need a real page and are exercised
 * manually / in the extension e2e run.
 */
describe("parseKeyChord", () => {
  it("parses a bare named key", () => {
    expect(parseKeyChord("Enter")).toMatchObject({ key: "Enter", code: "Enter", ctrlKey: false, metaKey: false });
    expect(parseKeyChord("esc")).toMatchObject({ key: "Escape" });
    expect(parseKeyChord("space")).toMatchObject({ key: " ", code: "Space" });
    expect(parseKeyChord("down")).toMatchObject({ key: "ArrowDown" });
  });

  it("parses single characters", () => {
    expect(parseKeyChord("a")).toMatchObject({ key: "a", code: "KeyA" });
    expect(parseKeyChord("7")).toMatchObject({ key: "7", code: "Digit7" });
  });

  it("applies modifiers", () => {
    expect(parseKeyChord("Control+Shift+K")).toMatchObject({ key: "K", ctrlKey: true, shiftKey: true, metaKey: false });
    expect(parseKeyChord("Alt+Tab")).toMatchObject({ key: "Tab", altKey: true });
  });

  it("upper-cases a shifted letter", () => {
    expect(parseKeyChord("Shift+a")).toMatchObject({ key: "A", shiftKey: true });
  });

  it("treats Meta/Mod as platform aware and Cmd/Ctrl as literal", () => {
    expect(parseKeyChord("Meta+A", { mac: true })).toMatchObject({ metaKey: true, ctrlKey: false });
    expect(parseKeyChord("Meta+A", { mac: false })).toMatchObject({ metaKey: false, ctrlKey: true });
    expect(parseKeyChord("Mod+A", { mac: false })).toMatchObject({ ctrlKey: true });
    expect(parseKeyChord("Cmd+A", { mac: false })).toMatchObject({ metaKey: true, ctrlKey: false });
    expect(parseKeyChord("Ctrl+A", { mac: true })).toMatchObject({ ctrlKey: true, metaKey: false });
  });

  it("keeps a literal plus key", () => {
    expect(parseKeyChord("Shift++")).toMatchObject({ key: "+", shiftKey: true });
  });

  it("rejects unknown modifiers and empty input", () => {
    expect(() => parseKeyChord("Hyper+A")).toThrow(/Unknown modifier/);
    expect(() => parseKeyChord("  ")).toThrow(/Empty key chord/);
  });
});

describe("parseKeySequence", () => {
  it("splits a whitespace separated sequence", () => {
    const chords = parseKeySequence("Meta+A Backspace Enter", { mac: true });
    expect(chords.map((c) => c.key)).toEqual(["A", "Backspace", "Enter"]);
    expect(chords[0]!.metaKey).toBe(true);
  });

  it("accepts <kbd> markup", () => {
    expect(parseKeySequence("<kbd>Escape</kbd>").map((c) => c.key)).toEqual(["Escape"]);
  });

  it("rejects empty input", () => {
    expect(() => parseKeySequence("   ")).toThrow(/No keys given/);
  });
});

describe("parseTypeSegments", () => {
  it("returns a single text segment when there is no markup", () => {
    expect(parseTypeSegments("hello")).toEqual([{ kind: "text", value: "hello" }]);
  });

  it("splits embedded key presses", () => {
    expect(parseTypeSegments("jane <kbd>Tab</kbd>doe<kbd>Enter</kbd>")).toEqual([
      { kind: "text", value: "jane " },
      { kind: "keys", value: "Tab" },
      { kind: "text", value: "doe" },
      { kind: "keys", value: "Enter" },
    ]);
  });

  it("is case insensitive and drops empty markup", () => {
    expect(parseTypeSegments("a<KBD>Enter</KBD>b")).toEqual([
      { kind: "text", value: "a" },
      { kind: "keys", value: "Enter" },
      { kind: "text", value: "b" },
    ]);
    expect(parseTypeSegments("a<kbd></kbd>b")).toEqual([
      { kind: "text", value: "a" },
      { kind: "text", value: "b" },
    ]);
  });

  it("returns nothing for an empty string", () => {
    expect(parseTypeSegments("")).toEqual([]);
  });
});

describe("keyCodeFor", () => {
  it("maps letters, digits, punctuation and named keys", () => {
    expect(keyCodeFor("q")).toBe("KeyQ");
    expect(keyCodeFor("Q")).toBe("KeyQ");
    expect(keyCodeFor("3")).toBe("Digit3");
    expect(keyCodeFor(".")).toBe("Period");
    expect(keyCodeFor(" ")).toBe("Space");
    expect(keyCodeFor("ArrowUp")).toBe("ArrowUp");
    expect(keyCodeFor("f5")).toBe("F5");
  });
});

import { describe, expect, it } from "vitest";
import { safeSerialize, toLogString } from "./serialize.js";

describe("safeSerialize", () => {
  it("passes through primitives", () => {
    expect(safeSerialize(1)).toBe(1);
    expect(safeSerialize("x")).toBe("x");
    expect(safeSerialize(true)).toBe(true);
    expect(safeSerialize(null)).toBe(null);
    expect(safeSerialize(undefined)).toBe("undefined");
  });

  it("handles circular references", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const out = safeSerialize(a) as Record<string, unknown>;
    expect(out.name).toBe("a");
    expect(out.self).toBe("[Circular]");
  });

  it("stringifies functions and bigint", () => {
    expect(safeSerialize(function foo() {})).toBe("[Function foo]");
    expect(safeSerialize(10n)).toBe("10");
  });

  it("caps deep nesting", () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    const out = JSON.stringify(safeSerialize(deep));
    expect(out).toContain("[Object]");
  });

  it("truncates large arrays", () => {
    const out = safeSerialize(Array.from({ length: 250 }, (_, i) => i)) as unknown[];
    expect(out.length).toBe(101);
    expect(out[100]).toContain("more");
  });

  it("serializes Map and Set", () => {
    expect(safeSerialize(new Map([["k", "v"]]))).toEqual({ "[Map]": [["k", "v"]] });
    expect(safeSerialize(new Set([1, 2]))).toEqual({ "[Set]": [1, 2] });
  });

  it("toLogString joins to compact text", () => {
    expect(toLogString({ a: 1 })).toBe('{"a":1}');
    expect(toLogString("hi")).toBe("hi");
  });
});

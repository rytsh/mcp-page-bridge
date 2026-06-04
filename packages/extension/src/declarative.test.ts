import { describe, expect, it } from "vitest";
import { normalizeDeclarativeTools } from "./declarative.js";

describe("normalizeDeclarativeTools", () => {
  it("ignores non-objects", () => {
    expect(normalizeDeclarativeTools(undefined)).toEqual([]);
    expect(normalizeDeclarativeTools(null)).toEqual([]);
    expect(normalizeDeclarativeTools("x")).toEqual([]);
  });

  it("reads an object map of name -> handler", () => {
    const h = () => 1;
    const out = normalizeDeclarativeTools({ getCart: h });
    expect(out).toHaveLength(1);
    expect(out[0]!.def).toEqual({ name: "getCart" });
    expect(out[0]!.handler).toBe(h);
  });

  it("reads an object map of name -> { meta, handler }", () => {
    const h = () => 1;
    const out = normalizeDeclarativeTools({
      addItem: { description: "Add", inputSchema: { type: "object" }, handler: h },
    });
    expect(out[0]!.def).toMatchObject({ name: "addItem", description: "Add" });
    expect(out[0]!.handler).toBe(h);
  });

  it("reads an array of tool entries", () => {
    const h = () => 1;
    const out = normalizeDeclarativeTools([{ name: "a", handler: h }, { name: "b", handler: h }]);
    expect(out.map((t) => t.def.name)).toEqual(["a", "b"]);
  });

  it("skips entries without a name or handler", () => {
    const out = normalizeDeclarativeTools({
      ok: () => 1,
      bad: { description: "no handler" },
    });
    expect(out.map((t) => t.def.name)).toEqual(["ok"]);
  });
});

import { describe, expect, it } from "vitest";
import { MAX_TOOL_NAME_LEN, namespaceName } from "mcp-page-bridge-protocol";

/**
 * `namespaceName` exists twice: here and in internal/protocol/protocol.go. The
 * Go copy builds the bridge's routing table AND the catalog it advertises, so
 * the two must agree exactly or a tool becomes unroutable.
 *
 * The golden vectors below were produced by the Go implementation. Any drift in
 * either language fails here and in TestNamespaceNameGoldenVectors.
 */
const GOLDEN: Array<[label: string, name: string, want: string]> = [
  ["page", "eval", "page__eval"],
  ["page", "a".repeat(200), "page__aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-324a88"],
  [
    "checkout",
    "a".repeat(200) + "-alpha",
    "checkout__aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-974d86",
  ],
  [
    "checkout",
    "a".repeat(200) + "-beta",
    "checkout__aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-24e0f3",
  ],
  ["page", "ö".repeat(100), "page__ööööööööööööööööööööööööö-031816"],
  [
    "a-very-long-label-that-is-forty-chars-ok",
    "x".repeat(60),
    "a-very-long-label-that-is-forty-chars-ok__xxxxxxxxxxxxxxx-e3a151",
  ],
];

const utf8Len = (value: string): number => new TextEncoder().encode(value).length;

describe("namespaceName", () => {
  it("matches the Go implementation byte for byte", () => {
    for (const [label, name, want] of GOLDEN) {
      expect(namespaceName(label, name)).toBe(want);
    }
  });

  it("leaves names within the limit untouched", () => {
    const name = "a".repeat(MAX_TOOL_NAME_LEN - "page__".length);
    const got = namespaceName("page", name);
    expect(got).toBe(`page__${name}`);
    expect(utf8Len(got)).toBe(MAX_TOOL_NAME_LEN);
  });

  it("never exceeds the limit, in bytes", () => {
    for (const [label, name] of GOLDEN) {
      expect(utf8Len(namespaceName(label, name))).toBeLessThanOrEqual(MAX_TOOL_NAME_LEN);
    }
  });

  it("keeps distinct long names distinct", () => {
    const base = "a".repeat(200);
    expect(namespaceName("page", `${base}-alpha`)).not.toBe(namespaceName("page", `${base}-beta`));
  });

  it("is deterministic across calls", () => {
    const name = "b".repeat(150);
    expect(namespaceName("page", name)).toBe(namespaceName("page", name));
  });
});

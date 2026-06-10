import { describe, expect, it } from "vitest";
import {
  MAX_PROFILES,
  normalizeBridge,
  parseProfiles,
  profileLabel,
  sameBridge,
  sortProfiles,
  tabGroupColor,
  upsertProfile,
  type BridgeProfile,
} from "./bridge-profiles.js";

function profile(host: string, port: number, token = "", lastUsedAt = 0): BridgeProfile {
  return upsertProfile([], { host, port, token }, new Set(), lastUsedAt).profile;
}

describe("bridge profiles", () => {
  it("normalizes raw input to a canonical config", () => {
    expect(normalizeBridge({ host: "  10.0.0.5 ", port: 9000, token: " s " })).toEqual({ host: "10.0.0.5", port: 9000, token: "s", secure: false });
    expect(normalizeBridge({ host: "", port: Number.NaN, token: undefined })).toEqual({ host: "127.0.0.1", port: 8787, token: "", secure: false });
    expect(normalizeBridge(undefined)).toEqual({ host: "127.0.0.1", port: 8787, token: "", secure: false });
    expect(normalizeBridge({ port: 70000 }).port).toBe(8787);
    expect(normalizeBridge({ secure: true }).secure).toBe(true);
  });

  it("auto-groups: the same host/port/token reuses the existing profile", () => {
    const first = upsertProfile([], { host: "10.0.0.5", port: 8787, token: "t" }, new Set(), 100);
    const second = upsertProfile(first.profiles, { host: " 10.0.0.5 ", port: 8787, token: "t" }, new Set(), 200);
    expect(second.profiles).toHaveLength(1);
    expect(second.profile.id).toBe(first.profile.id);
    expect(second.profile.lastUsedAt).toBe(200);
  });

  it("a different token is a different group", () => {
    const first = upsertProfile([], { host: "10.0.0.5", port: 8787, token: "a" }, new Set(), 100);
    const second = upsertProfile(first.profiles, { host: "10.0.0.5", port: 8787, token: "b" }, new Set(), 200);
    expect(second.profiles).toHaveLength(2);
    expect(sameBridge(first.profile, second.profile)).toBe(false);
  });

  it("a different secure flag is a different group", () => {
    const plain = upsertProfile([], { host: "10.0.0.5", port: 8787, token: "a" }, new Set(), 100);
    const tls = upsertProfile(plain.profiles, { host: "10.0.0.5", port: 8787, token: "a", secure: true }, new Set(), 200);
    expect(tls.profiles).toHaveLength(2);
    expect(sameBridge(plain.profile, tls.profile)).toBe(false);
  });

  it("evicts least-recently-used profiles beyond the cap, sparing in-use ids", () => {
    let profiles: BridgeProfile[] = [];
    const ids: string[] = [];
    for (let i = 0; i < MAX_PROFILES; i += 1) {
      const result = upsertProfile(profiles, { host: "h", port: 1000 + i }, new Set(), i);
      profiles = result.profiles;
      ids.push(result.profile.id);
    }
    // Oldest (port 1000) would be evicted — unless it is in use.
    const inUse = new Set([ids[0]!]);
    const overflow = upsertProfile(profiles, { host: "h", port: 9999 }, inUse, 1000);
    expect(overflow.profiles).toHaveLength(MAX_PROFILES);
    expect(overflow.profiles.some((p) => p.id === ids[0])).toBe(true); // spared
    expect(overflow.profiles.some((p) => p.port === 1001)).toBe(false); // next-oldest evicted
    expect(overflow.profiles.some((p) => p.port === 9999)).toBe(true);
  });

  it("sorts most recently used first", () => {
    const a = profile("a", 1, "", 10);
    const b = profile("b", 2, "", 30);
    const c = profile("c", 3, "", 20);
    expect(sortProfiles([a, b, c]).map((p) => p.host)).toEqual(["b", "c", "a"]);
  });

  it("parses storage values defensively and dedupes triples", () => {
    expect(parseProfiles(undefined)).toEqual([]);
    expect(parseProfiles("garbage")).toEqual([]);
    const parsed = parseProfiles([
      { id: "x", host: "h", port: 1, token: "", lastUsedAt: 5 },
      { id: "y", host: "h", port: 1, token: "", lastUsedAt: 9 }, // duplicate triple
      { host: "no-id", port: 2 },
      { id: "z", host: "k", port: "not-a-port", lastUsedAt: "soon" },
    ]);
    expect(parsed.map((p) => p.id).sort()).toEqual(["x", "z"]);
    expect(parsed.find((p) => p.id === "z")?.port).toBe(8787);
  });

  it("derives stable labels and colors", () => {
    expect(profileLabel({ host: "10.0.0.5", port: 8788, token: "s", secure: false })).toBe("10.0.0.5:8788");
    expect(profileLabel({ host: "bridge.example.com", port: 443, token: "s", secure: true })).toBe("wss://bridge.example.com:443");
    const color = tabGroupColor("some-profile-id");
    expect(tabGroupColor("some-profile-id")).toBe(color); // deterministic
  });
});

/**
 * Bridge profiles: a profile is the identity of one bridge daemon —
 * (host, port, token, secure). Profiles are deduped on that tuple, so every
 * tab or settings save that points at the same daemon automatically lands in
 * the same profile ("group"). Pure module: no chrome.* access, unit-testable
 * in Node.
 */

export interface BridgeProfile {
  id: string;
  host: string;
  port: number;
  token: string;
  /** Connect with wss:// (the daemon serves TLS). */
  secure: boolean;
  /**
   * Per-user profile secret. It partitions the bridge: an agent only sees tabs
   * sharing the same profile. Sent raw on connect (like the token); the daemon
   * hashes it into the partition key. Empty = the default, unpartitioned bridge.
   */
  profileKey: string;
  lastUsedAt: number;
}

export interface BridgeConfig {
  host: string;
  port: number;
  token: string;
  /** Connect with wss:// (the daemon serves TLS). */
  secure: boolean;
  /** Per-user profile secret (plaintext); see BridgeProfile.profileKey. */
  profileKey: string;
}

export const MAX_PROFILES = 8;
export const FALLBACK_HOST = "127.0.0.1";
export const FALLBACK_PORT = 8787;

/** Clamp raw popup/storage input into a canonical bridge config. */
export function normalizeBridge(input: Partial<BridgeConfig> | undefined): BridgeConfig {
  const host = typeof input?.host === "string" && input.host.trim() ? input.host.trim() : FALLBACK_HOST;
  const rawPort = Number(input?.port);
  const port = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : FALLBACK_PORT;
  const token = typeof input?.token === "string" ? input.token.trim() : "";
  const secure = input?.secure === true;
  const profileKey = typeof input?.profileKey === "string" ? input.profileKey.trim() : "";
  return { host, port, token, secure, profileKey };
}

/** Two configs identify the same daemon + partition (and therefore group). */
export function sameBridge(a: BridgeConfig, b: BridgeConfig): boolean {
  return (
    a.host === b.host &&
    a.port === b.port &&
    a.token === b.token &&
    a.secure === b.secure &&
    a.profileKey === b.profileKey
  );
}

function newProfileId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `bp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface UpsertResult {
  profiles: BridgeProfile[];
  profile: BridgeProfile;
}

/**
 * Find-or-create the profile for a config (auto-grouping), bump its
 * lastUsedAt, and evict least-recently-used profiles beyond MAX_PROFILES —
 * never evicting ids in `inUse` (the default profile and any tab override).
 */
export function upsertProfile(
  profiles: BridgeProfile[],
  input: Partial<BridgeConfig> | undefined,
  inUse: Set<string> = new Set(),
  now: number = Date.now(),
): UpsertResult {
  const config = normalizeBridge(input);
  const existing = profiles.find((p) => sameBridge(p, config));

  let profile: BridgeProfile;
  let next: BridgeProfile[];
  if (existing) {
    profile = { ...existing, lastUsedAt: now };
    next = profiles.map((p) => (p.id === existing.id ? profile : p));
  } else {
    profile = { id: newProfileId(), ...config, lastUsedAt: now };
    next = [...profiles, profile];
  }

  if (next.length > MAX_PROFILES) {
    const keep = new Set(inUse);
    keep.add(profile.id);
    const evictable = next
      .filter((p) => !keep.has(p.id))
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const toEvict = new Set(evictable.slice(0, next.length - MAX_PROFILES).map((p) => p.id));
    next = next.filter((p) => !toEvict.has(p.id));
  }

  return { profiles: sortProfiles(next), profile };
}

/** Most recently used first — the order the popup dropdown shows. */
export function sortProfiles(profiles: BridgeProfile[]): BridgeProfile[] {
  return [...profiles].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/** Parse the storage value defensively (it may be missing or hand-edited). */
export function parseProfiles(value: unknown): BridgeProfile[] {
  if (!Array.isArray(value)) return [];
  const out: BridgeProfile[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<BridgeProfile>;
    if (typeof raw.id !== "string" || !raw.id) continue;
    const config = normalizeBridge(raw);
    if (out.some((p) => sameBridge(p, config))) continue; // keep the triple unique
    out.push({ id: raw.id, ...config, lastUsedAt: Number(raw.lastUsedAt) || 0 });
  }
  return sortProfiles(out);
}

/** Deterministic tab-group color per profile (chrome.tabGroups palette). */
export const TAB_GROUP_COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"] as const;

export function tabGroupColor(profileId: string): (typeof TAB_GROUP_COLORS)[number] {
  let hash = 0;
  for (const ch of profileId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return TAB_GROUP_COLORS[hash % TAB_GROUP_COLORS.length]!;
}

/** Short human label for a profile (popup dropdown / tab-group title). */
export function profileLabel(config: BridgeConfig): string {
  return `${config.secure ? "wss://" : ""}${config.host}:${config.port}`;
}

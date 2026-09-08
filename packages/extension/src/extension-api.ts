/** Firefox's chrome namespace is callback-based; use its native promise API. */
export function extensionApi(): typeof chrome {
  return (globalThis as typeof globalThis & { browser?: typeof chrome }).browser ?? globalThis.chrome;
}

export function supportsDebugger(): boolean {
  const api = extensionApi();
  // Chrome can hide optional APIs until permission is granted. Firefox never
  // implements debugger, and exposes getBrowserInfo independently of permissions.
  return !("getBrowserInfo" in api.runtime) || !!api.debugger;
}

export async function hasDebuggerPermission(): Promise<boolean> {
  const api = extensionApi();
  if (!supportsDebugger() || !api.debugger) return false;
  return api.permissions.contains({ permissions: ["debugger"] });
}

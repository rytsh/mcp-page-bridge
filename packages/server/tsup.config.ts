import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts", bridge: "src/bridge.ts" },
  format: ["esm"],
  target: "node18",
  dts: true,
  clean: true,
  // Bundle the workspace protocol package; keep heavy runtime deps external.
  noExternal: ["@mcp-page-bridge/protocol"],
  banner: { js: "#!/usr/bin/env node" },
});

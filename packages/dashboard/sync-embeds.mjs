#!/usr/bin/env node
// Copy the single-file dashboard build into the Go server's embed directory.
// The copy is committed so `go install .../cmd/mcp-page-bridge@latest` works
// from a clean checkout.
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "dist/index.html");

if (!existsSync(src)) {
  console.error(`missing ${src} — run \`vite build\` first`);
  process.exit(1);
}

const goDest = resolve(here, "../../internal/server/assets/dashboard.html");
copyFileSync(src, goDest);
console.log(`dashboard embed synced → ${goDest}`);

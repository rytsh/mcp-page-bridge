import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionDir = join(root, "packages", "extension");
const firefox = process.argv.includes("--firefox");
const distDir = join(extensionDir, firefox ? "dist-firefox" : "dist");
const manifestPath = join(extensionDir, "manifest.json");

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const zipPath = join(root, `mcp-page-bridge-extension${firefox ? "-firefox" : ""}-v${manifest.version}.zip`);

run("pnpm", ["--filter", "@mcp-page-bridge/extension", firefox ? "build:firefox" : "build"]);
await rm(zipPath, { force: true });
run("zip", ["-r", zipPath, "."], distDir);

console.log(`Packed extension: ${zipPath}`);

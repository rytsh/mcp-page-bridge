#!/usr/bin/env node
// Generate the per-platform npm packages (esbuild/turbo model) from the
// goreleaser binaries in dist/. The `mcp-page-bridge` wrapper package depends
// on these via optionalDependencies; npm installs only the one matching the
// host os/cpu.
//
// It also injects the matching optionalDependencies into
// packages/server/package.json. They are intentionally NOT committed: the
// platform packages only exist on npm once a release publishes them, so a
// committed reference would break `pnpm install --frozen-lockfile` in CI
// (chicken-and-egg). The release workflow runs this script right before
// publishing the wrapper, so the published package.json always carries them.
//
// Usage: node scripts/build-npm-packages.mjs   (after `goreleaser release/build`)
// Output: npm-dist/mcp-page-bridge-<os>-<arch>/ + mutated packages/server/package.json
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { version } = require(join(root, "packages/server/package.json"));

const distDir = join(root, "dist");
const outRoot = join(root, "npm-dist");

// goreleaser goos/goarch -> npm package metadata
const PLATFORMS = [
  { goos: "linux", goarch: "amd64", pkg: "mcp-page-bridge-linux-x64", os: "linux", cpu: "x64", bin: "mcp-page-bridge" },
  { goos: "linux", goarch: "arm64", pkg: "mcp-page-bridge-linux-arm64", os: "linux", cpu: "arm64", bin: "mcp-page-bridge" },
  { goos: "darwin", goarch: "amd64", pkg: "mcp-page-bridge-darwin-x64", os: "darwin", cpu: "x64", bin: "mcp-page-bridge" },
  { goos: "darwin", goarch: "arm64", pkg: "mcp-page-bridge-darwin-arm64", os: "darwin", cpu: "arm64", bin: "mcp-page-bridge" },
  { goos: "windows", goarch: "amd64", pkg: "mcp-page-bridge-windows-x64", os: "win32", cpu: "x64", bin: "mcp-page-bridge.exe" },
];

// Locate the raw (pre-archive) binaries via goreleaser's artifact manifest, so
// this script is independent of archive naming.
const manifestPath = join(distDir, "artifacts.json");
if (!existsSync(manifestPath)) {
  console.error(`missing ${manifestPath} — run goreleaser first`);
  process.exit(1);
}
const artifacts = JSON.parse(readFileSync(manifestPath, "utf8"));
const binaries = artifacts.filter((a) => a.type === "Binary");

function binaryFor(platform) {
  const found = binaries.find((a) => a.goos === platform.goos && a.goarch === platform.goarch);
  if (!found) {
    console.error(`no goreleaser binary for ${platform.goos}/${platform.goarch} in artifacts.json`);
    process.exit(1);
  }
  // goreleaser records paths relative to the project root.
  return resolve(root, found.path);
}

rmSync(outRoot, { recursive: true, force: true });

for (const platform of PLATFORMS) {
  const pkgDir = join(outRoot, platform.pkg);
  mkdirSync(join(pkgDir, "bin"), { recursive: true });

  const binPath = join(pkgDir, "bin", platform.bin);
  copyFileSync(binaryFor(platform), binPath);
  chmodSync(binPath, 0o755);

  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: platform.pkg,
        version,
        description: `mcp-page-bridge binary for ${platform.os}-${platform.cpu}`,
        license: "MIT",
        author: "Eray Ates",
        repository: { type: "git", url: "git+https://github.com/rytsh/mcp-page-bridge.git" },
        os: [platform.os],
        cpu: [platform.cpu],
        files: ["bin"],
        publishConfig: { access: "public" },
      },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(
    join(pkgDir, "README.md"),
    `# ${platform.pkg}\n\nPlatform binary for [mcp-page-bridge](https://github.com/rytsh/mcp-page-bridge). Do not install directly — install \`mcp-page-bridge\` instead.\n`,
  );

  console.log(`packaged ${platform.pkg}@${version}`);
}

// Inject optionalDependencies into the wrapper package for publishing (see
// header comment for why these are not committed).
const wrapperPath = join(root, "packages/server/package.json");
const wrapper = JSON.parse(readFileSync(wrapperPath, "utf8"));
wrapper.optionalDependencies = Object.fromEntries(PLATFORMS.map((p) => [p.pkg, version]));
writeFileSync(wrapperPath, JSON.stringify(wrapper, null, 2) + "\n");
console.log(`injected optionalDependencies@${version} into packages/server/package.json`);

console.log(`done → ${outRoot}`);

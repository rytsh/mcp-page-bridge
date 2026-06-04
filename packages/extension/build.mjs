import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const ASSETS = "../../assets";
const ICONS = [
  ["favicon-16x16.png", "16.png"],
  ["favicon-32x32.png", "32.png"],
  ["favicon-48x48.png", "48.png"],
  ["favicon-128x128.png", "128.png"],
  ["favicon.svg", "icon.svg"],
];

const watch = process.argv.includes("--watch");
const outdir = "dist";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  format: "iife",
  target: ["chrome116"],
  sourcemap: true,
  logLevel: "info",
};

const entries = {
  background: "src/background.ts",
  content: "src/content.ts",
  inject: "src/inject.ts",
  popup: "src/popup.ts",
};

async function copyStatic() {
  await cp("manifest.json", `${outdir}/manifest.json`);
  await cp("src/popup.html", `${outdir}/popup.html`);
  await mkdir(`${outdir}/icons`, { recursive: true });
  for (const [src, dest] of ICONS) {
    await cp(`${ASSETS}/${src}`, `${outdir}/icons/${dest}`);
  }
}

if (watch) {
  const ctxs = await Promise.all(
    Object.entries(entries).map(([name, entry]) =>
      esbuild.context({ ...common, entryPoints: { [name]: entry }, outdir }),
    ),
  );
  await Promise.all(ctxs.map((c) => c.watch()));
  await copyStatic();
  console.log(`[mcp-page-bridge/extension] watching → ${outdir}/`);
} else {
  await Promise.all(
    Object.entries(entries).map(([name, entry]) =>
      esbuild.build({ ...common, entryPoints: { [name]: entry }, outdir }),
    ),
  );
  await copyStatic();
  console.log(`[mcp-page-bridge/extension] built → ${outdir}/`);
}

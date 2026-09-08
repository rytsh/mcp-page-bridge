import * as esbuild from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const ASSETS = "../../assets";
const ICONS = [
  ["favicon-16x16.png", "16.png"],
  ["favicon-32x32.png", "32.png"],
  ["favicon-48x48.png", "48.png"],
  ["favicon-128x128.png", "128.png"],
  ["favicon.svg", "icon.svg"],
];

const watch = process.argv.includes("--watch");
const firefox = process.argv.includes("--firefox");
const outdir = firefox ? "dist-firefox" : "dist";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  format: "iife",
  target: [firefox ? "firefox140" : "chrome116"],
  sourcemap: true,
  logLevel: "info",
};

const entries = {
  background: "src/background.ts",
  content: "src/content.ts",
  inject: "src/inject.ts",
  popup: "src/popup.ts",
  // Injected on demand into every frame of a tab (cross-frame snapshot/actions).
  "frame-agent": "src/frame-agent.ts",
};

async function copyStatic() {
  const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
  if (firefox) {
    delete manifest.minimum_chrome_version;
    delete manifest.optional_permissions;
    manifest.background = { scripts: ["background.js"] };
    // Firefox's default MV3 CSP upgrades ws:// to wss://, breaking local bridges.
    manifest.content_security_policy = {
      extension_pages: "script-src 'self'; object-src 'self'",
    };
    manifest.browser_specific_settings = {
      gecko: {
        id: "mcp-page-bridge@rytsh",
        strict_min_version: "140.0",
        data_collection_permissions: {
          required: ["websiteContent", "browsingActivity"],
        },
      },
      gecko_android: {
        strict_min_version: "142.0",
      },
    };
  }
  await writeFile(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
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

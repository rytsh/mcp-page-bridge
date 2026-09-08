import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const extensionDir = new URL("../", import.meta.url);
const run = promisify(execFile);

it("builds Firefox with a local-WebSocket-safe CSP without changing Chrome's manifest", async () => {
  const source = JSON.parse(await readFile(new URL("manifest.json", extensionDir), "utf8"));
  for (const firefox of [true, false]) {
    await run(process.execPath, ["build.mjs", ...(firefox ? ["--firefox"] : [])], {
      cwd: fileURLToPath(extensionDir),
      timeout: 30_000,
    });
    const output = firefox ? "dist-firefox" : "dist";
    const manifest = JSON.parse(await readFile(new URL(`${output}/manifest.json`, extensionDir), "utf8"));
    if (firefox) {
      expect(manifest.content_security_policy).toEqual({
        extension_pages: "script-src 'self'; object-src 'self'",
      });
      expect(manifest.background).toEqual({ scripts: ["background.js"] });
      expect(manifest.browser_specific_settings.gecko.data_collection_permissions).toEqual({
        required: ["websiteContent", "browsingActivity"],
      });
    } else {
      expect(manifest).toEqual(source);
    }
  }
}, 60_000);

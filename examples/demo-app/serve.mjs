// Minimal dependency-free static server for the demo app.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 3000;

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  const rel = url === "/" ? "index.html" : normalize(url).replace(/^(\.\.[/\\])+/, "");
  try {
    const file = join(root, rel);
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, () => {
  console.log(`demo app: http://localhost:${port}`);
});

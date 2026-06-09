import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { viteSingleFile } from "vite-plugin-singlefile";

// The dashboard is served by the bridge as ONE embedded HTML document (no
// asset routes, no caching concerns), so everything is inlined.
export default defineConfig({
  plugins: [svelte(), viteSingleFile()],
  build: {
    target: "es2022",
    cssMinify: true,
  },
});

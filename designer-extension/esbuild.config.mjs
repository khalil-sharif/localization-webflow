// Bundles the App Panel (vanilla TypeScript) into designer-extension/panel.js.
// Run with: npm run build:panel
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, "panel.ts")],
  outfile: path.join(here, "panel.js"),
  bundle: true,
  format: "iife",
  target: "es2020",
  platform: "browser",
  sourcemap: true,
  minify: false,
  logLevel: "info",
});

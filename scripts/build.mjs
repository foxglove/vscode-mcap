import { build } from "esbuild";
import { writeNotices } from "./notices.mjs";
import { copyFile } from "node:fs/promises";
const extension = await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  loader: { ".wasm": "file", ".html": "text", ".css": "text" },
  assetNames: "[name]",
  outfile: "dist/extension.js",
  sourcemap: true,
  metafile: true,
});
const webview = await build({
  entryPoints: ["webview/main.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  outfile: "dist/webview.js",
  sourcemap: true,
  metafile: true,
});

for (const [source, name] of [
  ["@foxglove/wasm-zstd/dist/wasm-zstd.wasm", "wasm-zstd.wasm"],
  ["@foxglove/wasm-lz4/dist/wasm-lz4.wasm", "wasm-lz4.wasm"],
  ["@foxglove/wasm-bz2/wasm/module.wasm", "module.wasm"],
])
  await copyFile(`node_modules/${source}`, `dist/${name}`);

await writeNotices([extension.metafile, webview.metafile]);

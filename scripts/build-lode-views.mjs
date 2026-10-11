#!/usr/bin/env node
// Bundles lode's views (the <lode-flow> canvas, its connection and typed
// API: `lode-graph/views`) into one ES module the renderer can import without a
// build step of its own: src/shared/vendor/lode-views.mjs. The output is
// committed, like CodeMirror's. Rerun after updating lode-graph (see
// src/main/lode.ts for the other half, which runs lode in Node).

import { build } from "esbuild";

const ROOT = new URL("..", import.meta.url).pathname;

await build({
  entryPoints: ["lode-graph/views"],
  absWorkingDir: ROOT,
  outfile: `${ROOT}src/shared/vendor/lode-views.mjs`,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome130",
  minify: true,
  legalComments: "eof",
  banner: {
    js: "// lode views (lode-graph, MIT, github.com/damiensmith1/lode-graph), bundled by scripts/build-lode-views.mjs. Do not edit.",
  },
});
console.log("wrote src/shared/vendor/lode-views.mjs");

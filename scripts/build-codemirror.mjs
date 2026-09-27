#!/usr/bin/env node
// Bundles scripts/codemirror/entry.mjs into one ES module the renderer can
// import without a build step of its own: src/shared/vendor/codemirror.mjs.
// The output is committed, like the Preact + htm standalone module. Rerun
// after changing the entry or the pinned @codemirror/* versions.

import { build } from "esbuild";

const ROOT = new URL("..", import.meta.url).pathname;

await build({
  entryPoints: [`${ROOT}scripts/codemirror/entry.mjs`],
  outfile: `${ROOT}src/shared/vendor/codemirror.mjs`,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome130",
  minify: true,
  legalComments: "eof",
  banner: {
    js: "// CodeMirror 6 and language packages (MIT), bundled by scripts/build-codemirror.mjs. Do not edit.",
  },
});
console.log("wrote src/shared/vendor/codemirror.mjs");

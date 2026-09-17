#!/usr/bin/env node
// Flags design drift in the renderer code: colours, font sizes or weights written as
// literals instead of the custom properties in src/shared/theme.css.
// See docs/design.md, "Visual design". Exits 1 when anything is found.
//
// The xterm.js terminal options are the one allowed exception — xterm can't
// read CSS variables — so a `new window.Terminal({ … })` literal is skipped.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN_DIRS = ["src/mainWindow", "src/popup", "src/dictationHud", "src/shared"];
const SKIP = [/^src\/shared\/vendor\//, /^src\/shared\/theme\.css$/, /^src\/shared\/fonts\//, /^src\/shared\/brand\//];
const EXTENSIONS = /\.(html|css|js)$/;

const RULES = [
  { name: "literal colour", pattern: /#[0-9a-fA-F]{3,8}\b|\brgba?\(/g },
  { name: "literal font size", pattern: /font-size:\s*[0-9.]+px|fontSize:\s*["']?[0-9.]+/g },
  { name: "literal font weight", pattern: /font-weight:\s*[0-9]+/g },
];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// Line ranges covered by xterm `new window.Terminal({ … })` option literals.
function terminalOptionLines(lines) {
  const skipped = new Set();
  let depth = 0;
  lines.forEach((line, index) => {
    if (depth === 0 && /new window\.Terminal\(\{/.test(line)) depth = 1;
    else if (depth > 0) depth += (line.match(/\{/g) ?? []).length;
    if (depth > 0) {
      skipped.add(index);
      depth -= (line.match(/\}/g) ?? []).length;
    }
  });
  return skipped;
}

const problems = [];
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const path = relative(ROOT, file);
    if (!EXTENSIONS.test(path) || SKIP.some((pattern) => pattern.test(path))) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    const skipped = terminalOptionLines(lines);
    lines.forEach((line, index) => {
      if (skipped.has(index)) return;
      // HTML entities (&#39;) and URL fragments aren't colours.
      const code = line.replace(/&#\d+;/g, "").replace(/href="#[^"]*"/g, "");
      for (const rule of RULES) {
        for (const match of code.matchAll(rule.pattern)) {
          problems.push(`${path}:${index + 1}  ${rule.name}: ${match[0]}`);
        }
      }
    });
  }
}

if (problems.length > 0) {
  console.error(`Design check: ${problems.length} literal value(s) outside theme.css\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("\nUse a custom property from src/shared/theme.css instead (docs/design.md, \"Visual design\").");
  process.exit(1);
}
console.log("Design check: no literal colours, font sizes or weights outside theme.css.");

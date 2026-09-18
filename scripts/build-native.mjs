#!/usr/bin/env node
// Builds the accessibility addon (native/ax) against Electron's headers, not
// Node's — the two have different ABIs and the addon is loaded by Electron.
// Runs as part of `npm run build`, so dev, package and dist all get it
// without anyone having to remember a second command.
//
// Skipped when the existing binary is newer than its sources and was built
// for the Electron currently installed: `node-gyp rebuild` is a clean build
// (several seconds), and `npm run build` runs on every dev iteration.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADDON_DIR = join(ROOT, "native", "ax");
const BINARY = join(ADDON_DIR, "build", "Release", "ax.node");
// What the binary was last built against, so an Electron bump rebuilds it
// rather than leaving a module that fails to load with a version error.
const STAMP = join(ADDON_DIR, "build", "electron-version");
const SOURCES = [join(ADDON_DIR, "ax.mm"), join(ADDON_DIR, "binding.gyp")];

function electronVersion() {
  return JSON.parse(readFileSync(join(ROOT, "node_modules", "electron", "package.json"), "utf8")).version;
}

function isUpToDate(version) {
  if (!existsSync(BINARY) || !existsSync(STAMP)) return false;
  if (readFileSync(STAMP, "utf8").trim() !== version) return false;
  const builtAt = statSync(BINARY).mtimeMs;
  return SOURCES.every((source) => statSync(source).mtimeMs <= builtAt);
}

const version = electronVersion();
if (isUpToDate(version)) {
  console.log(`native/ax: up to date (Electron ${version})`);
  process.exit(0);
}

console.log(`native/ax: building against Electron ${version}…`);
try {
  execFileSync(
    process.execPath,
    [
      join(ROOT, "node_modules", "node-gyp", "bin", "node-gyp.js"),
      "rebuild",
      `--target=${version}`,
      "--arch=arm64",
      "--dist-url=https://electronjs.org/headers",
    ],
    { cwd: ADDON_DIR, stdio: ["ignore", "pipe", "inherit"] }
  );
  writeFileSync(STAMP, version, "utf8");
  console.log("native/ax: built");
} catch (error) {
  // Not fatal: the app runs without the addon, with the accessibility tools
  // reporting themselves unavailable (see src/main/ax.ts). Failing the whole
  // build over a toolchain that isn't set up would be worse than shipping
  // the rest of it.
  console.error("native/ax: build failed — accessibility tools will be unavailable");
  console.error(String(error.message ?? error).split("\n").slice(0, 3).join("\n"));
}

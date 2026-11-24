#!/usr/bin/env node
// Builds the whisper-cli that ships inside Clance.app (Contents/Resources/
// whisper/whisper-cli), so installing Clance doesn't install whisper.cpp
// through Homebrew. Homebrew only publishes prebuilt whisper.cpp for recent
// macOS releases; everywhere else it compiled whisper.cpp, llama.cpp, ggml,
// OpenSSL and SDL from source, which took hours. See docs/design.md's
// "Dictation" → "Engine".
//
// One self-contained arm64 binary: ggml linked in statically, the Metal
// shaders embedded (compiled by macOS on first use, then cached), OpenMP and
// BLAS off, and the CPU code built for every Apple Silicon chip rather than
// this Mac's. It links
// only system libraries and frameworks, which the build checks.
//
// Run by `npm run package`, `npm run dist` and scripts/release.sh, and
// skipped when the binary is already built from the pinned version. It needs
// cmake (`brew install cmake`); `npm run build` doesn't call it, so the dev
// loop doesn't need cmake — in dev, Clance falls back to a Homebrew
// whisper-cli if there is one.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The whisper.cpp release built, and its source tarball's sha256 (the same one Homebrew's formula pins). */
const VERSION = "1.9.6";
const SHA256 = "7ab15dc88022d2425ad94dcffd8abbf1b6d7018089b4e48d6b40780738e0b445";
const URL = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${VERSION}.tar.gz`;

/** Clance's own floor (the cask's `depends_on macos: :ventura`). */
const DEPLOYMENT_TARGET = "13.0";
/** What every Apple Silicon chip from the M1 on supports. */
const CPU_ARCH = "armv8.4-a+fp16+dotprod";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "native", "whisper", "build");
const BINARY = join(OUT, "whisper-cli");
const LICENSE = join(OUT, "LICENSE");
const STAMP = join(OUT, "version");
const SRC = join(OUT, "src");
const CMAKE_BUILD = join(OUT, "cmake");

/** What a self-contained binary may link: the system's libraries and frameworks only. */
const ALLOWED_LINKS = /^(\/usr\/lib\/|\/System\/Library\/)/;

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function capture(command, args) {
  return execFileSync(command, args, { encoding: "utf8" });
}

const stamp = `${VERSION} ${CPU_ARCH} ${DEPLOYMENT_TARGET} no-blas`;
if (existsSync(BINARY) && existsSync(STAMP) && readFileSync(STAMP, "utf8").trim() === stamp) {
  console.log(`whisper-cli: up to date (whisper.cpp ${VERSION})`);
  process.exit(0);
}

try {
  capture("cmake", ["--version"]);
} catch {
  console.error("whisper-cli: cmake is needed to build the bundled speech engine. Install it with: brew install cmake");
  process.exit(1);
}

console.log(`whisper-cli: building whisper.cpp ${VERSION}…`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(SRC, { recursive: true });

// The source, checked against the pinned hash before anything in it runs.
const tarball = join(OUT, "source.tar.gz");
run("curl", ["--fail", "--location", "--silent", "--show-error", "--output", tarball, URL]);
const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
if (actual !== SHA256) {
  console.error(`whisper-cli: the downloaded source's sha256 is ${actual}, not the pinned ${SHA256}`);
  process.exit(1);
}
run("tar", ["-xzf", tarball, "-C", SRC, "--strip-components", "1"]);

run("cmake", [
  "-S", SRC,
  "-B", CMAKE_BUILD,
  "-DCMAKE_BUILD_TYPE=Release",
  "-DCMAKE_OSX_ARCHITECTURES=arm64",
  `-DCMAKE_OSX_DEPLOYMENT_TARGET=${DEPLOYMENT_TARGET}`,
  "-DBUILD_SHARED_LIBS=OFF",
  "-DGGML_NATIVE=OFF",
  `-DGGML_CPU_ARM_ARCH=${CPU_ARCH}`,
  "-DGGML_METAL=ON",
  "-DGGML_METAL_EMBED_LIBRARY=ON",
  // Accelerate's BLAS: no faster with Metal doing the work (measured), and
  // the routine ggml calls exists only from macOS 13.3.
  "-DGGML_BLAS=OFF",
  "-DGGML_OPENMP=OFF",
  "-DWHISPER_BUILD_EXAMPLES=ON",
  "-DWHISPER_BUILD_TESTS=OFF",
  "-DWHISPER_BUILD_SERVER=OFF",
  "-DWHISPER_SDL2=OFF",
  "-DWHISPER_CURL=OFF",
]);
run("cmake", ["--build", CMAKE_BUILD, "--config", "Release", "--target", "whisper-cli", "-j", "4"]);

copyFileSync(join(CMAKE_BUILD, "bin", "whisper-cli"), BINARY);
// whisper.cpp is MIT-licensed, which asks for its notice to travel with it.
copyFileSync(join(SRC, "LICENSE"), LICENSE);
run("strip", ["-x", BINARY]);

// Self-contained, or it isn't shipped: a link to anything outside the system
// (a Homebrew libomp, a ggml dylib) would work here and fail on every other Mac.
const links = capture("otool", ["-L", BINARY])
  .split("\n")
  .slice(1)
  .map((line) => line.trim().split(" ")[0])
  .filter(Boolean);
const foreign = links.filter((link) => !ALLOWED_LINKS.test(link));
if (foreign.length) {
  console.error(`whisper-cli: links libraries that won't exist on other Macs:\n  ${foreign.join("\n  ")}`);
  process.exit(1);
}

// And it runs.
capture(BINARY, ["--help"]);

writeFileSync(STAMP, stamp, "utf8");
rmSync(SRC, { recursive: true, force: true });
rmSync(CMAKE_BUILD, { recursive: true, force: true });
rmSync(tarball, { force: true });
console.log(`whisper-cli: built (${links.length} system libraries)`);

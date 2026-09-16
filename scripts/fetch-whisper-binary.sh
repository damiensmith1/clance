#!/bin/sh
# Builds a self-contained `whisper-cli` into vendor/whisper/ for packaging
# (see package.json's build.extraResources). Run before `npm run dist`.
#
# Built from source rather than copied from Homebrew deliberately: the
# Homebrew binary links shared ggml/llama.cpp dylibs out of /opt/homebrew,
# so shipping it would produce an app that only runs on machines that
# happen to have Homebrew and those exact formulae installed. A static
# build has no such dependency.
#
# Requires cmake (`brew install cmake`) and the Xcode command line tools.
set -eu

VERSION="${WHISPER_VERSION:-v1.9.4}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/vendor/whisper"
WORK_DIR="${TMPDIR:-/tmp}/clance-whisper-build"

if [ -x "$OUT_DIR/whisper-cli" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "whisper-cli already present at $OUT_DIR — set FORCE=1 to rebuild."
  exit 0
fi

command -v cmake >/dev/null 2>&1 || {
  echo "error: cmake not found. Install it with: brew install cmake" >&2
  exit 1
}

echo "==> Fetching whisper.cpp $VERSION"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
git clone --depth 1 --branch "$VERSION" https://github.com/ggml-org/whisper.cpp "$WORK_DIR/src"

echo "==> Building (Metal, static libs)"
cmake -S "$WORK_DIR/src" -B "$WORK_DIR/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DGGML_ACCELERATE=ON
cmake --build "$WORK_DIR/build" --config Release --target whisper-cli -j"$(sysctl -n hw.ncpu)"

BINARY="$(find "$WORK_DIR/build" -name whisper-cli -type f -perm -111 | head -1)"
[ -n "$BINARY" ] || { echo "error: build produced no whisper-cli binary" >&2; exit 1; }

mkdir -p "$OUT_DIR"
cp "$BINARY" "$OUT_DIR/whisper-cli"
chmod +x "$OUT_DIR/whisper-cli"

# GGML_METAL_EMBED_LIBRARY bakes the Metal shaders into the binary, so
# there's no .metallib to ship alongside it. Any remaining non-system
# dynamic dependency would mean the static build didn't take — worth
# surfacing here rather than discovering it on a machine without Homebrew.
echo "==> Installed $OUT_DIR/whisper-cli"
echo "==> Linked libraries (expect only /usr/lib and /System frameworks):"
otool -L "$OUT_DIR/whisper-cli" | tail -n +2 | awk '{print "    " $1}'

if otool -L "$OUT_DIR/whisper-cli" | tail -n +2 | grep -q "/opt/homebrew\|/usr/local/lib"; then
  echo "warning: binary links Homebrew libraries and will not run on a clean Mac." >&2
  exit 1
fi

rm -rf "$WORK_DIR"
echo "==> Done."

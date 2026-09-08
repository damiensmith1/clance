#!/bin/sh
# Relaunches the signed Clance.app with the latest dist/ build, without
# going through electron-builder's full pipeline (Electron re-download,
# native module rebuild) on every iteration. Falls back to `npm run
# package` once if the app hasn't been built yet.
#
# Installs to /Applications rather than running in place from release/ —
# macOS's TCC permission list (Screen Recording, etc.) is unreliable for
# app bundles living in an arbitrary dev folder, especially one rebuilt
# repeatedly at the same path; a normal /Applications install is what
# actually got Clance to show up there and stay toggleable.
set -e

BUILT_APP="release/mac-arm64/Clance.app"
INSTALLED_APP="/Applications/Clance.app"

if [ ! -d "$BUILT_APP" ]; then
  echo "No packaged app found at $BUILT_APP — running npm run package once to create it."
  npm run package
fi

rsync -a --delete dist/ "$BUILT_APP/Contents/Resources/app/dist/"

IDENTITY=$(codesign -dvvv "$BUILT_APP" 2>&1 | sed -n 's/^Authority=//p' | head -1)
if [ -z "$IDENTITY" ]; then
  echo "Could not determine the app's existing signing identity — re-run npm run package."
  exit 1
fi

# No --options runtime here: hardened runtime requires an entitlements
# file (JIT, unsigned executable memory, disabled library validation for
# unsigned native .node addons like node-pty) that electron-builder embeds
# automatically but a bare resign doesn't — without it the app crashes on
# launch with EXC_BREAKPOINT/SIGTRAP. Not needed for local, unnotarized use
# anyway; only matters for real distribution.
codesign --force --deep --sign "$IDENTITY" "$BUILT_APP"

pkill -f "$INSTALLED_APP/Contents/MacOS/Clance" 2>/dev/null || true
rm -rf "$INSTALLED_APP"
cp -R "$BUILT_APP" "$INSTALLED_APP"

open "$INSTALLED_APP"

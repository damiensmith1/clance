#!/bin/sh
# Relaunches the packaged Clance.app with the latest dist/ build, without
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

# Signed with Clance's self-signed certificate when it's set up (sh
# scripts/create-signing-cert.sh), so macOS keeps Accessibility and Screen
# Recording across rebuilds. It used to copy whatever identity the build
# already carried, which meant silently re-signing with any Developer ID that
# happened to be installed; Clance is never signed with a certificate
# belonging to an organisation. Without the certificate this falls back to
# ad-hoc, which works but resets those permissions on every rebuild.
#
# No --options runtime here: hardened runtime requires an entitlements
# file (JIT, unsigned executable memory, disabled library validation for
# unsigned native .node addons like node-pty) that electron-builder embeds
# automatically but a bare resign doesn't — without it the app crashes on
# launch with EXC_BREAKPOINT/SIGTRAP.
SIGN_IDENTITY="Clance Code Signing"
if security find-identity -v -p codesigning | grep -q "\"$SIGN_IDENTITY\""; then
  codesign --force --deep --sign "$SIGN_IDENTITY" "$BUILT_APP"
else
  echo "warning: '$SIGN_IDENTITY' not set up — signing ad-hoc, so macOS will forget"
  echo "         Accessibility / Screen Recording for this build. Fix once with:"
  echo "         sh scripts/create-signing-cert.sh"
  codesign --force --deep --sign - "$BUILT_APP"
fi

pkill -f "$INSTALLED_APP/Contents/MacOS/Clance" 2>/dev/null || true
rm -rf "$INSTALLED_APP"
cp -R "$BUILT_APP" "$INSTALLED_APP"

open "$INSTALLED_APP"

#!/bin/sh
# Builds a release zip and points the Homebrew cask at it.
#
#   sh scripts/release.sh
#
# Produces release/Clance-<version>-arm64.zip, then rewrites the version
# and sha256 in packaging/homebrew/clance.rb to match. It does NOT publish:
# uploading the zip to a GitHub Release and pushing the cask to the tap are
# printed as next steps, since both are public and hard to take back.
#
# Signing uses Clance's self-signed certificate, "Clance Code Signing"
# (one-time setup: sh scripts/create-signing-cert.sh). macOS remembers
# permissions by signing identity, and this certificate's identity is the
# same for every release, so users keep Accessibility / Screen Recording /
# Microphone across `brew upgrade`.
#
# If the certificate is missing this stops rather than quietly signing
# ad-hoc: an ad-hoc identity is a hash of the app's contents, so every
# release would silently reset every user's permissions. To build ad-hoc
# anyway, say so explicitly: CLANCE_SIGN_IDENTITY=- sh scripts/release.sh
#
# Never sign with a certificate belonging to an organisation.
#
# Hardened runtime stays off. Neither ad-hoc nor self-signed signatures carry
# a team identifier, so library validation can't match the native addons
# (node-pty, nut-js) and the app wouldn't launch; it's only required for
# notarization, which Clance doesn't do.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
IDENTITY="${CLANCE_SIGN_IDENTITY:-Clance Code Signing}"
ZIP="release/Clance-${VERSION}-arm64.zip"
CASK="packaging/homebrew/clance.rb"

echo "==> Clance ${VERSION}, signing identity: ${IDENTITY}"

if [ "$IDENTITY" != "-" ] && ! security find-identity -v -p codesigning | grep -q "\"$IDENTITY\""; then
  echo "error: '$IDENTITY' isn't a valid code-signing identity on this Mac." >&2
  echo "Run the one-time setup first: sh scripts/create-signing-cert.sh" >&2
  echo "(Signing ad-hoc instead would reset every user's permissions on upgrade;" >&2
  echo " if you really mean to, run with CLANCE_SIGN_IDENTITY=-)" >&2
  exit 1
fi

HARDENED="false"

rm -f "$ZIP"
npm run build
# Zip only: the cask installs from a zip, and skipping the dmg keeps release
# builds fast. artifactName is pinned so the cask's URL is predictable.
npx electron-builder --mac zip --arm64 \
  -c.mac.identity="$IDENTITY" \
  -c.mac.hardenedRuntime="$HARDENED" \
  -c.mac.artifactName='Clance-${version}-arm64.${ext}'

[ -f "$ZIP" ] || { echo "error: expected $ZIP was not produced" >&2; exit 1; }

SHA="$(shasum -a 256 "$ZIP" | awk '{print $1}')"

# Rewrite only the version and sha256 lines, leaving the rest of the cask
# exactly as written.
sed -i '' -E \
  -e "s/^  version \"[^\"]*\"/  version \"${VERSION}\"/" \
  -e "s/^  sha256 \"[^\"]*\"/  sha256 \"${SHA}\"/" \
  "$CASK"

echo
echo "==> Built   $ZIP"
echo "==> sha256  $SHA"
echo "==> Updated $CASK"
echo
echo "Next, to publish (both are public):"
echo "  gh release create v${VERSION} \"$ZIP\" --title \"Clance ${VERSION}\" --notes \"\""
echo "  cp $CASK <your homebrew-tap checkout>/Casks/clance.rb   # then commit and push"

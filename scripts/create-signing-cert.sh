#!/bin/sh
# One-time setup: creates Clance's self-signed code-signing certificate in
# your login keychain and trusts it for code signing.
#
#   sh scripts/create-signing-cert.sh
#
# Why: macOS remembers permissions (Accessibility, Screen Recording,
# Microphone) by an app's signing identity. Ad-hoc signing makes that
# identity a hash of the app's contents, so every update looks like a new
# app and every grant is lost. Signing every build with this one certificate
# makes the identity "dev.damiensmith.clance, signed by this certificate",
# which stays the same across updates — the same effect as a paid Developer
# ID, for free.
#
# Expect up to two macOS password prompts, both one-time:
#   1. allowing the certificate to be trusted for code signing
#   2. allowing codesign to use its key ("Always Allow")
#
# Keep a backup. If this certificate is ever lost and a new one made, the
# identity changes and everyone re-grants permissions once. Back it up from
# Keychain Access: select "Clance Code Signing" under My Certificates,
# File -> Export Items..., save as .p12 with a password, and store that in
# your password manager. The private key is never written anywhere else.
set -eu

NAME="Clance Code Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
DAYS=3650

# Never create a second one: a new certificate has a different hash, which
# is exactly the identity change this whole setup exists to avoid.
if security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "==> '$NAME' already exists in your login keychain; not creating another."
  CERT_EXISTS=1
else
  CERT_EXISTS=0
fi

WORK="$(mktemp -d)"
chmod 700 "$WORK"
# Removes the private key material on any exit, success or failure.
trap 'rm -rf "$WORK"' EXIT INT TERM

if [ "$CERT_EXISTS" -eq 0 ]; then
  echo "==> Creating self-signed code-signing certificate '$NAME' (valid ${DAYS} days)"
  cat > "$WORK/cert.cnf" <<CNF
[ req ]
distinguished_name = dn
x509_extensions = ext
prompt = no
[ dn ]
CN = $NAME
[ ext ]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
subjectKeyIdentifier = hash
CNF
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days "$DAYS" \
    -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/cert.cnf" 2>/dev/null

  # A throwaway password only to move the key into the keychain. OpenSSL 3
  # needs -legacy for a .p12 that macOS's `security import` can read;
  # LibreSSL (macOS's /usr/bin/openssl) doesn't have the flag and doesn't
  # need it.
  P12_PASS="$(openssl rand -hex 16)"
  openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
    -out "$WORK/id.p12" -passout "pass:$P12_PASS" -legacy 2>/dev/null \
  || openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
    -out "$WORK/id.p12" -passout "pass:$P12_PASS" 2>/dev/null

  echo "==> Importing into your login keychain (key usable by codesign only)"
  security import "$WORK/id.p12" -k "$KEYCHAIN" -P "$P12_PASS" -T /usr/bin/codesign >/dev/null
else
  security find-certificate -c "$NAME" -p "$KEYCHAIN" > "$WORK/cert.pem"
fi

echo "==> Trusting it for code signing (macOS will ask for your password)"
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$WORK/cert.pem"

echo "==> Test-signing a throwaway binary (click 'Always Allow' if asked)"
cp /usr/bin/true "$WORK/probe"
codesign --force --sign "$NAME" "$WORK/probe"

if security find-identity -v -p codesigning | grep -q "\"$NAME\""; then
  echo
  echo "Done. '$NAME' is a valid code-signing identity."
  echo "Releases (scripts/release.sh) and dev builds (npm run dev:packaged) now use it."
  echo "Back it up: Keychain Access -> My Certificates -> $NAME -> File -> Export Items (.p12)."
else
  echo "error: '$NAME' still isn't listed as a valid code-signing identity." >&2
  exit 1
fi

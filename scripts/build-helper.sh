#!/usr/bin/env bash
# Builds the helper and preserves an unchanged signed installation across dev starts.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/native/CommandOSHelper"
OUT_DIR="$ROOT/apps/desktop/resources/bin"

swift build -c release --package-path "$PKG" >&2
BIN="$(swift build -c release --package-path "$PKG" --show-bin-path)/CommandOSHelper"

mkdir -p "$OUT_DIR"
INSTALLED="$OUT_DIR/CommandOSHelper"
STAMP="$OUT_DIR/.CommandOSHelper-build"
SIGNING_IDENTITY="${COMMANDOS_SIGN_IDENTITY:--}"
SOURCE_HASH="$(shasum -a 256 "$BIN" | awk '{print $1}')"
if [[ -f "$STAMP" && -f "$INSTALLED" ]]; then
  IFS=' ' read -r PREVIOUS_SOURCE PREVIOUS_SIGNED PREVIOUS_IDENTITY < "$STAMP" || true
  INSTALLED_HASH="$(shasum -a 256 "$INSTALLED" | awk '{print $1}')"
  if [[ "$SOURCE_HASH" == "${PREVIOUS_SOURCE:-}" && "$INSTALLED_HASH" == "${PREVIOUS_SIGNED:-}" && "$SIGNING_IDENTITY" == "${PREVIOUS_IDENTITY:-}" ]] && codesign --verify "$INSTALLED" 2>/dev/null; then
    echo "Reusing unchanged signed CommandOSHelper" >&2
    echo "$INSTALLED"
    exit 0
  fi
fi

# Sign before replacing the running helper; do not mutate an executable in use.
STAGED="$OUT_DIR/.CommandOSHelper-new-$$"
trap 'if [[ -f "$STAGED" ]]; then rm -f "$STAGED"; fi' EXIT
cp "$BIN" "$STAGED"
codesign --force --sign "$SIGNING_IDENTITY" --identifier com.commandos.helper "$STAGED" >&2
SIGNED_HASH="$(shasum -a 256 "$STAGED" | awk '{print $1}')"
mv -f "$STAGED" "$INSTALLED"
printf '%s %s %s\n' "$SOURCE_HASH" "$SIGNED_HASH" "$SIGNING_IDENTITY" > "$STAMP"
echo "$OUT_DIR/CommandOSHelper"

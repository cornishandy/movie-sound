#!/bin/bash
# Builds Movie Sound.app from Movie Sound.applescript with the speaker icon, signs it, and links it on the Desktop.
#   build.sh [OUT_APP] [CMD]   CMD replaces the movie-audio command (tests point it at a test copy).
# Rebuilding changes the app's signature, so macOS forgets its Accessibility permission; avoid rebuilding needlessly.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HOME/Applications/Movie Sound.app}"
SRC="$HERE/Movie Sound.applescript"
if [ -n "${2:-}" ]; then
  SRC="$(mktemp -t movie-sound).applescript"
  sed "s#^property cmd : .*#property cmd : \"$2\"#" "$HERE/Movie Sound.applescript" > "$SRC"
fi
mkdir -p "$(dirname "$OUT")"
rm -rf "$OUT"
osacompile -o "$OUT" "$SRC"
cp "$HERE/MovieSound.icns" "$OUT/Contents/Resources/applet.icns"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.cornishandy.movie-sound" "$OUT/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.cornishandy.movie-sound" "$OUT/Contents/Info.plist"
codesign --force --sign - "$OUT" >/dev/null 2>&1
touch "$OUT"
if [ -z "${1:-}" ]; then
  ln -sfn "$OUT" "$HOME/Desktop/Movie Sound"
fi
echo "built $OUT"

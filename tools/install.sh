#!/bin/bash
# Installs the live copy Movie Sound runs from:
#   bridge/          -> ~/Library/Application Support/movie-sound/bridge/  (off iCloud and cache clean-ups)
#   bin/movie-audio  -> ~/.local/bin/movie-audio                          (what Movie Sound.app runs)
# A bridge that's already running keeps its old files until Movie Sound is turned off and on again.
# It doesn't rebuild Movie Sound.app (rebuilding makes macOS forget its Accessibility permission); run app/build.sh for a first install.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/Application Support/movie-sound"
mkdir -p "$DEST/bridge" "$HOME/.local/bin"
rsync -a --delete --exclude .DS_Store "$HERE/bridge/" "$DEST/bridge/"
install -m 755 "$HERE/bin/movie-audio" "$HOME/.local/bin/movie-audio"
echo "Installed the bridge to $DEST/bridge and movie-audio to ~/.local/bin."

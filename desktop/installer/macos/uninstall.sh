#!/bin/bash
# PearCinema Desktop - macOS uninstaller.
#
# "Uninstalling" by dragging the app to the Trash silently leaves four things
# behind:
#
#   app             /Applications/PearCinema.app
#   login item      "PearCinema" (the app registers one on first launch)
#   daemon          /Library/LaunchDaemons/com.peerloom.pearcinema.plist (if installed)
#   THE LIBRARY     ~/Library/Application Support/pearcinema-desktop/data
#
# THE LAST ONE IS THE WHOLE REASON THIS ASKS BEFORE ACTING. `data/host.seed` is
# the library's identity - the key every paired phone knows it by - and the
# store holds the grant list of who may connect. Nothing regenerates either.
# Deleting them does not "reset" PearCinema; it makes this machine a DIFFERENT
# library that none of your phones recognise, with no error and no way back
# short of a backup.
#
# So the library is KEPT by default, and a reinstall stays the same library with
# the same pairings. --purge wipes it (after taking a backup), --keep forces the
# default, and with neither on an interactive terminal you are asked.
#
#   bash uninstall.sh              # remove the app, keep the library
#   bash uninstall.sh --purge      # remove everything, backing the library up first
#   bash uninstall.sh --keep       # never prompt, always keep

set -uo pipefail

APP="/Applications/PearCinema.app"

# RE-EXEC FROM /tmp IF WE LIVE INSIDE THE APP WE ARE ABOUT TO DELETE. This script
# ships in PearCinema.app/Contents/Resources, and bash re-reads the script file as
# it executes - so removing the bundle mid-run would truncate the rest of this file
# and leave the login item and caches behind, having already deleted the app. Copy
# out and hand over before touching anything.
case "$0" in
  "$APP"/*)
    TMP=$(mktemp /tmp/pearcinema-uninstall.XXXXXX) || exit 1
    cp "$0" "$TMP" && chmod +x "$TMP"
    exec /bin/bash "$TMP" "$@"
    ;;
esac
SUPPORT="$HOME/Library/Application Support/pearcinema-desktop"
DATA="$SUPPORT/data"
SEED="$DATA/host.seed"
DAEMON_PLIST="/Library/LaunchDaemons/com.peerloom.pearcinema.plist"

PURGE=""
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --keep)  PURGE=0 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
  esac
done

say () { echo "==> $*"; }

# ---------------------------------------------------------------------------
# 1. Stop it. A running app holds its files open, and on a reinstall the old one
#    would still be serving on 8751 while the new one fails to bind.
# ---------------------------------------------------------------------------
say "Stopping PearCinema"
osascript -e 'quit app "PearCinema"' 2>/dev/null
sleep 3
pkill -f "/Applications/PearCinema.app" 2>/dev/null
sleep 1
if lsof -nP -iTCP:8751 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "    WARNING: something is still listening on 8751."
  echo "    If you also run the host from source or a terminal, stop that too."
fi

# ---------------------------------------------------------------------------
# 2. The daemon, if --install-service ever registered one. Needs sudo; skip with
#    a note when we cannot.
# ---------------------------------------------------------------------------
if [ -f "$DAEMON_PLIST" ]; then
  say "Removing the background daemon (needs your password)"
  sudo launchctl bootout system/com.peerloom.pearcinema 2>/dev/null
  sudo rm -f "$DAEMON_PLIST" \
    && echo "    removed" || echo "    could not remove $DAEMON_PLIST - remove it with sudo yourself"
fi

# ---------------------------------------------------------------------------
# 3. The login item. The app registers one on first launch (setLoginItemSettings),
#    so removing only the .app leaves macOS trying to start something that is gone.
# ---------------------------------------------------------------------------
say "Removing the login item"
osascript -e 'tell application "System Events" to delete login item "PearCinema"' 2>/dev/null \
  && echo "    removed" || echo "    (none found)"

# ---------------------------------------------------------------------------
# 4. The app itself.
# ---------------------------------------------------------------------------
if [ -d "$APP" ]; then
  say "Removing $APP"
  rm -rf "$APP"
else
  say "No app at $APP (already removed?)"
fi

# ---------------------------------------------------------------------------
# 5. The library. Everything above is replaceable; this is not.
# ---------------------------------------------------------------------------
if [ ! -e "$SUPPORT" ]; then
  say "No PearCinema data to consider - done."
  exit 0
fi

if [ -z "$PURGE" ]; then
  if [ -t 0 ]; then
    echo
    echo "  Your library lives in:"
    echo "    $DATA"
    echo "  It holds host.seed - the identity every paired phone knows this library by -"
    echo "  and the list of who has access. Deleting it does NOT reset PearCinema: it"
    echo "  makes this machine a different library that none of your phones recognise."
    echo
    read -r -p "  Delete the library too? [y/N] " reply
    case "$reply" in [yY]*) PURGE=1 ;; *) PURGE=0 ;; esac
  else
    PURGE=0   # non-interactive: never destroy data nobody confirmed
  fi
fi

if [ "$PURGE" = "1" ]; then
  if [ -f "$SEED" ]; then
    ARCHIVE="$HOME/pearcinema-library-backup-$(date -u +%Y%m%d-%H%M%S).tar.gz"
    say "Backing the library up first"
    if tar -czf "$ARCHIVE" -C "$(dirname "$SUPPORT")" "$(basename "$SUPPORT")" \
      && tar -tzf "$ARCHIVE" >/dev/null 2>&1; then
      echo "    backup verified at $ARCHIVE"
    else
      echo "    BACKUP FAILED - keeping the library. Nothing was deleted."
      exit 1
    fi
  fi
  say "Removing $SUPPORT"
  rm -rf "$SUPPORT"
  echo "    done. To restore later:  tar -xzf <backup> -C '$HOME/Library/Application Support/'"
else
  say "Keeping the library at $DATA"
  echo "    A reinstall picks it straight back up, same pairings and all."
fi

say "PearCinema is uninstalled."

#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
if command -v zsh >/dev/null 2>&1; then
    zsh "$SCRIPT_DIR/start-chrome-cdp.sh"
else
    sh "$SCRIPT_DIR/start-chrome-cdp.sh"
fi
result=$?
printf '\nPress Enter to close this window. '
read -r unused
exit "$result"

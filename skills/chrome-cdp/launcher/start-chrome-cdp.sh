#!/bin/sh
# Common shell implementation, runnable under zsh, bash or POSIX sh.
if [ -n "${ZSH_VERSION:-}" ]; then emulate sh; fi
set -eu

fail() { printf '\nError: %s\n' "$*" >&2; exit 1; }
ask() {
    printf '%s [%s]: ' "$1" "$2" >&2
    IFS= read -r answer || exit 1
    printf '%s\n' "${answer:-$2}"
}
choose() {
    printf '\n%s\n' "$1" >&2
    printf '%s\n' "$2" | awk '{printf "  %d. %s\n", NR, $0}' >&2
    count=$(printf '%s\n' "$2" | awk 'END {print NR}')
    while :; do
        answer=$(ask 'Choose' '1')
        case "$answer" in ''|*[!0-9]*) continue ;; esac
        [ "$answer" -ge 1 ] && [ "$answer" -le "$count" ] && break
    done
    printf '%s\n' "$answer"
}
item() { printf '%s\n' "$1" | sed -n "${2}p"; }
port() {
    while :; do
        value=$(ask "$1" "$2")
        case "$value" in ''|*[!0-9]*) continue ;; esac
        [ "${#value}" -le 5 ] || continue
        [ "$value" -ge 1 ] && [ "$value" -le 65535 ] && break
    done
    printf '%s\n' "$value"
}
add_browser() {
    if [ -x "$2" ]; then browsers="${browsers}${browsers:+
}$1|$2"; fi
}
cdp_ready() {
    response=$(curl --noproxy '*' -fsS --max-time 1 "http://127.0.0.1:$local_port/json/version" 2>/dev/null) || return 1
    case "$response" in *'"Browser"'*'"webSocketDebuggerUrl"'*|*'"webSocketDebuggerUrl"'*'"Browser"'*) return 0 ;; esac
    return 1
}

command -v ssh >/dev/null 2>&1 || fail 'Install OpenSSH first.'
command -v curl >/dev/null 2>&1 || fail 'Install curl first.'
command -v base64 >/dev/null 2>&1 || fail 'Install base64 first.'
printf 'Chrome CDP launcher — choose browser, site and tunnel destination.\n'
origin=$(ask 'Website origin (scheme + host + optional port)' 'https://')
printf '%s\n' "$origin" | LC_ALL=C grep -Eq '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?/?$|^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?/?$' || fail 'Use an HTTPS origin, or loopback HTTP, without credentials, path or query.'
origin=${origin%/}

ssh_aliases=''
if [ -f "$HOME/.ssh/config" ]; then
    ssh_aliases=$(awk 'tolower($1)=="host" {for(i=2;i<=NF;i++) {if($i ~ /^#/) break; if($i !~ /[*?!]/) print $i}}' "$HOME/.ssh/config" | sort -u)
fi
destinations="${ssh_aliases}${ssh_aliases:+
}Enter another SSH destination"
choice=$(choose 'SSH destination (aliases from ~/.ssh/config)' "$destinations")
destination=$(item "$destinations" "$choice")
if [ "$destination" = 'Enter another SSH destination' ]; then destination=$(ask 'SSH alias or user@host' ''); fi
printf '%s\n' "$destination" | LC_ALL=C grep -Eq '^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$' || fail 'Invalid SSH destination. Configure a named SSH alias for complex options.'

browsers=''
if [ "$(uname -s)" = Darwin ]; then
    for directory in /Applications "$HOME/Applications"; do
        add_browser 'Google Chrome' "$directory/Google Chrome.app/Contents/MacOS/Google Chrome"
        add_browser 'Chrome Beta' "$directory/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"
        add_browser 'Chrome Dev' "$directory/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev"
        add_browser 'Chrome Canary' "$directory/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
        add_browser 'Chrome for Testing' "$directory/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        add_browser 'Chromium' "$directory/Chromium.app/Contents/MacOS/Chromium"
    done
else
    for executable in google-chrome-stable google-chrome google-chrome-beta google-chrome-unstable chromium chromium-browser; do
        browser_path=$(command -v "$executable" 2>/dev/null || true)
        [ -z "$browser_path" ] || add_browser "$executable" "$browser_path"
    done
fi
browser_options="${browsers}${browsers:+
}Enter another executable"
choice=$(choose 'Local browser (label | executable)' "$browser_options")
browser=$(item "$browser_options" "$choice")
if [ "$browser" = 'Enter another executable' ]; then
    browser=$(ask 'Full path to Chrome/Chromium executable' '')
else
    browser=${browser#*|}
fi
[ -x "$browser" ] || fail "Browser executable not found: $browser"

local_port=$(port 'Local Chrome debugging port (9222 or 9333, for example)' 9222)
remote_port=$(port 'Remote agent-host tunnel port (independent of the browser port)' 9778)
profile_name=$(ask 'Dedicated profile name (retains this session login)' 'audit')
printf '%s\n' "$profile_name" | LC_ALL=C grep -Eq '^[A-Za-z0-9_-]+$' || fail 'Profile names may contain letters, digits, hyphens and underscores.'
profile_dir="$HOME/.chrome-cdp/profiles/$profile_name-$local_port"
if curl --noproxy '*' -sS --max-time 1 -o /dev/null "http://127.0.0.1:$local_port/json/version" 2>/dev/null; then
    fail "Port $local_port already has a listener. Choose another local port or close the dedicated browser using it."
fi
mkdir -p "$profile_dir"
chmod 700 "$profile_dir"
printf '\nOpening %s\nProfile: %s\nWebsite: %s\n' "$browser" "$profile_dir" "$origin"
nohup "$browser" --remote-debugging-address=127.0.0.1 --remote-debugging-port="$local_port" \
    --user-data-dir="$profile_dir" --no-first-run --no-default-browser-check \
    --new-window "$origin/" >"$profile_dir/launcher.log" 2>&1 &
ready=0
attempt=0
while [ "$attempt" -lt 40 ]; do
    if cdp_ready; then ready=1; break; fi
    attempt=$((attempt + 1))
    sleep 0.5
done
[ "$ready" = 1 ] || fail "Chrome did not open CDP. Close only the dedicated profile using this directory and retry. Log: $profile_dir/launcher.log"
descriptor=$(printf '{"version":1,"port":%s,"approvedOrigin":"%s"}' "$remote_port" "$origin" | base64 | tr -d '\r\n')
remote_setup="umask 077; mkdir -p ~/.config/chrome-cdp; printf '%s' '$descriptor' | base64 -d > ~/.config/chrome-cdp/forwarded.json.tmp && chmod 600 ~/.config/chrome-cdp/forwarded.json.tmp && mv ~/.config/chrome-cdp/forwarded.json.tmp ~/.config/chrome-cdp/forwarded.json && printf '\\nTunnel ready; connection descriptor installed.\\n' >&2 && while :; do sleep 3600; done"
printf '\nChrome is ready. Sign in manually in the new window.\n'
printf 'Starting tunnel: %s 127.0.0.1:%s -> this computer 127.0.0.1:%s\n' "$destination" "$remote_port" "$local_port"
printf 'Agent endpoint: http://127.0.0.1:%s\nApproved origin: %s\n' "$remote_port" "$origin"
printf 'Keep this terminal open. Ctrl+C stops the tunnel; Chrome stays open.\n\n'
ssh -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -R "127.0.0.1:$remote_port:127.0.0.1:$local_port" "$destination" "$remote_setup"

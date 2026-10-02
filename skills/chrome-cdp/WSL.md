# Visible Windows Chrome from WSL2

This fork adds optional WSL helpers; the upstream `cdp.mjs` is unchanged.
The skill is agent-independent: it needs a terminal, Node.js 22+, and access to
this skill directory, not Pi. macOS, native Windows, and desktop Linux still
use the original CLI and browser setup.

## 1. Get current addresses in WSL

```bash
ip -4 route show default
ip -4 addr show eth0
```

For NAT-mode WSL, the default route's `via` address is the Windows host and
`eth0`'s IPv4 address (without `/prefix`) is the WSL address. Do not use the
nameserver from `/etc/resolv.conf`: DNS tunneling can make it a synthetic IP.
The tested addresses below are examples, NOT universal or permanent values.

## 2. Configure Windows networking (Administrator PowerShell)

Clone this fork on Windows or copy `scripts/start-windows-chrome.ps1` there.
Run from the skill directory, substituting your current addresses:

```powershell
.\scripts\start-windows-chrome.ps1 -ConfigureNetwork -Port 9778 -WindowsHost 172.17.128.1 -WslAddress 172.17.141.136
```

This runs the equivalent of the commands tested manually:

```powershell
netsh interface portproxy add v4tov4 listenaddress=172.17.128.1 listenport=9778 connectaddress=127.0.0.1 connectport=9778
New-NetFirewallRule -Name Chrome-CDP-WSL-9778 -DisplayName "Chrome CDP WSL 9778" -Direction Inbound -Action Allow -Protocol TCP -LocalAddress 172.17.128.1 -LocalPort 9778 -RemoteAddress 172.17.141.136
```

The helper updates its existing named firewall rule rather than duplicating it.
It does not modify the manually created `Chrome CDP WSL test 9778` rule; remove
that old test rule if migrating, to avoid stale permissions.

**Security:** CDP is unauthenticated browser control. Never bind the proxy to
`0.0.0.0`, allow all remote addresses, or use your everyday profile. The helper
binds only the supplied Windows WSL-facing IP and allows only the supplied WSL
IP. Other pre-existing firewall rules can still broaden access: review them.
Agents must ask before enabling debugging/network changes or sensitive actions.
No administrator access? This NAT-mode setup needs a human administrator.

## 3. Launch visible Chrome (ordinary, non-administrator PowerShell)

```powershell
.\scripts\start-windows-chrome.ps1 -Port 9778
```

Default profile: `%LOCALAPPDATA%\ChromeCDPDebug`. Cookies/logins persist there.
Customize with `-Profile` or `-ChromePath` (for Chromium-based alternatives).
A Chrome already using this profile must be closed before changing its flags.
**Confirm that you can see the window**; a process or screenshot alone is not
proof of desktop visibility. Keep it open during agent commands.

If PowerShell execution policy blocks a downloaded script, review its source
and use your organization's approved execution/unblocking procedure.

## 4. Drive it from any agent in WSL

From this skill directory:

```bash
node scripts/cdp-wsl.mjs list
node scripts/cdp-wsl.mjs open 'https://example.com'
# Copy a unique target ID prefix from list:
node scripts/cdp-wsl.mjs snap TARGET --compact
node scripts/cdp-wsl.mjs click TARGET 'a'
node scripts/cdp-wsl.mjs eval TARGET 'document.title'
node scripts/cdp-wsl.mjs stop TARGET
```

The wrapper discovers the NAT gateway, fetches `/json/version` with a 5-second
timeout, and refreshes a private port file using the current browser UUID.
It sets `CDP_HOST` and `CDP_PORT_FILE` for the upstream CLI and its per-tab daemon.
No manual UUID copying, npm dependencies, browser downloads, or localhost relay.
Override for a custom port or mirrored networking:

```bash
CDP_HOST=127.0.0.1 CDP_PORT=9778 node scripts/cdp-wsl.mjs list
```

In mirrored networking, try localhost first; portproxy may not be necessary.
Do not apply NAT-address examples blindly. Commands use the same persistent
upstream per-tab daemon (idle timeout 20 minutes); `stop TARGET` releases it but
does not close the browser window. After Chrome restarts, run `list` again and
use the new tab IDs. Errors do not trigger unlimited retries or monitoring.

## Reboots and cleanup

Firewall rules and portproxy entries persist, but Chrome must be restarted and
NAT-mode WSL IPs can change. Recompute both addresses and rerun network setup
when needed. This is NOT an automatic, reboot-proof network installer.
If the Windows WSL-facing address changes, delete the old listener too.
In Administrator PowerShell, using the listener address you configured:

```powershell
netsh interface portproxy delete v4tov4 listenaddress=172.17.128.1 listenport=9778
Remove-NetFirewallRule -Name Chrome-CDP-WSL-9778
# Only if removing the earlier manually created test rule:
# Remove-NetFirewallRule -DisplayName "Chrome CDP WSL test 9778"
```

Close only the dedicated debug-profile browser when finished. Do not kill all
Chrome processes or touch an unrelated everyday browser profile.

## Verification

Run `node --test tests/wsl.test.mjs` from the repository root for wrapper tests.
The wrapper was also tested live against Windows Chrome 154 from Ubuntu WSL2:
`list`, `snap`, and `eval` succeeded after the manual networking commands above.
The PowerShell helper automates those commands, but its own end-to-end execution
has not yet been verified; a Windows PowerShell parser check timed out in the
initial test environment. Review it before granting administrator permission.
## Share the skill with agents

Install/copy the entire `skills/chrome-cdp` directory, including `WSL.md` and
`scripts/`, into each agent's supported skill location, or link them to one
shared checkout. Common locations (verify your agent's version/configuration):

- Pi: `~/.pi/agent/skills/chrome-cdp`
- Claude Code: `~/.claude/skills/chrome-cdp`
- Codex: `~/.agents/skills/chrome-cdp`
- Other agents: their skill/context directory, or an instruction pointing to
  this `SKILL.md` and the absolute CLI path.

For example, from WSL with a shared checkout at `~/chrome-cdp-skill-wsl`:

```bash
mkdir -p ~/.claude/skills ~/.agents/skills
# Only create links if those destinations are unused. Never overwrite another skill.
ln -s ~/chrome-cdp-skill-wsl/skills/chrome-cdp ~/.claude/skills/chrome-cdp
ln -s ~/chrome-cdp-skill-wsl/skills/chrome-cdp ~/.agents/skills/chrome-cdp
```

Restart/reload agents if they cache skill discovery. Agents running natively
on Windows need their own Windows-side skill path and Node.js installation;
WSL home-directory links are not automatically their skill installation.
Multiple agents can connect, but coordinate ownership of tabs so they do not
click/type in the same page concurrently. Sharing a skill is not sharing a
safe task scheduler.

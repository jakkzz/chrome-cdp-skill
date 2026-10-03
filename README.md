# chrome-cdp

Agent-independent **Chrome MCP** for the browser you select. Use it from Pi,
OMP, Claude Code, Codex, Hermes, or another stdio MCP client. Node.js 22+ is
required. No Puppeteer and no browser download.

## Architecture

```text
native agent -> local stdio MCP -> loopback CDP -> Chrome
agent in WSL -> PowerShell stdio -> Windows MCP -> Windows loopback -> Chrome
remote agent -> SSH stdio -> browser-host MCP -> loopback CDP -> Chrome
```

The server runs on the **browser host**, as the browser's OS user. Native Windows,
macOS and Linux use local discovery. WSL can launch the Windows-side server over
PowerShell stdio without exposing CDP or changing firewall rules. SSH remains the
transport for a different machine; Tailscale is optional reachability, not
authorization. All modes keep raw CDP on browser-host loopback and share tab
ownership across independent agents.

Host, username, SSH port, identity file and browser profile are runtime inputs.
There are no personal device addresses, credentials or usernames in defaults.
The connector never edits `authorized_keys`, firewall rules, or browser settings.

## Install

Clone this repository on the agent machine and, for remote use, on the browser
host. In each checkout:

```sh
npm ci
node src/cli.mjs doctor
node src/cli.mjs setup
```

Keep each checkout at the same reviewed revision. Manual SSH setup never installs
onto another host. The Pi `/chrome-windows` extension is the narrow exception for
the Windows host paired with the current WSL2 environment: on explicit invocation,
it copies this reviewed runtime into versioned Windows LocalAppData, runs Windows
`npm ci`, opens Chrome's debugging setup page, and registers a session-scoped MCP
server. The package retains its existing `pi-chrome-cdp` name for compatibility,
but its MCP implementation is not Pi-specific.

On the machine displaying Chrome, open:

**`chrome://inspect/#remote-debugging`**

Enable remote debugging and approve Chrome's connection prompts. This is a
setup page, **not** a network endpoint. Chrome versions that do not offer this
page need their supported debugging setup; the connector does not change it.

To explicitly request opening the setup page locally:

```sh
node src/cli.mjs setup --open --browser-path "$BROWSER_EXECUTABLE"
```

macOS can omit `--browser-path` to request Google Chrome via `open -a`.
Opening internal Chrome URLs programmatically is browser/version dependent;
confirm the visible page and use the manual URL if necessary. Running this in
WSL does not launch an application on a remote Mac.

## Configure an agent

The universal executable/argument pair is:

```text
command: node
args: [ABSOLUTE_CHECKOUT_PATH/src/cli.mjs, serve]
```

See [agent configuration](docs/MCP.md) for all five clients. Install the optional
skill only for workflow guidance; **MCP is the supported browser-control interface**.

## Select between Mac, Linux, Windows and headless targets

A server process controls exactly one browser host for its lifetime. Browser tools
do not switch hosts dynamically. To make the target explicit and operator-controlled,
register one named MCP server per browser environment, then tell the agent which
server to use. Do not let an agent infer a host from Tailscale peers, SSH config, or
a previously used browser.

Before manually registering a visible browser target, install the same reviewed
checkout and run `npm ci` on that browser host. The Pi `/chrome-windows` flow below
can provision its Windows-side runtime from WSL2 instead. Enable debugging in that
host's Chrome at `chrome://inspect/#remote-debugging` and approve the connection.
Remote examples keep raw CDP on the browser host's loopback interface and transport
MCP over SSH stdio.

Pi names tools by server, for example `mcp__chrome_mac__chrome_tabs` and
`mcp__chrome_linux__chrome_tabs`. Separate names therefore let the operator say
“use Chrome on my Mac” or “use the headless browser” without changing connection
arguments mid-session.

### Local Linux or macOS Chrome

```sh
pi mcp add chrome-linux --exposure direct -- \
  node "$CHROME_MCP_ENTRY" serve --browser-host native
```

Use a different descriptive name, such as `chrome-mac-local`, when Pi itself runs
natively on macOS.

### Chrome on a remote Mac or Linux host

```sh
pi mcp add chrome-mac --exposure direct -- \
  node "$CHROME_MCP_ENTRY" serve \
  --ssh-host "$MAC_SSH_HOST" \
  --ssh-user "$MAC_SSH_USER" \
  --remote-entry "$MAC_CHROME_MCP_ENTRY"
```

An existing SSH-config alias may supply the user, key and port. The remote checkout
must exist already; the connector does not install itself or alter SSH access.

### Windows Chrome from WSL2

For Pi, install this repository as a package in WSL2 and start Pi normally, including
through `herdr --remote wsl2` or `nebula ssh wsl2`:

```sh
pi install git:github.com/jakkzz/chrome-cdp-skill
pi
```

Then run this explicit interactive command:

```text
/chrome-windows
```

The extension verifies Windows Node.js 22+, npm, Chrome, and WSL interop; copies the
reviewed MCP runtime to a content-versioned directory under Windows LocalAppData;
installs its runtime dependencies there; opens
`chrome://inspect/#remote-debugging` in Windows Chrome; and registers the
session-scoped `chrome-windows` MCP server with direct tool exposure. It does not
change firewall rules, expose a debugging port, edit Chrome settings, or approve
Chrome's security prompt. Enable remote debugging and approve that visible prompt,
then ask the agent to use Windows Chrome.

Re-running `/chrome-windows` is safe: an unchanged runtime is reused, while changed
source receives a new content-versioned directory. Windows Chrome and Node.js 22+
remain prerequisites; the extension does not install operating-system applications.

Manual configuration remains available when the extension is not installed:

```sh
pi mcp add chrome-windows --exposure direct -- \
  node "$CHROME_MCP_ENTRY" serve \
  --browser-host windows \
  --windows-node 'C:\Program Files\nodejs\node.exe' \
  --windows-entry 'C:\Users\YOUR_USER\chrome-cdp-skill\src\cli.mjs'
```

`--windows-node` may be omitted when `node.exe` is on the Windows PATH exposed
to PowerShell. A separate Windows machine uses the SSH form with
`--remote-shell powershell` instead.

### Dedicated headless Chrome

Launch a separate headless browser on the browser host with an isolated profile and
a loopback-only debugging port. Do not reuse a daily Chrome profile or expose this
port on a LAN or tailnet:

```sh
HEADLESS_CDP_PORT=9222
HEADLESS_PROFILE=/absolute/path/to/a/dedicated-headless-profile
"$BROWSER_EXECUTABLE" \
  --headless=new \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$HEADLESS_CDP_PORT" \
  --user-data-dir="$HEADLESS_PROFILE" \
  about:blank
```

Register a server that targets that explicit port:

```sh
pi mcp add chrome-headless --exposure direct -- \
  node "$CHROME_MCP_ENTRY" serve \
  --browser-host native \
  --port "$HEADLESS_CDP_PORT"
```

For headless Chrome on a remote host, combine the SSH arguments with `--port`;
the port is resolved on that remote host. Headless mode is separate from Chrome's
visible debugging approval flow, but controlling it still requires explicit operator
authorization.

After adding or changing entries, run `/reload` in Pi. Use `/mcp` to enable or
disable targets for the current workflow. For every selected target, verify
`chrome_doctor`, `chrome_connect` and `chrome_tabs` before interacting. Never
silently fall back to a different configured browser when the requested target is
unavailable.

Custom profile or explicit loopback port:

```sh
node src/cli.mjs serve --port-file "$DEVTOOLS_PORT_FILE"
node src/cli.mjs serve --port "$CDP_PORT"
```

These are alternative connection inputs. Automatic discovery uses conventional
profile locations on macOS, Windows and Linux (including Flatpak). It does not
scan networks, choose a tailnet peer, or silently fall back to another browser
when a discovered file is invalid. Native Windows works without special flags.
WSL is detected separately and requires an explicit Windows-interop installation
or `--browser-host native` for an actual Linux GUI browser.

## Windows Chrome from WSL2

Install Node.js 22+ and this package on Windows (`npm ci` in the Windows
checkout). Chrome and the Windows-side MCP then use the same Windows user,
profile files, loopback interface and lease directory. Configure the MCP command
inside WSL with explicit Windows paths:

```sh
node "$WSL_CHECKOUT/src/cli.mjs" serve \
  --browser-host windows \
  --windows-node 'C:\Program Files\nodejs\node.exe' \
  --windows-entry 'C:\Users\me\chrome-cdp-skill\src\cli.mjs'
```

`--windows-node` may be omitted when `node.exe` is on the Windows PATH visible
to PowerShell. `--windows-entry` is always required and must be an absolute
Windows path. The WSL process starts an encoded, noninteractive PowerShell
command and proxies MCP over stdio. It does not listen on a network interface,
edit the firewall, or launch/enable Chrome debugging.

If `powershell.exe` interop is disabled for the distro, SSH directly to Windows
OpenSSH using `--remote-shell powershell`; do not SSH into WSL and expose CDP
with `netsh portproxy`. To control a real Linux GUI Chrome from WSL instead,
select `--browser-host native` explicitly.

## Codex on a remote agent host with desktop Chrome

For the case where Codex runs on a remote POSIX host while Chrome runs on a local
Windows, macOS or Linux desktop, the skill now includes a reverse-tunnel launcher
under `skills/chrome-cdp/launcher/`.

The operator runs the launcher on the browser computer, chooses the site, SSH
agent-host destination, two loopback ports and a dedicated profile. The launcher:

1. Starts Chrome with a dedicated profile and browser-host loopback CDP port.
2. Requests an SSH reverse tunnel from the agent-host loopback port to Chrome.
3. Writes `~/.config/chrome-cdp/forwarded.json` only after SSH accepts the forwarding.

A Skills CLI installation copies the launcher guidance and self-contained CDP CLI
to Codex:

```sh
npx skills add jakkzz/chrome-cdp-skill -g -a codex -s chrome-cdp -y
```

When the descriptor exists, the skill CLI automatically selects that explicit
forwarded target; it never scans hosts or guesses a port. This makes browser control
available to a skill-only Codex installation without copying raw credentials or
changing firewall rules. The launcher must remain running.

For native MCP tools, install the full reviewed package checkout on the agent host
and configure its descriptor port:

```sh
codex mcp add chrome-forwarded -- \
  node "$CHROME_MCP_ENTRY" serve --port "$FORWARDED_CDP_PORT"
```

Chrome advertises its browser-host port in `/json/version`; `--port` validates that
loopback endpoint and rewrites it to the selected agent-host tunnel port before
opening the WebSocket. Both tunnel ends remain bound to loopback. Skill installation
cannot silently modify persistent Codex MCP settings, so MCP registration remains an
explicit operator action.

## Remote access and Tailscale

`doctor` detects OS/WSL, optional herdr context, Tailscale CLI availability and
whether its backend is connected. It also reports browser endpoint discovery.
Discovery alone does not prove browser control; use MCP `chrome_connect` for
an actual WebSocket + CDP handshake.

1. Choose the browser host explicitly. A tailnet IP or hostname is an SSH host,
   not automatically a Chrome endpoint.
2. Enable SSH on that host yourself. Install Node.js 22+ and this package there.
3. Add your **public** SSH key to that user's `~/.ssh/authorized_keys` yourself.
   Windows OpenSSH's administrator configuration may use a different file.
   Follow your host's SSH instructions and permissions. Never send a private key.
4. Verify the host-key fingerprint out of band and establish SSH access manually.
5. Supply remote settings to the MCP launch command:

```sh
node "$LOCAL_CHECKOUT/src/cli.mjs" serve \
  --ssh-host "$BROWSER_HOST" \
  --ssh-user "$BROWSER_USER" \
  --remote-entry "$REMOTE_CHECKOUT/src/cli.mjs"
```

Use `--remote-node` when noninteractive SSH does not find Node in PATH;
`--identity-file` for an existing private key; `--ssh-port` for a custom SSH port.
An existing SSH-config alias can supply the user/key/port instead.
For Windows hosts use `--remote-shell powershell`; the encoded command avoids
cmd.exe quoting problems. For POSIX hosts the default is `posix`.
`--port-file` and `--port` in remote mode refer to **browser-host** values.

SSH uses batch authentication, strict host-key checking, a bounded connection
timeout and keepalives. No passwords are solicited or stored. Configuration
belongs in your agent's user-level settings, not this repository.

## Tools and safe workflow

1. `chrome_doctor` / `chrome_connect`: inspect setup and verify the connection.
2. `chrome_tabs`: list actual page targets.
3. `chrome_claim`: acquire a full target ID before reading or changing it.
4. `chrome_wait`: wait for document readiness plus an exact URL, unique visible
   selector and/or visible text. After navigation, include a URL or selector so
   the previous document cannot accidentally satisfy the wait. This is not
   network-idle detection. Waits are cancellable and capped at 20 seconds.
5. `chrome_snapshot` / `chrome_screenshot`: inspect the owned tab.
6. `chrome_navigate`, `chrome_click`, `chrome_click_at`, `chrome_type`,
   `chrome_key`, `chrome_scroll`, `chrome_drag`, `chrome_select`: interact,
   wait for the expected state, then take a fresh snapshot.
7. `chrome_release`: detach and release when the task finishes, without closing
   the tab. Keep the claim during an interactive task, including conversation
   turns; do not detach after every observation.

`chrome_open` creates and claims a new HTTP(S) tab; `chrome_close_tab` closes an
owned tab. Arbitrary `chrome_evaluate` is **absent by default**; the host must
explicitly launch with `--allow-evaluate` to expose it.

Navigation accepts HTTP(S), not executable/internal schemes. Text/tree output
and screenshot output are bounded. Click coordinates use CSS viewport pixels,
not screenshot device pixels. Selector clicks require a unique, visible,
unobscured match and do not silently scroll.

`chrome_scroll` dispatches real wheel input using CSS-pixel deltas. Supply a
visible pane selector or `x`/`y` coordinates for nested scrolling; otherwise the
pointer uses the viewport center. Supply selectors **or** coordinates, not both.
`chrome_drag` performs a left-button pointer gesture between unique visible
selectors or coordinate pairs, with bounded steps/duration. Cancellation attempts
to release the pointer; inspect after errors. File drops and intercepted HTML
drag payloads are not implemented. `chrome_select` handles native HTML `<select>`
values **or exact visible labels**, including multi-select and clearing a
multi-select with `values: []`. Supply only one of `values` or `labels`; observed
labels let agents select options without guessing internal IDs.
Missing, ambiguous and disabled options are rejected before changing selection.
Custom dropdown menus still use click/key tools. Input/change events do not
confirm that any backend operation succeeded.

### Persistent interactive sessions

Let your agent client keep one stdio MCP server alive for the session. The
server reuses its browser WebSocket and each owned tab's CDP attachment. Do not
start/close a temporary client for each action or release a tab between steps.
Chrome's initial consent remains required; restarts, reconnects and new tab
attachments may ask again. This is not a way to bypass Chrome permission.

Pi can expose tools directly with `--exposure direct` during registration; an
existing user MCP entry can set `"exposure": "direct"`. Run `/reload` once after
updating the server/configuration, then use the tools interactively without
verification scripts. Other agents use the same persistent MCP transport.

## Ownership, herdr and limitations

- All MCP sessions for a browser must use the same browser OS user and default
  local lease directory (`chrome-cdp-mcp/leases` under its cache directory).
  Avoid per-session cache overrides and network filesystems.
- Filesystem locks are shared across processes. They heartbeat while held;
  an unresponsive/crashed owner's lock becomes stale after two minutes.
- A conflicting session must wait for release; there is no forced-takeover tool.
- Closing MCP stdin or terminating it closes its CDP connection and releases
  its leases. In-flight mutations are never automatically retried.
- These are **cooperative locks**, not a browser security boundary or a fencing
  mechanism. A human, another CDP client, legacy scripts or enabled JavaScript
  can bypass them. A stalled command may still execute in Chrome after timeout;
  inspect state before retrying. Do not concurrently use legacy CLI control.
- herdr is detected through `HERDR_ENV=1`; remote proxy mode forwards this as
  informational context. It is optional and never grants browser permission.
  No herdr panes are opened or agents launched automatically.
- Headless SSH sessions may not share a visible desktop environment on some
  hosts. The human must confirm browser visibility and approve debugging.
- Tool annotations are hints for agent approval gates, not enforced human
  authorization. See [security](docs/SECURITY.md).

## Verification

```sh
npm run check
npm test
npm pack --dry-run
```

Tests cover input validation, platform paths, SSH quoting, real MCP initialization
and stdio, cross-process locks, and actual CDP Runtime transport against a Node
inspector. They do **not** claim end-to-end Chrome desktop or all five agent
verification. Live macOS/Windows/Linux browser checks remain separate.

An opt-in end-to-end test launches a real sandboxed, headless Chrome with a
separate temporary profile and exercises two independent MCP clients:

```sh
CHROME_TEST_EXECUTABLE="$BROWSER_EXECUTABLE" node --test tests/chrome-live.test.mjs
```

It checks page interaction, screenshots, shared ownership and disconnect
cleanup. Headless success does not prove visible desktop or remote Mac access.

Legacy WSL scripts remain for compatibility; [their old setup](skills/chrome-cdp/WSL.md)
is not the recommended MCP path and its network proxy is not needed for SSH mode.

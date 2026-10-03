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

Keep each checkout at the same reviewed revision. There is no automatic remote
installation or package publication. The package retains its existing
`pi-chrome-cdp` name for compatibility, but its MCP implementation is not Pi-specific.

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

# Agent MCP configuration

All clients launch the **same server**. The skill is optional workflow guidance,
not a required plugin. Node.js 22+ and dependencies must be installed in the
checkout before configuring it. Use an absolute Node path if your agent's PATH
cannot find Node.

The following commands use a runtime shell variable; set `CHROME_MCP_ENTRY` to
the absolute `src/cli.mjs` path in your reviewed local checkout. Do not commit
personal paths or remote host settings. No configuration is written by the
connector itself.

## Pi

```sh
pi mcp add chrome --exposure direct -- node "$CHROME_MCP_ENTRY" serve
pi mcp list
```

Pi reads its user-level `mcp.json` under its agent directory. Run `/reload` in an
existing session after configuration. Installing this Pi package loads its optional
extension, but it registers Windows Chrome only after the operator explicitly runs
`/chrome-windows`. Pi's tool exposure and approval settings remain in effect.
For an existing Pi entry, add `"exposure": "direct"` inside that server's
object, preserving its connection arguments. This changes tool discoverability,
not approvals. Reload once after deployment; normal tool calls keep the server
and browser attachment alive rather than launching a one-shot client.

### Pi one-command Windows Chrome setup from WSL2

When this repository is installed as a Pi package, its extension adds
`/chrome-windows`. From a Pi process running inside WSL2—even when entered through
`herdr --remote wsl2` or `nebula ssh wsl2`—run:

```text
/chrome-windows
```

The command verifies Windows Node.js 22+, npm, Google Chrome and PowerShell interop;
installs a content-versioned copy of the reviewed MCP runtime under Windows
LocalAppData; opens `chrome://inspect/#remote-debugging` in Windows Chrome; and
registers a session-scoped `chrome-windows` MCP server with direct exposure. Chrome
still requires the human to enable remote debugging and approve its visible prompt.
The extension never changes firewall, SSH or Chrome security settings.

The registration lasts for the current Pi extension runtime. Run the command again
after starting a new Pi session or reloading the extension. If a file-configured MCP
server already uses the name `chrome-windows`, Pi gives that file configuration
precedence; remove or rename the conflicting entry if the command's generated target
should be used.

### Reliable Windows setup and persistent configuration

| Pi command | Behavior |
| --- | --- |
| `/chrome-windows` | Prepare/register once in this extension runtime. |
| `/chrome-windows connect` | Ask the agent to verify the Windows host, then perform one CDP handshake using the existing MCP connection. |
| `/chrome-windows status` | Ask the agent to report the Windows doctor's current discovery/connection state; no new handshake or tab access. |
| `/chrome-windows config` | Print the prepared persistent configuration without writing it. |

`connect` and `status` start an ordinary agent turn using the existing Windows MCP
tools and Pi's normal permission hooks. They are not a separate CDP client or a
background connection monitor. The agent must stop on a wrong host, preserve native
Chrome approval, and report actual failures rather than label every timeout as
approval-needed. Neither command authorizes tab access. If the Windows tools are
not available, inspect `/mcp`; these commands never install or re-register a server.
They work with file-configured Windows tools too. A busy agent or setup in progress
is reported without queueing delayed browser work.

After changing extension JavaScript, restart Pi once: native ESM dependencies can
remain cached across `/reload`. Reload is still appropriate for MCP configuration
changes. The footer follows actual Windows doctor/connect tool calls: checking or
connecting, then connected, not connected, wrong host, unavailable, or failed. It
shows the last observed result, not a background monitor; use `status` to refresh
server-reported state or `connect` for a fresh handshake. Other browser hosts and
ordinary tab failures cannot overwrite the Windows connection indicator.

Windows setup and the WSL proxy share PowerShell discovery: executable files on
absolute PATH entries first, then the conventional Windows PowerShell executable
under `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/`. This avoids requiring a
Pi restart just because Windows PATH was not inherited. Custom Windows mount
locations still need the executable directory on the Pi launcher's PATH. Discovery
does not enable broken/disabled WSL interop.

Setup subprocesses have finite timeouts and force-stop their owned bridge process
on timeout. Windows-side work may have partially completed; inspect before retrying.
No browser action is replayed. Setup is single-flight within a Pi extension runtime;
repeating it after registration preserves the MCP connection instead of launching
Chrome and registering again. Use `/mcp` to inspect/reconnect, or `/reload` to load
updated extension code.

Registration is **not** verified connectivity. Use the tools in the same Pi session:
`chrome-windows` → `chrome_doctor` → `chrome_connect` → `chrome_tabs`. Check the
reported platform before reading any tabs; do not fall back to a Mac or Linux
browser. `/mcp` shows file-config overrides and connection errors.

After successful preparation, run:

```text
/chrome-windows config
```

This prints the exact prepared `mcpServers.chrome-windows` entry, with discovered
Windows paths and direct exposure. It does not install anything, verify connection,
or write configuration. Merge that one entry into your user-level `mcp.json`,
preserving unrelated servers; then `/reload` once. Use distinct names such as
`chrome-windows` and `chrome-mac`. New Pi sessions then load the file-configured
Windows target without another setup command. Chrome approval is still required
when prompted; no fixed CDP port, port forwarding or firewall rule is needed.

The Windows runtime is content-versioned. After updating the package, reload and
prepare again, then refresh the saved entry from `/chrome-windows config` if its
Windows entry path changed. A file-configured entry takes precedence over the
session registration, so always confirm the effective entry in `/mcp`.

## Claude Code

```sh
claude mcp add --scope user --transport stdio chrome -- node "$CHROME_MCP_ENTRY" serve
```

Keep this user-scoped for personal browser access. Project-scoped configuration
is possible but should not contain private host details. Inspect tools and
approval settings in `/mcp`.

## Codex

```sh
codex mcp add chrome -- node "$CHROME_MCP_ENTRY" serve
```

Codex stores the entry in its `mcp_servers` TOML configuration. Keep approvals
and sandbox restrictions enabled; do not bypass them to make browser access
work.

### Codex with Chrome reverse-forwarded from a desktop

When Codex runs on a remote POSIX host, the operator can use the browser-host
launcher bundled under `skills/chrome-cdp/launcher/`. It writes the selected remote
loopback port and approved origin to `~/.config/chrome-cdp/forwarded.json`, then
keeps an SSH reverse tunnel open.

Read the port from that operator-created descriptor and register the full package
checkout explicitly:

```sh
codex mcp add chrome-forwarded -- \
  node "$CHROME_MCP_ENTRY" serve --port "$FORWARDED_CDP_PORT"
```

The server validates Chrome's advertised loopback WebSocket and rewrites its
browser-host port to the forwarded agent-host loopback port. Do not configure a
non-loopback endpoint, infer an SSH peer, or create the descriptor on the operator's
behalf. A skill-only Codex installation can use the bundled self-contained CLI as
documented in `SKILL.md`; installing a skill does not grant permission to change
persistent Codex MCP settings.

## Hermes

```sh
hermes mcp add chrome --command node --args "$CHROME_MCP_ENTRY" serve
```

`--args` consumes the remaining arguments and must be last. Review Hermes MCP
tool approval and image-handling settings before using private browser sessions.

## OMP

Use OMP's `/mcp add` UI, or merge an entry into the active profile's user MCP
configuration (default `~/.omp/agent/mcp.json`). Do not overwrite unrelated
servers. OMP's current [MCP configuration guide](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md)
is authoritative for custom profiles and discovery precedence.

Portable entry shape (replace the explicit placeholder with your runtime path):

```json
{
  "mcpServers": {
    "chrome": {
      "type": "stdio",
      "command": "node",
      "args": ["<absolute-checkout>/src/cli.mjs", "serve"]
    }
  }
}
```

## Windows Chrome when the agent runs in WSL2

Install the same reviewed revision and run `npm ci` in both the WSL and Windows
checkouts. In the agent's MCP configuration, keep the WSL Node command and add
explicit Windows browser-host arguments:

```text
command: node
args:
  - <absolute-WSL-checkout>/src/cli.mjs
  - serve
  - --browser-host
  - windows
  - --windows-node
  - C:\Program Files\nodejs\node.exe
  - --windows-entry
  - C:\Users\me\chrome-cdp-skill\src\cli.mjs
```

The entry path must be absolute and native to Windows. `--windows-node` is
optional when `node.exe` is available in Windows PowerShell's PATH. The WSL
proxy launches the Windows-side MCP through encoded PowerShell and carries MCP
on stdio; CDP remains on Windows loopback. No firewall or port forwarding is
needed. Run `/reload` or the equivalent once after changing MCP configuration.

WSL auto mode intentionally fails with setup guidance unless a Windows entry is
configured. Use `--browser-host native` only for an actual Linux GUI browser in
WSL. If Windows interop is disabled, use the SSH mode below against Windows
OpenSSH with `--remote-shell powershell`.

## Remote browser: same entry, SSH arguments

For Pi, Claude Code and Codex, append these to the `serve` arguments in their
registration command. Hermes accepts them after `--args`. OMP accepts them in
its `args` array. Values must be supplied by the operator at runtime:

```sh
--ssh-host "$BROWSER_HOST" \
--ssh-user "$BROWSER_USER" \
--remote-entry "$REMOTE_CHROME_MCP_ENTRY"
```

The server executes **on the browser host**. Install this same package there
first; `REMOTE_CHROME_MCP_ENTRY` is its absolute `src/cli.mjs` path.
Specify `--remote-node` if noninteractive SSH cannot find Node, and
`--remote-shell powershell` for a Windows host. `--port-file` / `--port` refer
to that host, not the agent machine.

Use your existing SSH config/key agent when possible. Otherwise supply an
existing `--identity-file`; never paste the private key into MCP settings.
All agents for a browser must use the same remote browser OS user and local
lease directory so ownership is shared on that host.

## Verify

Ask the agent to call, in order:

1. `chrome_doctor` — reports setup URL, host OS, Tailscale and discovery.
2. `chrome_connect` — verifies actual browser/CDP connectivity.
3. `chrome_tabs` — lists real tabs.
4. `chrome_claim` — claims a human-approved full target ID.
5. `chrome_wait` — verifies an expected URL/visible element/text with a bounded,
   cancellable deadline; document readiness alone does not prove SPA readiness.
6. `chrome_snapshot` — verifies permitted page access.
7. Keep that claim while using `chrome_scroll`, `chrome_drag`, `chrome_select`
   and the other interaction tools. Observe after each action.
8. `chrome_release` — leaves the tab open and releases ownership at task end.

MCP initialization/tool discovery can succeed even before Chrome is ready;
that does **not** mean browser control has been verified. Chrome may display
an approval prompt on first connection or first tab attachment.

Registration syntax was checked against locally installed Pi, Claude Code,
Codex and Hermes CLI help and OMP's upstream documentation. Live sessions in
all five clients and all host platforms still require independent validation.
Do not silently install servers or change approval settings for the user.

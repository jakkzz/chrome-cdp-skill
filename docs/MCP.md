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
existing session after configuration. Installing the optional Pi skill package
does not automatically register MCP. Pi's tool exposure/approval settings remain
in effect.
For an existing Pi entry, add `"exposure": "direct"` inside that server's
object, preserving its connection arguments. This changes tool discoverability,
not approvals. Reload once after deployment; normal tool calls keep the server
and browser attachment alive rather than launching a one-shot client.

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

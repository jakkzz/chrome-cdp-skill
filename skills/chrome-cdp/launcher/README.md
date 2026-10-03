# Chrome CDP reverse-tunnel launcher

Use this launcher when the AI agent runs on a remote POSIX host while Chrome runs
on your Windows, macOS or Linux desktop. It starts a dedicated Chrome profile,
forwards Chrome CDP through SSH using loopback-only listeners, and writes an
operator-approved connection descriptor on the remote host.

```text
agent -> remote 127.0.0.1:<agent-port> -> SSH reverse tunnel
      -> browser host 127.0.0.1:<browser-port> -> dedicated Chrome
```

## Browser host

Copy this whole folder to the computer where Chrome runs.

- Windows: double-click **Start Chrome CDP.cmd**. It uses PowerShell 7 when
  available and otherwise Windows PowerShell 5.1. Windows OpenSSH Client is
  required.
- macOS: make **Start Chrome CDP.command** executable and double-click it.
- Linux: run `sh start-chrome-cdp.sh`. SSH, curl and base64 are required.

The launcher asks for:

1. The HTTPS origin Chrome should open.
2. An SSH destination or alias for the remote agent host.
3. The local browser executable.
4. The browser-host CDP port.
5. The remote agent-host tunnel port.
6. A dedicated profile name.

SSH uses your existing configuration, keys and host verification. The launcher
never installs keys, changes firewall rules or exposes CDP beyond loopback. It
refuses occupied ports and never kills another browser or tunnel.

The dedicated profile lives under `~/.chrome-cdp/profiles` (or the equivalent
Windows user directory) and retains its own login. Your ordinary Chrome profile
is not copied or modified. Chrome requires a non-default user data directory for
remote-debugging launch flags.

After Chrome becomes ready, the launcher writes this file on the selected remote
agent host with mode 0600:

```text
~/.config/chrome-cdp/forwarded.json
```

It contains only the descriptor version, selected remote loopback port and
approved origin—never credentials or SSH keys. The installed `chrome-cdp` skill
uses that descriptor instead of probing network hosts or guessing ports.

Keep the launcher terminal open. Ctrl+C stops the SSH reverse tunnel and leaves
Chrome open. The descriptor may remain after the tunnel stops; connection attempts
then fail clearly until the launcher is started again.

## Codex on the remote host

Install the skill globally:

```sh
npx skills add jakkzz/chrome-cdp-skill -g -a codex -s chrome-cdp -y
```

Once the browser-host launcher has written `forwarded.json`, Codex can use the
self-contained CLI shipped with the skill immediately. For native MCP tools,
configure Codex from a reviewed repository checkout:

```sh
codex mcp add chrome-forwarded -- \
  node /absolute/path/chrome-cdp-skill/src/cli.mjs serve --port <agent-port>
```

The MCP `--port` mode rewrites Chrome's browser-host-advertised WebSocket port to
the selected remote loopback tunnel port. No raw CDP listener is exposed on a
non-loopback interface.

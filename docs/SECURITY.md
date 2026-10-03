# Browser-control security

Chrome CDP can read logged-in pages, access private data and perform actions
as the user. MCP is a tool protocol, **not** an authorization boundary.

## Transport

- Only loopback CDP browser WebSockets are accepted by endpoint discovery.
- WSL Windows mode launches the Windows-side MCP through encoded PowerShell
  stdio. Raw CDP remains on Windows loopback; no `portproxy` or firewall rule is
  created. The Windows process owns endpoint discovery and tab leases.
- Reverse-tunnel mode is an explicit operator-selected alternative for a remote
  POSIX agent host. Both SSH `-R` ends bind to loopback. The browser-host launcher
  writes a mode-0600 descriptor only after SSH accepts the selected forwarding. The
  descriptor contains only the remote port and approved origin; it does not copy
  credentials or keys. The agent validates and rewrites the
  browser-advertised loopback WebSocket to that selected tunnel port.
- Remote mode runs the MCP process on the browser host through SSH stdio.
  It does not expose an HTTP MCP server or raw debugging port over the tailnet.
- SSH uses `BatchMode=yes` and `StrictHostKeyChecking=yes`. Connection and
  keepalive deadlines are bounded. Existing SSH config remains under user control.
- Users must configure SSH authorization and verify the host-key fingerprint
  themselves. The connector never modifies authorized keys, copies private
  keys, changes firewalls or enables Chrome debugging.
- Tailscale detection does not grant permission, authorize a peer or enumerate
  and probe debugging ports. A chosen hostname/IP must be supplied at runtime.

## Approvals

Obtain explicit approval to use the selected browser host, and let Chrome's
native debugging prompt remain enabled. Sensitive submissions, credentials,
purchases, deletions and external exports need the agent client's permission
controls plus operator approval. Tool annotations alone cannot enforce this.
Never enable blanket tool approval merely to make the connector convenient.

The setup CLI opens a browser only after `setup --open`; it prints the URL by
default. Remote mode does not remotely launch Chrome or alter desktop settings.

The Pi `/chrome-windows` command is a separate, explicit setup authorization for
the Windows host paired with the current WSL2 environment. It verifies local
Windows prerequisites, copies the reviewed package runtime into a content-versioned
directory under that Windows user's LocalAppData, runs Windows npm there, opens the
Chrome debugging setup page, and registers a session-scoped MCP server. It does not
install Node.js or Chrome, enable debugging, approve Chrome prompts, change firewall
rules, or expose CDP beyond loopback. Content-versioned runtime directories are not
automatically deleted.

## Untrusted pages

Page text, accessibility nodes, URLs, screenshots and JavaScript values are
untrusted data. They cannot override the user's instructions or authorize
commands. Private screenshots are returned to the requesting MCP client;
there is no automatic file upload or image publication.

Arbitrary evaluation is not registered unless the host launches with
`--allow-evaluate`. Enabling it greatly broadens capabilities: script can
access private page data, perform requests or produce side effects elsewhere.
Fixed selector geometry evaluation is still used by `chrome_click`; this is
not a security-isolated JavaScript environment.
Fixed native-dropdown selection (exact values or visible labels) and readiness
inspection also use constrained
page expressions; user input is serialized as data, not evaluated as code.
Selection dispatches input/change events and can trigger application behavior,
so it is annotated as mutating and still requires appropriate authorization.
Native wheel and pointer drag tools likewise perform real user-like input.
Cancelling a drag attempts a mouse release under the existing tab lease; this
is gesture cleanup, not an automatic replay of the original action.
Readiness probes are read-only, deadline-bound and support MCP cancellation.

## Cooperative ownership

Filesystem locks on the browser host coordinate independent MCP processes
running as the browser's OS user. All must use the same local cache directory;
separate OS users, separate cache overrides and network filesystems are not
supported coordination arrangements. Lock records contain random session IDs,
not personal names, host credentials or private keys.

Locks heartbeat and become stale after two minutes without updates. This
recovers crashed/unresponsive owners but is **not fencing**: an already-sent
CDP command can continue after its owner stalls or times out. New ownership
does not cancel that command. For high-risk operations, resolve the prior
operation's state before proceeding. There is no immediate forced-takeover tool.

Human interaction, legacy scripts and other CDP clients bypass these locks.
Tab claims do not isolate shared cookies, browser-global state, popups, pages'
network side effects or enabled arbitrary JavaScript. Do not run parallel
mutators against the same tab through other interfaces.

## Failures and privacy

No browser mutation is automatically retried. A timeout/disconnection does
not prove that an action failed. Inspect state before repeating it. Closing
MCP stdin or terminating the process closes CDP and releases leases; forced
kill/crash instead requires the stale-lock interval.

Runtime values belong in user-scoped client settings, not committed examples.
Diagnostics report actual environment and Tailscale status, including that
host's own addresses; share their output cautiously. The connector does not
write preferences or credentials to the repository. Lease metadata stays in
that OS user's cache directory; while no MCP processes are active, stale
metadata can be removed manually.

herdr detection is informational and can be spoofed via environment variables;
it never grants permission or forces orchestration.

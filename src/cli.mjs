#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverEndpoint, environment, tailscaleStatus, sshArgs, SETUP_URL, validatePort } from './connector.mjs';

const HELP = `Usage: node src/cli.mjs <serve|doctor|setup> [options]

serve                           MCP over stdio on the browser host
serve --ssh-host HOST           MCP over SSH to the selected browser host
  --ssh-user USER                Runtime SSH username (or use SSH config)
  --ssh-port PORT                SSH port (otherwise use SSH config)
  --identity-file PATH           Existing private key; never copied or logged
  --remote-entry PATH            Installed src/cli.mjs on the browser host
  --remote-node PATH             Remote Node executable (default: node)
  --remote-shell posix|powershell  Browser host SSH shell (default: posix)
  --port-file PATH               Browser-host DevToolsActivePort file
  --port PORT                    Explicit browser-host loopback debugging port
  --allow-evaluate               Enable high-risk arbitrary JavaScript tool

doctor                          Inspect local OS, Tailscale and debugging discovery
setup                           Print browser setup URL and SSH guidance
setup --open                    Open setup page on THIS machine; explicit opt-in
  --browser-path PATH            Browser executable (required outside macOS)

No host/user/key is hardcoded. No firewall or authorized_keys is changed.
Remote mode needs this package + Node.js 22+ installed on the browser host.
`;

export function parseOptions(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' },
    'ssh-host': { type: 'string' }, 'ssh-user': { type: 'string' }, 'ssh-port': { type: 'string' },
    'identity-file': { type: 'string' }, 'remote-entry': { type: 'string' }, 'remote-node': { type: 'string' },
    'remote-shell': { type: 'string' }, 'port-file': { type: 'string' }, port: { type: 'string' },
    'allow-evaluate': { type: 'boolean' }, 'herdr-context': { type: 'boolean' },
    open: { type: 'boolean' }, 'browser-path': { type: 'string' },
  } });
  if (values.help) return { help: true };
  const [command] = positionals;
  if (positionals.length !== 1 || !['serve', 'doctor', 'setup'].includes(command)) throw new Error(HELP);
  if (values.port && values['port-file']) throw new Error('Choose --port or --port-file, not both');
  if (values.port) validatePort(values.port);
  if (values['ssh-port']) validatePort(values['ssh-port']);
  const remoteKeys = ['ssh-user', 'ssh-port', 'identity-file', 'remote-entry', 'remote-node', 'remote-shell'];
  if (remoteKeys.some(key => values[key]) && !values['ssh-host']) throw new Error('SSH options require --ssh-host');
  if (values['ssh-host'] && command !== 'serve') throw new Error('SSH options are supported by serve; run doctor/setup on the browser host');
  if (command !== 'setup' && (values.open || values['browser-path'])) throw new Error('Browser launch options require setup');
  return { command, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value])) };
}

async function proxy(options) {
  const args = sshArgs({ ...options, herdr: environment().herdr.detected });
  // No shell locally. OpenSSH quotes the remote command explicitly for its chosen shell.
  const child = spawn('ssh', args, { stdio: 'inherit', windowsHide: true });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
      resolve();
    });
  });
}

async function openSetup(options) {
  let executable;
  let args;
  if (options.browserPath) {
    executable = resolve(options.browserPath);
    args = [SETUP_URL];
  } else if (process.platform === 'darwin') {
    executable = 'open'; args = ['-a', 'Google Chrome', SETUP_URL];
  } else {
    throw new Error('Specify --browser-path to the visible host browser executable, or open the printed URL manually. WSL cannot open a Mac browser locally.');
  }
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) { console.log(HELP); return; }
  if (options.command === 'serve') {
    if (options.sshHost) await proxy(options);
    else { const { serve } = await import('./server.mjs'); await serve(options); }
    return;
  }
  if (options.command === 'setup') {
    console.log(`On the machine displaying Chrome, open ${SETUP_URL}\nEnable remote debugging and approve Chrome's connection prompts.\nFor remote use, install Node.js 22+ and this package on that host.\nManually add your PUBLIC SSH key to that user's ~/.ssh/authorized_keys (Windows OpenSSH may use a different configured file).\nVerify the host-key fingerprint and establish SSH access yourself before configuring MCP.\nThe connector uses BatchMode and strict host-key checking; it never edits SSH authorization or firewall rules.`);
    if (options.open) {
      await openSetup(options);
      console.log('Browser launch requested. Confirm that the setup page is visible; internal-page navigation may require opening the URL manually.');
    }
    return;
  }
  let debugging;
  try { await discoverEndpoint(options); debugging = { discovered: true, verified: false }; }
  catch (error) { debugging = { discovered: false, reason: error.message }; }
  console.log(JSON.stringify({ ...environment(), tailscale: await tailscaleStatus(), debugging }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

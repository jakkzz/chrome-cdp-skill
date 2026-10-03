#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverEndpoint, environment, tailscaleStatus, sshArgs, SETUP_URL, validatePort } from './connector.mjs';
import { windowsInteropSpec } from './windows-interop.mjs';

const HELP = `Usage: node src/cli.mjs <serve|doctor|setup> [options]

serve                           MCP over stdio on the browser host
  --browser-host MODE            auto|native|windows|ssh (default: auto)
  --port-file PATH               Browser-host DevToolsActivePort file
  --port PORT                    Explicit browser-host loopback debugging port
  --allow-evaluate               Enable high-risk arbitrary JavaScript tool

serve --browser-host windows    From WSL, run MCP on its Windows host over stdio
  --windows-entry PATH           Absolute Windows path to installed src\\cli.mjs
  --windows-node PATH            Windows node.exe command/path (default: node.exe)

serve --ssh-host HOST           MCP over SSH to the selected browser host
  --ssh-user USER                Runtime SSH username (or use SSH config)
  --ssh-port PORT                SSH port (otherwise use SSH config)
  --identity-file PATH           Existing private key; never copied or logged
  --remote-entry PATH            Installed src/cli.mjs path on the browser host
  --remote-node PATH             Remote Node executable (default: node)
  --remote-shell posix|powershell  Browser host SSH shell (default: posix)

doctor                          Inspect local OS, Tailscale and debugging discovery
setup                           Print browser setup URL and host guidance
setup --open                    Open setup page on THIS machine; explicit opt-in
  --browser-path PATH            Browser executable (required outside macOS)

Native Windows is selected automatically. WSL intentionally requires either
--browser-host windows with a Windows installation path, --browser-host native
for a Linux GUI browser, or --ssh-host for another browser host. Windows interop
uses PowerShell stdio and does not expose CDP or change firewall settings.
No host/user/key is hardcoded. No firewall or authorized_keys is changed.
`;

export function parseOptions(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' },
    'browser-host': { type: 'string' },
    'windows-entry': { type: 'string' }, 'windows-node': { type: 'string' },
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
  if (values['browser-host'] && !['auto', 'native', 'windows', 'ssh'].includes(values['browser-host'])) {
    throw new Error('Browser host must be auto, native, windows or ssh');
  }
  const sshKeys = ['ssh-user', 'ssh-port', 'identity-file', 'remote-entry', 'remote-node', 'remote-shell'];
  if (sshKeys.some(key => values[key]) && !values['ssh-host']) throw new Error('SSH options require --ssh-host');
  if (values['ssh-host'] && ['native', 'windows'].includes(values['browser-host'])) throw new Error('--ssh-host conflicts with the selected --browser-host');
  if (values['browser-host'] === 'ssh' && !values['ssh-host']) throw new Error('--browser-host ssh requires --ssh-host');
  if (values['windows-node'] && !values['windows-entry']) throw new Error('--windows-node requires --windows-entry');
  if (values['windows-entry'] && values['ssh-host']) throw new Error('Windows interop options cannot be combined with SSH');
  const hostKeys = ['browser-host', 'windows-entry', 'windows-node', 'ssh-host', ...sshKeys];
  if (command !== 'serve' && hostKeys.some(key => values[key])) throw new Error('Browser-host transport options are supported only by serve');
  if (command !== 'setup' && (values.open || values['browser-path'])) throw new Error('Browser launch options require setup');
  return { command, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value])) };
}

export function browserHostMode(options, runtime = environment()) {
  const requested = options.browserHost ?? 'auto';
  if (options.sshHost) return 'ssh';
  if (requested === 'ssh') throw new Error('--browser-host ssh requires --ssh-host');
  if (requested === 'native') return 'native';
  if (requested === 'windows') {
    if (runtime.platform === 'win32') return 'native';
    if (!runtime.wsl) throw new Error('--browser-host windows is supported only on native Windows or WSL');
    if (!options.windowsEntry) throw new Error('WSL Windows mode requires --windows-entry pointing to the Windows installation');
    return 'windows';
  }
  if (runtime.platform === 'win32' || !runtime.wsl) return 'native';
  if (options.windowsEntry) return 'windows';
  throw new Error('WSL detected. To control Windows Chrome, use --browser-host windows --windows-entry C:\\absolute\\path\\to\\src\\cli.mjs. For a Linux GUI browser in WSL, explicitly use --browser-host native.');
}

async function runProxy(executable, args) {
  const child = spawn(executable, args, { stdio: 'inherit', windowsHide: true });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
      resolvePromise();
    });
  });
}

async function proxySsh(options) {
  await runProxy('ssh', sshArgs({ ...options, herdr: environment().herdr.detected }));
}

async function proxyWindows(options) {
  const { executable, args } = windowsInteropSpec({ ...options, herdr: environment().herdr.detected });
  try {
    await runProxy(executable, args);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Windows interop is unavailable: powershell.exe was not found in WSL. Enable WSL interop or use SSH directly to Windows.');
    }
    throw error;
  }
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
    throw new Error('Specify --browser-path to the visible host browser executable, or open the printed URL manually.');
  }
  await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolvePromise(); });
  });
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) { console.log(HELP); return; }
  if (options.command === 'serve') {
    const mode = browserHostMode(options);
    if (mode === 'ssh') await proxySsh(options);
    else if (mode === 'windows') await proxyWindows(options);
    else { const { serve } = await import('./server.mjs'); await serve(options); }
    return;
  }
  if (options.command === 'setup') {
    console.log(`On the machine displaying Chrome, open ${SETUP_URL}\nEnable remote debugging and approve Chrome's connection prompts.\nFor WSL controlling Windows Chrome, install Node.js 22+ and this package on Windows, then use --browser-host windows with the absolute Windows --windows-entry path.\nFor remote use, install Node.js 22+ and this package on that browser host.\nManually add your PUBLIC SSH key to that user's ~/.ssh/authorized_keys only when using SSH (Windows OpenSSH may use a different configured file).\nVerify host keys yourself. The connector never edits SSH authorization, firewall rules or Chrome settings.`);
    if (options.open) {
      await openSetup(options);
      console.log('Browser launch requested. Confirm that the setup page is visible; internal-page navigation may require opening the URL manually.');
    }
    return;
  }
  const runtime = environment();
  let debugging;
  try { await discoverEndpoint(options); debugging = { discovered: true, verified: false }; }
  catch (error) { debugging = { discovered: false, reason: error.message }; }
  const browserHost = runtime.platform === 'win32' ? { recommended: 'native', reason: 'Native Windows runtime' }
    : runtime.wsl ? { recommended: 'windows', reason: 'WSL cannot use Windows loopback or profile files directly; configure Windows interop for serve' }
      : { recommended: 'native', reason: 'Native desktop runtime' };
  console.log(JSON.stringify({ ...runtime, browserHost, tailscale: await tailscaleStatus(), debugging }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

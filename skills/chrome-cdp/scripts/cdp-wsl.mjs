#!/usr/bin/env node
// WSL adapter for the unchanged upstream CLI. Node.js 22+, no npm dependencies.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';

export function gatewayFromRoutes(text) {
  for (const line of text.trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] !== '00000000' || !/^[0-9A-Fa-f]{8}$/.test(fields[2] ?? '')) continue;
    if (!(Number.parseInt(fields[3], 16) & 2)) continue;
    return fields[2].match(/../g).reverse().map(byte => Number.parseInt(byte, 16)).join('.');
  }
  throw new Error('No WSL IPv4 gateway found. Set CDP_HOST explicitly (127.0.0.1 for mirrored networking).');
}

export function endpointPortFile(version, port) {
  const url = new URL(version.webSocketDebuggerUrl);
  if (url.protocol !== 'ws:' || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(url.pathname) || url.search || url.hash) {
    throw new Error('Chrome returned an invalid browser WebSocket endpoint.');
  }
  // Chrome may advertise localhost. The connection host is supplied separately.
  return `${port}\n${url.pathname}\n`;
}

function runCli(args, env) {
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), 'cdp.mjs');
  const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit', env });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: node scripts/cdp-wsl.mjs <cdp command> [arguments]\nEnvironment: CDP_HOST (default WSL gateway), CDP_PORT (default 9778)\nLaunch Windows Chrome and configure WSL-only forwarding first; see WSL.md.');
    return;
  }
  // Daemon cleanup must also work after Chrome closes or forwarding disappears.
  if (args[0] === 'stop') return runCli(args, process.env);
  const host = process.env.CDP_HOST || gatewayFromRoutes(readFileSync('/proc/net/route', 'utf8'));
  const port = Number(process.env.CDP_PORT || 9778);
  if (isIP(host) !== 4) throw new Error('CDP_HOST must be an IPv4 address.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CDP_PORT must be between 1 and 65535.');
  let version;
  try {
    const response = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    version = await response.json();
  } catch (error) {
    throw new Error(`Cannot reach Windows Chrome at ${host}:${port}: ${error.message}. Keep Chrome open; check the portproxy/firewall and current WSL IPs (WSL.md).`);
  }
  process.umask(0o077);
  const directory = resolve(homedir(), '.cache', 'chrome-cdp-wsl');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const portFile = resolve(directory, `DevToolsActivePort-${host}-${port}`);
  writeFileSync(portFile, endpointPortFile(version, port), { mode: 0o600 });
  runCli(args, { ...process.env, CDP_HOST: host, CDP_PORT_FILE: portFile });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

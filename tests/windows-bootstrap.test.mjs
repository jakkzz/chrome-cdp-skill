import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChromeWindowsExtension } from '../extensions/chrome-windows.mjs';
import {
  encodedPowerShellScript,
  parseWindowsDiscovery,
  powershellArgs,
  windowsDiscoveryScript,
  windowsRuntimeDirectory,
} from '../src/windows-bootstrap.mjs';

test('Windows bootstrap discovery requires Node 22, npm and Chrome without changing host security', () => {
  const script = windowsDiscoveryScript();
  assert.match(script, /Node\.js 22\+/);
  assert.match(script, /Get-Command npm\.cmd/);
  assert.match(script, /Google.*Chrome.*chrome\.exe/s);
  assert.match(script, /\$\{env:ProgramFiles\(x86\)\}/);
  assert.doesNotMatch(script, /firewall|authorized_keys|remote-debugging-port/i);

  const encoded = encodedPowerShellScript(script);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), script);
  assert.deepEqual(powershellArgs('Write-Output ok').slice(0, 4), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
  ]);
});

test('Windows bootstrap validates discovered executable paths and isolates versioned runtimes', () => {
  const discovered = parseWindowsDiscovery(JSON.stringify({
    localAppData: 'C:\\Users\\operator\\AppData\\Local',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    nodeVersion: '22.15.0',
    npmPath: 'C:\\Program Files\\nodejs\\npm.cmd',
    chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  }));
  assert.equal(discovered.nodeVersion, '22.15.0');
  assert.equal(
    windowsRuntimeDirectory(discovered.localAppData, '0123456789abcdef'),
    'C:\\Users\\operator\\AppData\\Local\\pi-chrome-cdp\\runtime-0123456789abcdef',
  );
  assert.throws(() => parseWindowsDiscovery('{}'), /Node\.js 22\+/);
  assert.throws(() => parseWindowsDiscovery(JSON.stringify({ ...discovered, nodeVersion: '20.0.0' })), /Node\.js 22\+/);
  assert.throws(() => windowsRuntimeDirectory('/tmp/not-windows', '0123456789abcdef'), /absolute Windows path/);
});

test('/chrome-windows registers a session-scoped direct MCP server after preparation', async () => {
  const commands = new Map();
  const servers = [];
  const statuses = [];
  const notices = [];
  const pi = {
    on() {},
    registerCommand(name, command) { commands.set(name, command); },
    registerMcpServer(name, config) { servers.push({ name, config }); },
  };
  const prepare = async ({ onProgress }) => {
    onProgress('Preparing…');
    return {
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      windowsEntry: 'C:\\runtime\\src\\cli.mjs',
      chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    };
  };
  createChromeWindowsExtension({ prepare })(pi);
  const command = commands.get('chrome-windows');
  assert.ok(command);
  await command.handler('', {
    ui: {
      setStatus(key, value) { statuses.push({ key, value }); },
      notify(message, level) { notices.push({ message, level }); },
    },
  });

  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, 'chrome-windows');
  assert.equal(servers[0].config.exposure, 'direct');
  assert.deepEqual(servers[0].config.args.slice(-4), [
    '--windows-node', 'C:\\Program Files\\nodejs\\node.exe',
    '--windows-entry', 'C:\\runtime\\src\\cli.mjs',
  ]);
  assert.equal(statuses.at(-1).value, 'Windows MCP registered · connection not verified');
  assert.match(notices.at(-1).message, /Enable remote debugging/);
  assert.match(notices.at(-1).message, /THIS Pi session/);
  assert.match(notices.at(-1).message, /not a verified connection/);
});

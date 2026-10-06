import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delimiter, join } from 'node:path';
import { mkdtemp, mkdir, chmod, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { resolvePowerShell } from '../src/windows-interop.mjs';
import { run } from '../src/windows-bootstrap.mjs';
import { createChromeWindowsExtension } from '../extensions/chrome-windows.mjs';

const fallback = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

test('PowerShell resolves absolute PATH entries first and ignores current-directory entries', () => {
  const seen = [];
  const expected = join('/windows-tools', 'powershell.exe');
  assert.equal(resolvePowerShell({
    env: { PATH: ['', '.', 'relative', '/missing', '/windows-tools'].join(delimiter) },
    available(path) { seen.push(path); return path === expected; },
  }), expected);
  assert.deepEqual(seen, [join('/missing', 'powershell.exe'), expected]);
});

test('PowerShell falls back to the standard WSL Windows mount without changing PATH', () => {
  const env = { PATH: '/usr/bin' };
  assert.equal(resolvePowerShell({ env, available: (path) => path === fallback }), fallback);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(resolvePowerShell({ env: {}, available: (path) => path === fallback }), fallback);
});

test('missing PowerShell gives launcher/interop guidance instead of spawn ENOENT', () => {
  assert.throws(() => resolvePowerShell({ env: {}, available: () => false }), /launcher PATH before starting Pi/);
});

test('PowerShell resolution checks executable files, not directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chrome-powershell-path-'));
  try {
    const first = join(root, 'directory');
    const second = join(root, 'binary');
    await mkdir(join(first, 'powershell.exe'), { recursive: true });
    await mkdir(second);
    await writeFile(join(second, 'powershell.exe'), 'test-only executable fixture');
    await chmod(join(second, 'powershell.exe'), 0o700);
    assert.equal(resolvePowerShell({ env: { PATH: [first, second].join(delimiter) } }), join(second, 'powershell.exe'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bootstrap timeout kills and reaps its owned SIGTERM-resistant child', {
  skip: process.platform === 'win32', timeout: 5000,
}, async () => {
  await assert.rejects(run(process.execPath, ['-e',
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
  ], { timeout: 400 }), (error) => {
    assert.match(error.message, /timed out/);
    assert.match(error.message, /partially completed/);
    assert.equal(error.cause.signal, 'SIGKILL');
    assert.equal(error.cause.killed, true);
    return true;
  });
});

function harness(prepare, { tools = [], idle = true } = {}) {
  let command;
  const servers = [];
  const notices = [];
  const statuses = [];
  const messages = [];
  const handlers = new Map();
  createChromeWindowsExtension({ prepare })({
    on(event, handler) { handlers.set(event, handler); },
    registerCommand(_name, value) { command = value; },
    registerMcpServer(name, config) { servers.push({ name, config }); },
    getAllTools() { return tools; },
    sendUserMessage(message) { messages.push(message); },
  });
  const ctx = { isIdle: () => idle, ui: {
    notify(message, level) { notices.push({ message, level }); },
    setStatus(key, value) { statuses.push({ key, value }); },
  } };
  return {
    invoke: (args = '') => command.handler(args, ctx),
    emit: (type, event) => handlers.get(type)?.({ type, ...event }, ctx),
    servers, notices, statuses, messages,
  };
}

// Explicit offline prerequisite fixture, not a discovered Windows installation.
const setup = {
  nodePath: 'C:\\runtime\\node.exe',
  windowsEntry: 'C:\\runtime\\src\\cli.mjs',
  chromePath: 'C:\\runtime\\chrome.exe',
};

test('config refuses to guess paths or run setup before successful registration', async () => {
  const h = harness(() => { throw new Error('must not prepare'); });
  await h.invoke('config');
  assert.equal(h.servers.length, 0);
  assert.match(h.notices.at(-1).message, /no Windows paths will be guessed/);
  await h.invoke('--unknown');
  assert.match(h.notices.at(-1).message, /Usage:/);
});

test('config prints the exact prepared entry; repeated setup preserves the connection', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return setup; });
  await h.invoke();
  await h.invoke();
  assert.equal(calls, 1);
  assert.equal(h.servers.length, 1);
  await h.invoke('config');
  const notice = h.notices.at(-1).message;
  assert.match(notice, /No settings have been written/);
  assert.match(notice, /takes precedence/);
  const config = JSON.parse(notice.slice(notice.indexOf('\n') + 1));
  assert.deepEqual(config.mcpServers['chrome-windows'], h.servers[0].config);
  assert.equal(config.mcpServers['chrome-windows'].exposure, 'direct');
});

test('concurrent setup is single-flight and a failed setup may be explicitly retried', async () => {
  let reject;
  let calls = 0;
  const h = harness(() => {
    calls++;
    if (calls > 1) return Promise.resolve(setup);
    return new Promise((_resolve, fail) => { reject = fail; });
  });
  const first = h.invoke();
  await h.invoke();
  assert.equal(calls, 1);
  assert.match(h.notices.at(-1).message, /already running/);
  await h.invoke('connect');
  assert.match(h.notices.at(-1).message, /still running/);
  assert.equal(h.messages.length, 0);
  reject(new Error('prerequisite check failed'));
  await first;
  assert.equal(h.servers.length, 0);
  assert.equal(h.statuses.at(-1).value, undefined);
  await h.invoke('config');
  assert.match(h.notices.at(-1).message, /first/);
  await h.invoke();
  assert.equal(h.servers.length, 1);
});

const windowsTools = [
  { name: 'mcp__chrome_windows__chrome_doctor', exposure: 'direct' },
  { name: 'mcp__chrome_windows__chrome_connect', exposure: 'direct' },
];
const neverPrepare = () => { throw new Error('connection commands must not run setup'); };

test('connect uses existing Windows tools, including a file-configured server', async () => {
  const h = harness(neverPrepare, { tools: windowsTools });
  await h.invoke('connect');
  assert.equal(h.servers.length, 0);
  assert.equal(h.messages.length, 1);
  const request = h.messages[0];
  assert.doesNotMatch(request, /^\//); // Must not dispatch another slash command.
  assert.match(request, /mcp__chrome_windows__chrome_doctor once/);
  assert.match(request, /platform other than win32, stop/);
  assert.match(request, /mcp__chrome_windows__chrome_connect once/);
  assert.match(request, /normal tool pipeline/);
  assert.match(request, /Do not list, claim, inspect or modify tabs/);
  assert.match(request, /do not infer approval-needed solely from a timeout/);
  assert.match(request, /retry automatically/);
});

test('status uses doctor only and distinguishes cached state from a fresh handshake', async () => {
  const h = harness(neverPrepare, { tools: [windowsTools[0]] });
  await h.invoke('status');
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /debugging discovery and connected state/);
  assert.match(h.messages[0], /does not perform a fresh CDP handshake/);
  assert.doesNotMatch(h.messages[0], /mcp__chrome_windows__chrome_connect/);
  assert.equal(h.servers.length, 0);
});

test('missing, partial, hidden or other-host tools never trigger setup or fallback', async () => {
  for (const tools of [[], [windowsTools[0]],
    [{ ...windowsTools[0], exposure: 'hidden' }, windowsTools[1]],
    [{ name: 'mcp__chrome__chrome_doctor' }, { name: 'mcp__chrome__chrome_connect' }],
  ]) {
    const h = harness(neverPrepare, { tools });
    await h.invoke('connect');
    assert.equal(h.messages.length, 0);
    assert.equal(h.servers.length, 0);
    assert.match(h.notices.at(-1).message, /not available in this Pi session/);
    assert.match(h.notices.at(-1).message, /Check \/mcp/);
    assert.equal(h.statuses.at(-1).value, 'Windows Chrome · MCP tools unavailable');
  }
});

test('connect and status do not interrupt a busy agent or queue delayed browser work', async () => {
  const h = harness(neverPrepare, { tools: windowsTools, idle: false });
  for (const action of ['connect', 'status']) {
    await h.invoke(action);
    assert.equal(h.messages.length, 0);
    assert.match(h.notices.at(-1).message, /no browser request was queued/);
  }
});

test('footer follows real connection start, successful JSON result and subsequent failure', () => {
  const h = harness(neverPrepare);
  const toolName = windowsTools[1].name;
  assert.equal(h.emit('tool_call', { toolName }), undefined);
  assert.equal(h.statuses.at(-1).value, 'Windows Chrome · connecting…');
  const result = { toolName, isError: false, content: [{ type: 'text', text: '{"connected":true}' }] };
  const before = structuredClone(result);
  assert.equal(h.emit('tool_result', result), undefined);
  assert.deepEqual(result, before);
  assert.equal(h.statuses.at(-1).value, 'Windows Chrome · connected');
  h.emit('tool_result', { toolName, isError: true, content: [{ type: 'text', text: 'Chrome connection timed out' }] });
  assert.equal(h.statuses.at(-1).value, 'Windows Chrome · connection failed');
});

test('footer accepts structured and nested tool results without requiring setup in this runtime', () => {
  const h = harness(neverPrepare);
  h.emit('tool_result', {
    toolName: windowsTools[1].name, parentToolCallId: 'parent', isError: false,
    structuredContent: { connected: true }, content: [],
  });
  assert.equal(h.statuses.at(-1).value, 'Windows Chrome · connected');
  assert.equal(h.servers.length, 0);
  assert.equal(h.messages.length, 0);
});

test('doctor refresh updates connected, disconnected, wrong-host and failed footer states', () => {
  const h = harness(neverPrepare);
  const toolName = windowsTools[0].name;
  h.emit('tool_call', { toolName });
  assert.equal(h.statuses.at(-1).value, 'Windows Chrome · checking status…');
  for (const [structuredContent, state] of [
    [{ platform: 'win32', debugging: { connected: true } }, 'connected'],
    [{ platform: 'win32', debugging: { connected: false } }, 'not connected'],
    [{ platform: 'darwin', debugging: { connected: true } }, 'wrong host'],
    [{ platform: 'win32' }, 'status unavailable'],
  ]) {
    h.emit('tool_result', { toolName, isError: false, structuredContent });
    assert.equal(h.statuses.at(-1).value, `Windows Chrome · ${state}`);
  }
  h.emit('tool_result', { toolName, isError: true, structuredContent: { platform: 'win32', debugging: { connected: true } } });
  assert.equal(h.statuses.at(-1).value, 'Windows Chrome · status check failed');
});

test('malformed or nonboolean results never leave a stale connected footer', () => {
  const h = harness(neverPrepare);
  const toolName = windowsTools[1].name;
  for (const result of [
    { content: [{ type: 'text', text: 'not JSON' }] },
    { structuredContent: null },
    { structuredContent: [] },
    { structuredContent: { connected: 'true' } },
    { structuredContent: {} },
  ]) {
    h.emit('tool_result', { toolName, isError: false, structuredContent: { connected: true } });
    h.emit('tool_result', { toolName, isError: false, ...result });
    assert.equal(h.statuses.at(-1).value, 'Windows Chrome · status unavailable');
  }
  h.emit('tool_result', { toolName, isError: false, structuredContent: { connected: false } });
  assert.equal(h.statuses.at(-1).value, 'Windows Chrome · not connected');
});

test('unrelated browsers and tab errors cannot overwrite the Windows footer', () => {
  const h = harness(neverPrepare);
  h.emit('tool_result', { toolName: windowsTools[1].name, isError: false, structuredContent: { connected: true } });
  const count = h.statuses.length;
  for (const toolName of ['mcp__chrome__chrome_connect', 'mcp__chrome_windows__chrome_click', 'bash']) {
    h.emit('tool_call', { toolName });
    h.emit('tool_result', { toolName, isError: true, content: [] });
  }
  assert.equal(h.statuses.length, count);
  assert.equal(h.statuses.at(-1).value, 'Windows Chrome · connected');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createChromeServer, textResult } from '../src/server.mjs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('large text results remain valid bounded JSON instead of cutting a string mid-token', () => {
  const result = textResult({ text: 'x'.repeat(110000) });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.preview.length, 40000);
  assert.ok(result.content[0].text.length < 100000);
});
async function memoryClient(options) {
  const { server, cleanup } = createChromeServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'chrome-mcp-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await cleanup(); await server.close(); } };
}

test('real MCP initialization advertises bounded tools; evaluation is opt-in', async () => {
  for (const allowEvaluate of [false, true]) {
    const { client, close } = await memoryClient({ allowEvaluate });
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.some(tool => tool.name === 'chrome_evaluate'), allowEvaluate);
      assert.ok(tools.some(tool => tool.name === 'chrome_claim'));
      assert.ok(tools.some(tool => tool.name === 'chrome_release'));
      assert.equal(tools.find(tool => tool.name === 'chrome_navigate').annotations.destructiveHint, true);
      assert.equal(tools.find(tool => tool.name === 'chrome_snapshot').annotations.readOnlyHint, true);
      for (const name of ['chrome_scroll', 'chrome_drag', 'chrome_select']) {
        assert.equal(tools.find(tool => tool.name === name).annotations.destructiveHint, true);
      }
      assert.equal(tools.find(tool => tool.name === 'chrome_wait').annotations.readOnlyHint, true);
      for (const [name, args] of [
        ['chrome_wait', { timeoutMs: 20001 }],
        ['chrome_drag', { steps: 61 }],
        ['chrome_scroll', { deltaY: 10001 }],
        ['chrome_select', { selector: '#select', values: ['x'.repeat(10001)] }],
      ]) {
        const rejected = await client.callTool({ name, arguments: { targetId: 'target', ...args } });
        assert.equal(rejected.isError, true);
      }
      const invalid = await client.callTool({ name: 'chrome_navigate', arguments: { targetId: 'target', url: 'javascript:alert(1)' } });
      assert.equal(invalid.isError, true);
      const invalidTarget = await client.callTool({ name: 'chrome_claim', arguments: { targetId: '../escape' } });
      assert.equal(invalidTarget.isError, true);
    } finally { await close(); }
  }
});

test('stdio MCP works without Chrome, fails clearly on connection and keeps stdout protocol-only', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chrome-mcp-'));
  const client = new Client({ name: 'chrome-stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'serve', '--browser-host', 'native', '--port-file', join(directory, 'missing')], stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.length > 0);
    const result = await client.callTool({ name: 'chrome_connect', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /ENOENT/);
    const doctor = await client.callTool({ name: 'chrome_doctor', arguments: {} });
    assert.ok(!doctor.isError);
    const state = JSON.parse(doctor.content[0].text);
    assert.equal(state.debugging.discovered, false);
    assert.equal(typeof state.tailscale.connected, 'boolean');
    assert.equal(state.setupUrl, 'chrome://inspect/#remote-debugging');
    assert.equal(stderr, '');
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

test('WSL Windows interop preserves MCP stdio through the host launcher', { timeout: 20000, skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chrome-wsl-mcp-'));
  const bin = join(directory, 'bin');
  const missing = join(directory, 'missing');
  await mkdir(bin);
  const launcher = join(bin, 'powershell.exe');
  await writeFile(launcher, '#!/bin/sh\nexec "$FAKE_NODE" "$FAKE_ENTRY" serve --browser-host native --port-file "$FAKE_PORT_FILE"\n');
  await chmod(launcher, 0o755);

  const client = new Client({ name: 'chrome-wsl-stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'serve', '--browser-host', 'windows', '--windows-entry', 'C:\\runtime\\src\\cli.mjs'],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      WSL_DISTRO_NAME: 'test-wsl',
      FAKE_NODE: process.execPath,
      FAKE_ENTRY: fileURLToPath(new URL('../src/cli.mjs', import.meta.url)),
      FAKE_PORT_FILE: missing,
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'chrome_connect'));
    const result = await client.callTool({ name: 'chrome_connect', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /ENOENT/);
    assert.equal(stderr, '');
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});
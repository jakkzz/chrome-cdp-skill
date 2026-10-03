import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { TabLeases } from '../src/leases.mjs';

const endpoint = 'ws://127.0.0.1:9222/devtools/browser/lease-test';

test('tab ownership is shared by independent managers and loopback aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chrome-leases-'));
  const first = new TabLeases(endpoint, { directory });
  const second = new TabLeases(endpoint.replace('127.0.0.1', 'localhost'), { directory });
  try {
    await assert.rejects(first.assert('target-one'), /Claim/);
    await first.claim('target-one');
    await first.claim('target-one');
    await first.assert('target-one');
    await assert.rejects(second.claim('target-one'), /another MCP session/);
    await second.claim('target-two');
    await first.release('target-one');
    await second.claim('target-one');
    await assert.rejects(first.assert('target-one'), /Claim/);
    await assert.rejects(first.claim('../escape'), /Invalid/);
  } finally {
    await first.close(); await second.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('separate processes cannot own the same browser-host tab', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chrome-process-leases-'));
  const parent = new TabLeases(endpoint, { directory });
  const source = `import { TabLeases } from ${JSON.stringify(new URL('../src/leases.mjs', import.meta.url).href)};
    const leases = new TabLeases(${JSON.stringify(endpoint)}, { directory: ${JSON.stringify(directory)} });
    await leases.claim('shared-target');
    console.log('claimed');
    process.stdin.resume();
    process.stdin.once('end', async () => { await leases.close(); process.exit(0); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const exit = once(child, 'exit');
  try {
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Lease child not ready: ${errors}`)), 5000);
      child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Lease child exited ${code}: ${errors}`)); });
    });
    await ready;
    await assert.rejects(parent.claim('shared-target'), /another MCP session/);
    child.stdin.end();
    const [code] = await exit;
    assert.equal(code, 0, errors);
    await parent.claim('shared-target');
    await parent.assert('shared-target');
  } finally {
    if (child.exitCode === null) { child.kill(); await exit; }
    await parent.close(); await rm(directory, { recursive: true, force: true });
  }
});

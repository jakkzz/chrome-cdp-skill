import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { forwardedWsUrl, readForwardedConfig } from '../skills/chrome-cdp/scripts/cdp.mjs';

test('skill CLI runs through a global Codex skill directory symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chrome-cdp-global-'));
  const installed = join(directory, 'chrome-cdp');
  try {
    await symlink(fileURLToPath(new URL('../skills/chrome-cdp/', import.meta.url)), installed,
      process.platform === 'win32' ? 'junction' : 'dir');
    const runtime = join(directory, 'runtime');
    await mkdir(runtime);
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      [join(installed, 'scripts', 'cdp.mjs'), '--help'], {
        cwd: directory, timeout: 5000,
        env: { ...process.env, XDG_RUNTIME_DIR: runtime, LOCALAPPDATA: runtime },
      });
    assert.match(stdout, /TARGET SELECTION/);
    assert.equal(stderr, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

test('skill CLI reads an operator descriptor and rewrites the browser-advertised port', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chrome-cdp-forwarded-'));
  const descriptor = join(directory, 'forwarded.json');
  const server = createServer((request, response) => {
    assert.equal(request.url, '/json/version');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      Browser: 'Chrome/Test',
      webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/test-id',
    }));
  });

  try {
    const port = await listen(server);
    await writeFile(descriptor, JSON.stringify({
      version: 1,
      port,
      approvedOrigin: 'https://studio.example.test',
    }));
    assert.deepEqual(readForwardedConfig(descriptor), {
      version: 1,
      port,
      approvedOrigin: 'https://studio.example.test',
    });
    assert.equal(
      await forwardedWsUrl(descriptor),
      `ws://127.0.0.1:${port}/devtools/browser/test-id`,
    );
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('skill CLI rejects malformed forwarded descriptors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chrome-cdp-forwarded-'));
  const descriptor = join(directory, 'forwarded.json');
  try {
    await writeFile(descriptor, JSON.stringify({ version: 1, port: 9778, approvedOrigin: 'file:///tmp/private' }));
    assert.throws(() => readForwardedConfig(descriptor), /approved origin/);
    await writeFile(descriptor, JSON.stringify({ version: 1, port: 0, approvedOrigin: 'https://studio.example.test' }));
    assert.throws(() => readForwardedConfig(descriptor), /Invalid forwarded/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

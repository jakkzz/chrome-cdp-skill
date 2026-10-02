import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatewayFromRoutes, endpointPortFile } from '../skills/chrome-cdp/scripts/cdp-wsl.mjs';

test('stop works without contacting Chrome or validating connection settings', () => {
  const cli = fileURLToPath(new URL('../skills/chrome-cdp/scripts/cdp-wsl.mjs', import.meta.url));
  // Isolate runtime state: never stop the developer's live daemons.
  const runtime = mkdtempSync(join(tmpdir(), 'cdp-wsl-test-'));
  try {
    const result = spawnSync(process.execPath, [cli, 'stop', 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtime, LOCALAPPDATA: runtime,
        CDP_HOST: 'invalid-host', CDP_PORT: 'invalid-port' },
      encoding: 'utf8', timeout: 3000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Cannot reach|CDP_HOST must|CDP_PORT must/);
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('finds the little-endian WSL gateway, not the DNS tunneling nameserver', () => {
  assert.equal(gatewayFromRoutes('Iface Destination Gateway Flags\neth0 00000000 018011AC 0003\n'), '172.17.128.1');
});
test('skips non-default and non-gateway routes', () => {
  assert.equal(gatewayFromRoutes('Iface Destination Gateway Flags\neth0 00000000 00000000 0001\neth0 008011AC 00000000 0001\neth0 00000000 0100000A 0003\n'), '10.0.0.1');
  assert.throws(() => gatewayFromRoutes('Iface Destination Gateway Flags\n'), /CDP_HOST/);
});
test('refreshes the browser UUID and uses the configured forwarded port', () => {
  assert.equal(endpointPortFile({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/new-uuid' }, 9778), '9778\n/devtools/browser/new-uuid\n');
});
test('rejects malformed or non-browser endpoints', () => {
  for (const url of ['wss://localhost/devtools/browser/a', 'ws://localhost/devtools/page/a', 'ws://localhost/devtools/browser/a?x=1', 'not-a-url']) {
    assert.throws(() => endpointPortFile({ webSocketDebuggerUrl: url }, 9778));
  }
});

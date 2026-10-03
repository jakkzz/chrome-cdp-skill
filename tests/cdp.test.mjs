import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { BrowserConnection } from '../src/cdp.mjs';

// Exercise actual CDP Runtime over a Node inspector WebSocket. This verifies the
// transport, not Chrome-specific Target/Page behavior or live desktop visibility.
test('persistent CDP transport sends real Runtime commands and does not retry after close', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const exit = once(child, 'exit');
  let browser;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let stderr = '';
      const timer = setTimeout(() => reject(new Error(`Inspector startup timed out: ${stderr}`)), 5000);
      child.stderr.on('data', chunk => {
        stderr += chunk;
        const match = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-zA-Z0-9-]+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Inspector exited before startup')); });
    });
    browser = new BrowserConnection(endpoint, { timeout: 1000 });
    await Promise.all([browser.connect(), browser.connect()]);
    const first = await browser.send('Runtime.evaluate', { expression: '2 + 3', returnByValue: true });
    assert.equal(first.result.value, 5);
    const results = await Promise.all([browser.send('Runtime.evaluate', { expression: '6 * 7', returnByValue: true }), browser.send('Runtime.evaluate', { expression: '8 * 9', returnByValue: true })]);
    assert.deepEqual(results.map(result => result.result.value), [42, 72]);
    await assert.rejects(browser.send('Runtime.nonexistentMethod'), /found/);
    await assert.rejects(browser.send('Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true }), /timed out/);
    const expired = Date.now() - 1;
    await assert.rejects(browser.send('Runtime.evaluate', { expression: '1' }, undefined, { deadline: expired }), /no command was sent/);
    const shortStart = Date.now();
    await assert.rejects(browser.send('Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true }, undefined, { deadline: Date.now() + 100 }), /timed out/);
    assert.ok(Date.now() - shortStart < 500);
    const abort = new AbortController();
    const cancelled = browser.send('Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true }, undefined, { signal: abort.signal });
    const timer = setTimeout(() => abort.abort(), 50);
    try { await assert.rejects(cancelled, /cancelled/); } finally { clearTimeout(timer); }
    const next = await browser.send('Runtime.evaluate', { expression: '3 + 4', returnByValue: true });
    assert.equal(next.result.value, 7);
    browser.close();
    await assert.rejects(browser.send('Runtime.evaluate', { expression: '1' }), /No operation was retried/);
  } finally {
    browser?.close(); child.kill(); await exit;
  }
});

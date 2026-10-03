import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const executable = process.env.CHROME_TEST_EXECUTABLE;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Opt-in real Chrome, separate temporary profile, sandbox kept enabled. The page
// is a local DOM interaction test document, not fabricated backend/traffic data.
test('real Chrome through two stdio MCP clients: control, conflicts and cleanup', {
  skip: !executable && 'Set CHROME_TEST_EXECUTABLE to a reviewed local Chrome executable', timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chrome-live-'));
  const profile = join(directory, 'profile');
  const portFile = join(profile, 'DevToolsActivePort');
  const pageServer = createServer((_, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>CDP interaction test</title>
      <style>body { margin: 12px; } section { margin: 8px 0; } #wheel { height: 80px; width: 220px; overflow: auto; } #wheel-content { height: 1000px; } #drag-source, #drop-target { width: 220px; height: 32px; background: #ddd; user-select: none; } .hidden { display: none; }</style>
      <button id="click" onclick="this.textContent='Clicked'">Click</button><input id="text" aria-label="Text input">
      <section><select id="dropdown" aria-label="Native dropdown" onchange="document.querySelector('#selection-result').textContent='Selected ' + this.value"><option value="first">First</option><option value="second">Second</option><option value="locked" disabled>Locked</option><optgroup label="Disabled group" disabled><option value="grouped">Grouped</option></optgroup></select><span id="selection-result"></span></section>
      <section><select id="multi" aria-label="Multiple selection" multiple><option value="first">First</option><option value="second">Second</option><option value="third">Third</option></select><select id="disabled" disabled><option value="first">First</option></select><select id="duplicate"><option value="same">One</option><option value="same">Two</option></select></section>
      <section id="custom" role="combobox" tabindex="0">Custom dropdown</section>
      <section id="wheel"><div id="wheel-content">Scrollable pane</div></section><span id="scroll-result"></span>
      <section id="drag-source">Drag source</section><section id="drop-target">Drop target</section><span id="drag-result"></span>
      <div id="late" class="hidden">Delayed content</div><div id="always-hidden" class="hidden">Hidden content</div>
      <script>
        let dragging = false;
        document.querySelector('#drag-source').addEventListener('pointerdown', () => { dragging = true; document.querySelector('#drag-result').textContent = 'Dragging'; });
        document.addEventListener('pointerup', event => { if (dragging) document.querySelector('#drag-result').textContent = document.querySelector('#drop-target').contains(event.target) ? 'Pointer drag completed' : 'Pointer released'; dragging = false; });
        document.querySelector('#wheel').addEventListener('scroll', event => { document.querySelector('#scroll-result').textContent = event.target.scrollTop > 0 ? 'Pane scrolled' : 'Pane at top'; });
        setTimeout(() => { document.querySelector('#late').classList.remove('hidden'); }, 400);
      </script>`);
  });
  pageServer.listen(0, '127.0.0.1');
  await once(pageServer, 'listening');
  const url = `http://127.0.0.1:${pageServer.address().port}/`;
  const chrome = spawn(executable, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--password-store=basic', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const exit = once(chrome, 'exit');
  let logs = '';
  chrome.stderr.on('data', chunk => { logs += chunk; });
  const clients = [];
  async function client() {
    const client = new Client({ name: 'chrome-live-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'serve', '--port-file', portFile],
      env: { ...process.env, XDG_CACHE_HOME: join(directory, 'cache'), LOCALAPPDATA: join(directory, 'cache') }, stderr: 'pipe' }));
    return client;
  }
  async function call(client, name, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content[0]?.text);
    return result;
  }
  async function waitSnapshot(client, targetId, expected) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const snapshot = await call(client, 'chrome_snapshot', { targetId });
      if (snapshot.content[0].text.includes(expected)) return;
      await delay(50);
    }
    assert.fail(`Chrome accessibility tree never included ${expected}`);
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (chrome.exitCode !== null) throw new Error(`Chrome exited: ${logs}`);
      try { await readFile(portFile); ready = true; break; } catch { await delay(50); }
    }
    assert.ok(ready, `Chrome port file not ready: ${logs}`);
    const first = await client();
    const second = await client();
    const connected = JSON.parse((await call(first, 'chrome_connect')).content[0].text);
    assert.equal(connected.connected, true);
    const tabs = JSON.parse((await call(first, 'chrome_tabs')).content[0].text).tabs;
    assert.ok(tabs.length > 0);
    const targetId = tabs.find(tab => tab.url === 'about:blank').targetId;
    const unowned = await second.callTool({ name: 'chrome_snapshot', arguments: { targetId } });
    assert.equal(unowned.isError, true);
    await call(first, 'chrome_claim', { targetId });
    const conflict = await second.callTool({ name: 'chrome_claim', arguments: { targetId } });
    assert.equal(conflict.isError, true);
    assert.match(conflict.content[0].text, /another MCP session/);
    for (const [name, args] of [
      ['chrome_scroll', { deltaY: 100 }],
      ['chrome_drag', { fromX: 10, fromY: 10, toX: 20, toY: 20 }],
      ['chrome_select', { selector: '#dropdown', values: ['second'] }],
      ['chrome_wait', {}],
    ]) {
      const rejected = await second.callTool({ name, arguments: { targetId, ...args } });
      assert.equal(rejected.isError, true);
      assert.match(rejected.content[0].text, /Claim this tab/);
    }
    await call(first, 'chrome_navigate', { targetId, url });
    const documentReady = JSON.parse((await call(first, 'chrome_wait', { targetId, url, selector: '#text', readyState: 'interactive' })).content[0].text);
    assert.equal(documentReady.ready, true);
    await call(first, 'chrome_wait', { targetId, selector: '#late', text: 'Delayed content', url, readyState: 'complete' });
    await waitSnapshot(first, targetId, 'Text input');
    await call(first, 'chrome_click', { targetId, selector: '#click' });
    await waitSnapshot(first, targetId, 'Clicked');
    await call(first, 'chrome_click', { targetId, selector: '#text' });
    await call(first, 'chrome_type', { targetId, text: 'MCP text insertion' });
    await waitSnapshot(first, targetId, 'MCP text insertion');
    await call(first, 'chrome_key', { targetId, key: 'Tab' });
    const image = await call(first, 'chrome_screenshot', { targetId });
    assert.equal(image.content[0].type, 'image');
    assert.equal(Buffer.from(image.content[0].data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const selected = JSON.parse((await call(first, 'chrome_select', { targetId, selector: '#dropdown', values: ['second'] })).content[0].text);
    assert.deepEqual(selected.selectedValues, ['second']);
    const byLabel = JSON.parse((await call(first, 'chrome_select', { targetId, selector: '#dropdown', labels: ['First'] })).content[0].text);
    assert.deepEqual(byLabel.selectedValues, ['first']);
    assert.deepEqual(byLabel.selectedLabels, ['First']);
    await call(first, 'chrome_select', { targetId, selector: '#dropdown', values: ['second'] });
    await call(first, 'chrome_wait', { targetId, text: 'Selected second' });
    const multiple = JSON.parse((await call(first, 'chrome_select', { targetId, selector: '#multi', values: ['first', 'third'] })).content[0].text);
    assert.deepEqual(multiple.selectedValues, ['first', 'third']);
    const cleared = JSON.parse((await call(first, 'chrome_select', { targetId, selector: '#multi', values: [] })).content[0].text);
    assert.deepEqual(cleared.selectedValues, []);
    for (const [selector, values, pattern] of [
      ['#dropdown', ['missing'], /exactly one option/],
      ['#dropdown', ['locked'], /disabled/],
      ['#dropdown', ['grouped'], /disabled/],
      ['#dropdown', [], /exactly one value/],
      ['#dropdown', ['first', 'second'], /exactly one value/],
      ['#multi', ['first', 'first'], /unique/],
      ['#disabled', ['first'], /disabled/],
      ['#duplicate', ['same'], /exactly one option/],
      ['#custom', ['first'], /Only native HTML select/],
    ]) {
      const rejected = await first.callTool({ name: 'chrome_select', arguments: { targetId, selector, values } });
      assert.equal(rejected.isError, true);
      assert.match(rejected.content[0].text, pattern);
    }
    const wheel = JSON.parse((await call(first, 'chrome_scroll', { targetId, selector: '#wheel', deltaY: 150 })).content[0].text);
    await call(first, 'chrome_wait', { targetId, text: 'Pane scrolled' });
    await call(first, 'chrome_scroll', { targetId, x: wheel.x, y: wheel.y, deltaY: -150 });
    await call(first, 'chrome_wait', { targetId, text: 'Pane at top' });
    const pointer = JSON.parse((await call(first, 'chrome_drag', { targetId, fromSelector: '#drag-source', toSelector: '#drop-target', durationMs: 100 })).content[0].text);
    await call(first, 'chrome_wait', { targetId, text: 'Pointer drag completed' });
    await call(first, 'chrome_drag', { targetId, fromX: pointer.from.x, fromY: pointer.from.y, toX: pointer.to.x, toY: pointer.to.y, durationMs: 0 });
    await call(first, 'chrome_wait', { targetId, text: 'Pointer drag completed' });
    for (const [name, args, pattern] of [
      ['chrome_scroll', { deltaY: 0 }, /non-zero/],
      ['chrome_scroll', { deltaY: 10, x: 1 }, /both x and y/],
      ['chrome_scroll', { deltaY: 10, selector: '#wheel', x: 1, y: 1 }, /not both/],
      ['chrome_scroll', { deltaY: 10, x: 1000000, y: 1000000 }, /outside the CSS viewport/],
      ['chrome_drag', { fromSelector: '#drag-source' }, /Supply a selector or coordinates/],
      ['chrome_select', { selector: '#dropdown', values: ['first'], labels: ['First'] }, /exactly one of values or labels/],
      ['chrome_select', { selector: '#dropdown', labels: ['Absent label'] }, /exactly one option/],
    ]) {
      const rejected = await first.callTool({ name, arguments: { targetId, ...args } });
      assert.equal(rejected.isError, true);
      assert.match(rejected.content[0].text, pattern);
    }
    const hiddenStart = Date.now();
    const hidden = await first.callTool({ name: 'chrome_wait', arguments: { targetId, selector: '#always-hidden', timeoutMs: 200 } });
    assert.equal(hidden.isError, true);
    assert.match(hidden.content[0].text, /readiness timed out/);
    assert.ok(Date.now() - hiddenStart < 2000);
    const ambiguous = await first.callTool({ name: 'chrome_wait', arguments: { targetId, selector: 'section' } });
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.content[0].text, /exactly one element/);
    const waitAbort = new AbortController();
    const waiting = first.callTool({ name: 'chrome_wait', arguments: { targetId, text: 'Absent wait text', timeoutMs: 20000 } }, undefined, { signal: waitAbort.signal });
    const abortWait = setTimeout(() => waitAbort.abort(), 150);
    try { await assert.rejects(waiting); } finally { clearTimeout(abortWait); }
    await call(first, 'chrome_wait', { targetId, selector: '#text', timeoutMs: 1000 });
    const dragAbort = new AbortController();
    const dragging = first.callTool({ name: 'chrome_drag', arguments: { targetId, fromSelector: '#drag-source', toSelector: '#drop-target', durationMs: 2000 } }, undefined, { signal: dragAbort.signal });
    const abortDrag = setTimeout(() => dragAbort.abort(), 150);
    try { await assert.rejects(dragging); } finally { clearTimeout(abortDrag); }
    await call(first, 'chrome_wait', { targetId, text: 'Pointer released', timeoutMs: 1000 });
    const opened = JSON.parse((await call(first, 'chrome_open', { url })).content[0].text);
    await call(first, 'chrome_close_tab', { targetId: opened.targetId });
    await call(first, 'chrome_release', { targetId });
    await call(second, 'chrome_claim', { targetId });
    await call(second, 'chrome_release', { targetId });
    await call(first, 'chrome_claim', { targetId });
    // Client disconnect must release a lease without waiting for the stale interval.
    await first.close();
    await call(second, 'chrome_claim', { targetId });
    await call(second, 'chrome_release', { targetId });
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    chrome.kill(); await exit;
    await new Promise(resolve => pageServer.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

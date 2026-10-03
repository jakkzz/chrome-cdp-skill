import lockfile from 'proper-lockfile';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function leaseDirectory(env = process.env) {
  const base = platform() === 'win32'
    ? env.LOCALAPPDATA || resolve(homedir(), 'AppData/Local')
    : env.XDG_CACHE_HOME || resolve(homedir(), '.cache');
  return resolve(base, 'chrome-cdp-mcp', 'leases');
}

// All MCP processes for a browser must run as its OS user, with the same directory.
// In SSH mode these files live on the browser host, not the agent machine.
export class TabLeases {
  #held = new Map();
  constructor(endpoint, { directory = leaseDirectory(), stale = 120000, update = 10000 } = {}) {
    this.endpoint = endpoint;
    this.directory = directory;
    this.owner = randomUUID();
    this.stale = stale;
    this.update = update;
  }

  #path(targetId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(targetId)) throw new Error('Invalid full target ID');
    // Browser UUID distinguishes restarted Chrome; canonicalize loopback aliases.
    const browser = new URL(this.endpoint).pathname;
    return resolve(this.directory, createHash('sha256').update(`${browser}:${targetId}`).digest('hex'));
  }

  async claim(targetId) {
    if (this.#held.has(targetId)) { await this.assert(targetId); return { targetId, owner: this.owner }; }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.#path(targetId);
    const file = await open(path, 'a', 0o600);
    await file.close();
    const record = { valid: true, path, release: undefined };
    try {
      record.release = await lockfile.lock(path, {
        realpath: false, retries: 0, stale: this.stale, update: this.update,
        onCompromised: () => { record.valid = false; },
      });
    } catch (error) {
      if (error.code === 'ELOCKED') throw new Error('Tab is owned by another MCP session. Ask that agent to release it; no forced takeover is offered.');
      throw error;
    }
    try { await writeFile(path, this.owner, { mode: 0o600 }); }
    catch (error) { await record.release(); throw error; }
    this.#held.set(targetId, record);
    return { targetId, owner: this.owner };
  }

  async assert(targetId) {
    const record = this.#held.get(targetId);
    if (!record?.valid) throw new Error('Claim this tab before accessing it; its lease is absent or compromised.');
    if (await readFile(record.path, 'utf8') !== this.owner) {
      record.valid = false;
      throw new Error('Tab ownership changed. This session must stop using the tab.');
    }
    if (!record.valid) throw new Error('Tab lease was compromised');
  }

  async release(targetId) {
    const record = this.#held.get(targetId);
    if (!record) return;
    this.#held.delete(targetId);
    if (record.valid) await record.release();
  }

  owned() { return [...this.#held.keys()]; }

  async close() {
    const results = await Promise.allSettled(this.owned().map(targetId => this.release(targetId)));
    for (const result of results) if (result.status === 'rejected') console.error(`Lease cleanup failed: ${result.reason.message}`);
  }
}

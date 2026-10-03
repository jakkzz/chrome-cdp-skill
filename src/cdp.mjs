export class BrowserConnection {
  #socket;
  #pending = new Map();
  #sessions = new Map();
  #nextId = 0;
  #connecting;
  #closed = false;

  constructor(endpoint, { timeout = 15000 } = {}) {
    this.endpoint = endpoint;
    this.timeout = timeout;
  }

  async connect() {
    if (this.#closed) throw new Error('Browser connection closed; restart MCP after reconnecting Chrome. No operation was retried.');
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    if (this.#connecting) return this.#connecting;
    this.#connecting = new Promise((resolve, reject) => {
      const socket = this.#socket = new WebSocket(this.endpoint);
      const timer = setTimeout(() => { reject(new Error('Chrome connection timed out; check debugging approval')); this.close(); }, this.timeout);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome WebSocket connection failed')); this.close(); }, { once: true });
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        reject(new Error('Chrome disconnected'));
        this.#closed = true;
        this.#rejectPending(new Error('Chrome disconnected. An in-flight action may have completed; do not repeat it blindly.'));
        this.#sessions.clear();
      });
      socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { this.close(); return; }
        if (message.method === 'Target.detachedFromTarget') {
          for (const [target, session] of this.#sessions) {
            if (session === message.params?.sessionId) this.#sessions.delete(target);
          }
        }
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        pending.cleanup();
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      });
    });
    try { await this.#connecting; } finally { this.#connecting = undefined; }
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(error); }
    this.#pending.clear();
  }

  async send(method, params = {}, sessionId, { deadline, signal } = {}) {
    signal?.throwIfAborted();
    await this.connect();
    signal?.throwIfAborted();
    const timeout = deadline === undefined ? this.timeout : Math.min(this.timeout, deadline - Date.now());
    if (timeout <= 0) throw new Error(`CDP ${method} deadline expired; no command was sent`);
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      const fail = error => { cleanup(); this.#pending.delete(id); reject(error); };
      const onAbort = () => fail(new Error(`CDP ${method} cancelled. A sent command may have completed; do not repeat it blindly.`));
      timer = setTimeout(() => fail(new Error(`CDP ${method} timed out. The action may have completed; inspect state before repeating.`)), timeout);
      this.#pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', onAbort, { once: true });
      try { this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { fail(error); }
    });
  }

  async tabs() {
    const { targetInfos } = await this.send('Target.getTargets');
    return targetInfos.filter(target => target.type === 'page').map(({ targetId, title, url }) => ({ targetId, title, url }));
  }

  async attach(targetId, options) {
    if (!this.#sessions.has(targetId)) {
      const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, undefined, options);
      this.#sessions.set(targetId, sessionId);
    }
    return this.#sessions.get(targetId);
  }

  async page(targetId, method, params = {}, options) {
    return this.send(method, params, await this.attach(targetId, options), options);
  }

  async detach(targetId) {
    const sessionId = this.#sessions.get(targetId);
    this.#sessions.delete(targetId);
    if (sessionId && !this.#closed) await this.send('Target.detachFromTarget', { sessionId });
  }

  close() {
    this.#closed = true;
    this.#rejectPending(new Error('Browser connection closed'));
    this.#socket?.close();
    this.#sessions.clear();
  }
}

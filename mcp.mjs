import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class McpClient {
  constructor(executable, { timeout = 40000 } = {}) {
    this.executable = executable;
    this.timeout = timeout;
    this.pending = new Map();
    this.nextId = 1;
  }
  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.start().catch(error => { this.ready = null; throw error; });
    return this.ready;
  }
  async start() {
    const child = spawn(this.executable, ['mcp'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ZERON_CHAT_ID: '', ZERON_DEVICE_ID: '' },
    });
    this.child = child;
    const fail = error => {
      if (this.child !== child) return;
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
      this.pending.clear();
      if (this.child === child) { this.child = null; this.ready = null; }
    };
    child.on('error', fail);
    child.on('exit', () => fail(new Error('Zeron MCP stopped. Check that Zeron is open.')));
    // Drain stderr; never expose authentication or transcript data in bridge logs.
    child.stderr.on('data', () => {});
    createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'MCP request failed'));
      else pending.resolve(message.result);
    });
    let info;
    try { info = await this.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'zeroncourier', version: '1.0.0' },
    }); } catch (error) { child.kill(); throw error; }
    this.notify('notifications/initialized');
    this.serverInfo = info.serverInfo;
    return info;
  }
  notify(method, params) {
    this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n');
  }
  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin.writable) return reject(new Error('Zeron MCP is unavailable.'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Never automatically retry a timed-out send: its outcome may be unknown.
        reject(new Error('Zeron did not answer in time. Check the chat before retrying a send.'));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  async call(name, args = {}) {
    await this.connect();
    const result = await this.request('tools/call', { name, arguments: args });
    if (result?.isError) {
      throw new Error(result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || 'Zeron tool failed');
    }
    if (result?.structuredContent !== undefined) return result.structuredContent;
    const value = result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
    try { return JSON.parse(value); } catch { return { text: value }; }
  }
  close() {
    this.child?.stdin.end();
    const child = this.child;
    setTimeout(() => { if (child && child.exitCode === null) child.kill(); }, 1000).unref();
  }
}

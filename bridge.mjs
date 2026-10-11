import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpClient } from './mcp.mjs';
import { ZeronCourier, ZeronCourierError } from './core.mjs';

const folder = dirname(fileURLToPath(import.meta.url));
const defaultStateDir = resolve(folder, 'work/zeroncourier-runtime');
const defaultExecutable = 'zeron';
export const safeTokenEqual = (value, token) => {
  const a = Buffer.from(value || ''), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};
export async function createBridge({ mcp, token, stateDir = defaultStateDir, state, port = 8787, persist } = {}) {
  await mkdir(stateDir, { recursive: true });
  const configPath = resolve(stateDir, 'config.json');
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!config) {
    config = { token: token || randomBytes(32).toString('hex'), executable: process.env.ZERON_EXECUTABLE || defaultExecutable, projectName: process.env.ZERON_PROJECT_NAME || 'InternTrack' };
    await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
  token ||= config.token;
  mcp ||= new McpClient(process.env.ZERON_EXECUTABLE || config.executable);
  const statePath = resolve(stateDir, 'jobs.json');
  if (!state) {
    try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; state = { jobs: {} }; }
  }
  // A crash after persisting a send leaves uncertain delivery; never replay it.
  for (const job of Object.values(state.jobs)) if (job.status === 'sending') job.status = 'delivery-unknown';
  let saveChain = Promise.resolve();
  persist ||= snapshot => {
    const json = JSON.stringify(snapshot);
    saveChain = saveChain.catch(() => {}).then(async () => {
      await writeFile(statePath + '.tmp', json, { mode: 0o600 });
      await rename(statePath + '.tmp', statePath);
    });
    return saveChain;
  };
  const zeroncourier = new ZeronCourier(mcp, { state, persist, projectName: process.env.ZERON_PROJECT_NAME || config.projectName || 'InternTrack' });
  const jsonResponse = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const allowedHosts = [`127.0.0.1:${server.address()?.port || port}`, `localhost:${server.address()?.port || port}`];
      if (!allowedHosts.includes(req.headers.host)) throw new ZeronCourierError('Invalid local Host header.', 403);
      const origin = req.headers.origin;
      const localOrigin = origin === `http://${req.headers.host}`;
      const extensionOrigin = /^(chrome|moz)-extension:\/\/[a-zA-Z0-9-]+$/.test(origin || '');
      if (origin && !localOrigin && !extensionOrigin && !['https://chatgpt.com', 'https://chat.openai.com'].includes(origin)) throw new ZeronCourierError('This origin is not allowed.', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') throw new ZeronCourierError('Method not allowed.', 405);
        if (origin && !localOrigin) throw new ZeronCourierError('Open setup directly on this PC.', 403);
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new ZeronCourierError('Open setup directly on this PC.', 403);
        if (url.pathname === '/health') return jsonResponse(res, 200, { ok: true, service: 'zeroncourier', version: '1.0.0' });
        if (url.pathname === '/pair') return jsonResponse(res, 200, { token });
        const files = { '/': ['dashboard.html', 'text/html'], '/dashboard.js': ['dashboard.js', 'text/javascript'] };
        if (files[url.pathname]) {
          const [name, type] = files[url.pathname];
          res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
          return res.end(await readFile(resolve(folder, name)));
        }
        if (url.pathname === '/zeroncourier.user.js') {
          const template = await readFile(resolve(folder, 'helper.template.user.js'), 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
          return res.end(template.replace('__ZERONCOURIER_TOKEN__', token).replaceAll('__ZERONCOURIER_PORT__', String(server.address().port)));
        }
        throw new ZeronCourierError('Not found.', 404);
      }
      const suppliedToken = req.headers.authorization?.replace(/^Bearer /, '');
      if (!safeTokenEqual(suppliedToken, token)) throw new ZeronCourierError('The browser helper is not paired. Reinstall it from the local setup page.', 401);
      if (req.method === 'GET' && url.pathname === '/api/chats') return jsonResponse(res, 200, { chats: await zeroncourier.chats() });
      if (req.method === 'GET' && url.pathname === '/api/status') {
        return jsonResponse(res, 200, await zeroncourier.status(url.searchParams.get('chatId'), url.searchParams.get('requestId')));
      }
      if (req.method === 'GET' && url.pathname === '/api/report') return jsonResponse(res, 200, await zeroncourier.report(url.searchParams.get('chatId'), url.searchParams.get('requestId')));
      if (req.method === 'POST' && url.pathname === '/api/send') {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new ZeronCourierError('JSON is required.', 415);
        let body = '';
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 210000) throw new ZeronCourierError('Instruction is too large.', 413); }
        let input; try { input = JSON.parse(body); } catch { throw new ZeronCourierError('Invalid JSON.'); }
        const result = await zeroncourier.send(input);
        // Baselines are only used for correlation; do not send them to the browser.
        const { baseline, fingerprint, delivery, ...job } = result.job;
        return jsonResponse(res, 200, { job, duplicate: result.duplicate });
      }
      throw new ZeronCourierError('Not found.', 404);
    } catch (error) {
      if (!res.headersSent) jsonResponse(res, error.status || 502, { error: error.message || 'Zeron connection failed.' });
      else res.end();
    }
  });
  return { server, zeroncourier, mcp, token };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.ZERONCOURIER_PORT || 8787);
  const bridge = await createBridge({ port });
  bridge.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Another zeroncourier may already be running.` : error.message); bridge.mcp.close(); process.exitCode = 1; });
  bridge.server.listen(port, '127.0.0.1', () => console.log(`ZeronCourier ready: http://127.0.0.1:${port}`));
  const stop = () => { bridge.mcp.close(); bridge.server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

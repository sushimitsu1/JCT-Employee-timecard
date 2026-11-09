import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRequest } from '../src/app.js';
import { DEFAULT_PBKDF2_ITERATIONS } from '../src/auth.js';
import { createNodeDb } from './node-db.js';
import { loadOrCreateSecrets } from './secrets.js';
import { FAKE_EMPLOYEE_PIN, FAKE_OWNER_PIN, seedIfEmpty } from './seed-data.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT || 8787);
const secrets = loadOrCreateSecrets(root);
const db = createNodeDb(path.join(root, 'local.sqlite'));
db.exec(fs.readFileSync(path.join(root, 'migrations/0001_init.sql'), 'utf8'));
await seedIfEmpty(db, { pepper: secrets.pepper, iterations: DEFAULT_PBKDF2_ITERATIONS });

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const assets = {
  async fetch(request) {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const relative = pathname.replace(/^\/+/, '');
    if (relative.includes('..') || relative.includes('\0')) return new Response('Not found', { status: 404 });
    const file = path.join(publicDir, relative);
    if (!file.startsWith(publicDir + path.sep)) return new Response('Not found', { status: 404 });
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(file), {
      headers: { 'content-type': mime[path.extname(file)] || 'application/octet-stream' },
    });
  },
};

const deps = {
  db,
  pepper: secrets.pepper,
  sessionSecret: secrets.session,
  iterations: DEFAULT_PBKDF2_ITERATIONS,
  now: () => new Date(),
  assets,
};

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null || key.toLowerCase() === 'cf-connecting-ip') continue;
      if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
      else headers.set(key, value);
    }
    headers.set('CF-Connecting-IP', req.socket.remoteAddress || '127.0.0.1');
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const response = await handleRequest(request, deps);
    const out = Buffer.from(await response.arrayBuffer());
    const responseHeaders = {};
    for (const [key, value] of response.headers) {
      if (key === 'set-cookie') continue;
      responseHeaders[key] = value;
    }
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    if (cookies.length) responseHeaders['set-cookie'] = cookies;
    res.writeHead(response.status, responseHeaders);
    res.end(out);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', msg: 'dev_server', error: error instanceof Error ? error.message : 'error' }));
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'server_error' }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`JCT timecard (fake local data) at http://127.0.0.1:${port}`);
  console.log(`Local fake PINs — employee ${FAKE_EMPLOYEE_PIN}, owner ${FAKE_OWNER_PIN}`);
});

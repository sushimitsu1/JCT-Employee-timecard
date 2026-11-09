import fs from 'node:fs';
import path from 'node:path';
import { handleRequest } from '../src/app.js';
import { createUser } from '../src/users.js';
import { createNodeDb } from '../scripts/node-db.js';

function applyCookies(jar, setCookie) {
  for (const line of setCookie) {
    const [pair, ...attrs] = line.split(';');
    const index = pair.indexOf('=');
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    const maxAge = attrs.find((attr) => attr.trim().toLowerCase().startsWith('max-age='));
    if (maxAge && Number(maxAge.split('=')[1]) === 0) delete jar[name];
    else jar[name] = value;
  }
}

export async function makeApp() {
  const db = createNodeDb();
  const root = path.resolve(import.meta.dirname, '..');
  db.exec(fs.readFileSync(path.join(root, 'migrations/0001_init.sql'), 'utf8'));
  let nowMs = Date.parse('2026-11-09T18:00:00.000Z');
  const jar = {};
  const deps = {
    db,
    pepper: 'test-pepper-value',
    sessionSecret: 'test-session-secret',
    iterations: 1000,
    now: () => new Date(nowMs),
    assets: null,
  };
  async function call(method, apiPath, { body, ip = '203.0.113.10', header = true, sendCookies = true } = {}) {
    const headers = new Headers();
    headers.set('cf-connecting-ip', ip);
    if (header) headers.set('x-jct-request', '1');
    if (sendCookies && Object.keys(jar).length) {
      headers.set('cookie', Object.entries(jar).map(([key, value]) => `${key}=${value}`).join('; '));
    }
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await handleRequest(new Request(`http://local${apiPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }), deps);
    const setCookie = response.headers.getSetCookie();
    applyCookies(jar, setCookie);
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, text, setCookie, headers: response.headers };
  }
  return {
    db,
    call,
    jar,
    setNow(ms) { nowMs = ms; },
    now() { return nowMs; },
    clearJar() {
      for (const key of Object.keys(jar)) delete jar[key];
    },
    user(spec) {
      return createUser(db, {
        pepper: deps.pepper,
        iterations: deps.iterations,
        now: new Date(nowMs),
        ...spec,
      });
    },
  };
}

export function csvObjects(text) {
  const rows = parseCsv(text.trimEnd());
  const [header, ...rest] = rows;
  return rest.map((row) => Object.fromEntries(header.map((name, index) => [name, row[index]])));
}

function parseCsv(text) {
  const lines = text.split('\n');
  return lines.map((line) => {
    const cells = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (quoted) {
        if (char === '"' && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else if (char === '"') quoted = false;
        else current += char;
      } else if (char === '"') quoted = true;
      else if (char === ',') {
        cells.push(current);
        current = '';
      } else current += char;
    }
    cells.push(current);
    return cells;
  });
}

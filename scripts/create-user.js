// Create one local user. The PIN is read from stdin and is not printed.
// This writes local.sqlite only. It does not talk to Cloudflare.
//
//   node scripts/create-user.js --name "Sample Employee" --role employee
//
// Optional: --sql-out user.sql writes an INSERT of the salt and hash
// (no PIN) that you can review and apply yourself with wrangler.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { hashPin } from '../src/auth.js';
import { DEFAULT_PBKDF2_ITERATIONS } from '../src/auth.js';
import { createNodeDb } from './node-db.js';
import { loadOrCreateSecrets } from './secrets.js';
import { createUser } from '../src/users.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function flag(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}
const displayName = flag('--name');
const role = flag('--role');
const sqlOut = flag('--sql-out');
if (!displayName || (role !== 'employee' && role !== 'owner')) {
  console.error('Usage: node scripts/create-user.js --name "Sample Employee" --role employee|owner [--sql-out file.sql]');
  process.exit(1);
}
if (process.env.JCT_ENV === 'production' && !sqlOut) {
  console.error('Refusing to write local.sqlite when JCT_ENV=production.');
  process.exit(1);
}

const rl = readline.createInterface({ input, output });
const pin = (await rl.question('4-6 digit PIN (not echoed to logs): ')).trim();
rl.close();
if (!/^\d{4,6}$/.test(pin)) {
  console.error('PIN must be 4 to 6 digits.');
  process.exit(1);
}

const secrets = loadOrCreateSecrets(root);
if (sqlOut) {
  const hashed = await hashPin(pin, secrets.pepper, DEFAULT_PBKDF2_ITERATIONS);
  const created = new Date().toISOString();
  const sql = `INSERT INTO users (display_name, role, pin_salt, pin_hash, pin_iterations, active, created_at)\nVALUES ('${displayName.replace(/'/g, "''")}', '${role}', '${hashed.salt}', '${hashed.hash}', ${hashed.iterations}, 1, '${created}');\n`;
  fs.writeFileSync(sqlOut, sql, { mode: 0o600 });
  console.log(`Wrote ${sqlOut} (salt and hash only). Review it, then apply it yourself. The PIN was not written.`);
} else {
  const db = createNodeDb(path.join(root, 'local.sqlite'));
  db.exec(fs.readFileSync(path.join(root, 'migrations/0001_init.sql'), 'utf8'));
  const id = await createUser(db, {
    displayName,
    role,
    pin,
    pepper: secrets.pepper,
    iterations: DEFAULT_PBKDF2_ITERATIONS,
  });
  console.log(`Created local user id ${id} (${role}). PIN was not printed.`);
}

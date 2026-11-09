import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PBKDF2_ITERATIONS } from '../src/auth.js';
import { createNodeDb } from './node-db.js';
import { loadOrCreateSecrets } from './secrets.js';
import { seedIfEmpty } from './seed-data.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secrets = loadOrCreateSecrets(root);
const db = createNodeDb(path.join(root, 'local.sqlite'));
db.exec(fs.readFileSync(path.join(root, 'migrations/0001_init.sql'), 'utf8'));
const result = await seedIfEmpty(db, { pepper: secrets.pepper, iterations: DEFAULT_PBKDF2_ITERATIONS });
console.log(result.seeded ? 'Seeded local.sqlite with fake users.' : 'local.sqlite already has users; left it alone.');

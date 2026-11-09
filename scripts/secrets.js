import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function loadOrCreateSecrets(root) {
  const file = path.join(root, '.dev.vars');
  let pepper = '';
  let session = '';
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    pepper = readKey(text, 'PIN_PEPPER');
    session = readKey(text, 'SESSION_SECRET');
  }
  if (pepper.length < 16 || session.length < 16) {
    pepper = crypto.randomBytes(32).toString('base64');
    session = crypto.randomBytes(32).toString('base64');
    fs.writeFileSync(file, `PIN_PEPPER=${pepper}\nSESSION_SECRET=${session}\n`, { mode: 0o600 });
    console.log('Wrote gitignored .dev.vars with new local secrets.');
  }
  return { pepper, session };
}

function readKey(text, key) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    if (trimmed.slice(0, index).trim() !== key) continue;
    return trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

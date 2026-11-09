// PIN hashing and sign-in lockout.
// A PIN is never stored. The hash is PBKDF2-SHA-256 of (pepper + ":" + pin)
// with a random 16-byte salt. The pepper is a Worker secret.
// Lockout counters live in the database; the rules themselves are pure.

export const LOCK_FAILS = 5;
export const LOCK_MS = 15 * 60 * 1000;
export const SESSION_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_PBKDF2_ITERATIONS = 210000;

export function isLocked(row, nowMs) {
  return !!(row && row.lockedUntilMs && nowMs < row.lockedUntilMs);
}

export function noteFailure(row, nowMs) {
  if (isLocked(row, nowMs)) {
    return {
      failCount: row.failCount,
      lastFailedAtMs: row.lastFailedAtMs,
      lockedUntilMs: row.lockedUntilMs,
    };
  }
  const expiredLock = !!(row && row.lockedUntilMs && nowMs >= row.lockedUntilMs);
  const recent = !!(row && row.lastFailedAtMs != null && nowMs - row.lastFailedAtMs < LOCK_MS);
  let count = row && !expiredLock && recent ? row.failCount : 0;
  count += 1;
  return {
    failCount: count,
    lastFailedAtMs: nowMs,
    lockedUntilMs: count >= LOCK_FAILS ? nowMs + LOCK_MS : null,
  };
}

export function clearedLock() {
  return { failCount: 0, lastFailedAtMs: null, lockedUntilMs: null };
}

function bytesToB64(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function b64ToBytes(value) {
  const text = atob(value);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function pbkdf2(pin, salt, iterations, pepper) {
  const material = new TextEncoder().encode(`${pepper}:${pin}`);
  const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPin(pin, pepper, iterations) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(pin, salt, iterations, pepper);
  return { salt: bytesToB64(salt), hash: bytesToB64(hash), iterations };
}

export async function verifyPin(pin, pepper, user) {
  const actual = await pbkdf2(pin, b64ToBytes(user.pin_salt), user.pin_iterations, pepper);
  return timingSafeEqual(actual, b64ToBytes(user.pin_hash));
}

export async function dummyVerify(pepper, iterations) {
  const salt = new Uint8Array(16);
  await pbkdf2('000000', salt, iterations, pepper);
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(signature));
}

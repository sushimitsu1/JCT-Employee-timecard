import { hashPin, verifyPin } from './auth.js';

export async function listActiveUsers(db) {
  return db.all(
    `SELECT id, display_name, role, pin_salt, pin_hash, pin_iterations, active
     FROM users WHERE active = 1 ORDER BY id`,
  );
}

export async function listEmployees(db) {
  return db.all(
    `SELECT id, display_name, role FROM users
     WHERE active = 1 AND role = 'employee' ORDER BY display_name, id`,
  );
}

export async function createUser(db, { displayName, role, pin, pepper, iterations, now = new Date() }) {
  if (role !== 'employee' && role !== 'owner') throw new Error('bad role');
  if (!/^\d{4,6}$/.test(pin)) throw new Error('bad pin');
  const existing = await listActiveUsers(db);
  for (const user of existing) {
    if (await verifyPin(pin, pepper, user)) throw new Error('duplicate pin');
  }
  const hashed = await hashPin(pin, pepper, iterations);
  const result = await db.run(
    `INSERT INTO users (display_name, role, pin_salt, pin_hash, pin_iterations, active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
    [displayName, role, hashed.salt, hashed.hash, hashed.iterations, now.toISOString()],
  );
  return result.lastRowId;
}

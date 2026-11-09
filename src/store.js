function lockFromRow(row) {
  if (!row) return null;
  return {
    failCount: row.fail_count,
    lastFailedAtMs: row.last_failed_at ? Date.parse(row.last_failed_at) : null,
    lockedUntilMs: row.locked_until ? Date.parse(row.locked_until) : null,
  };
}

export async function getLock(db, scope, scopeKey) {
  const row = await db.first(
    `SELECT fail_count, last_failed_at, locked_until FROM signin_lockouts WHERE scope = ? AND scope_key = ?`,
    [scope, scopeKey],
  );
  return lockFromRow(row);
}

export async function saveLock(db, scope, scopeKey, state) {
  const last = state.lastFailedAtMs == null ? null : new Date(state.lastFailedAtMs).toISOString();
  const until = state.lockedUntilMs == null ? null : new Date(state.lockedUntilMs).toISOString();
  await db.run(
    `INSERT INTO signin_lockouts (scope, scope_key, fail_count, last_failed_at, locked_until)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope, scope_key) DO UPDATE SET
       fail_count = excluded.fail_count,
       last_failed_at = excluded.last_failed_at,
       locked_until = excluded.locked_until`,
    [scope, scopeKey, state.failCount, last, until],
  );
}

export async function getDeviceUserId(db, deviceHash) {
  const row = await db.first(`SELECT user_id FROM device_bindings WHERE device_hash = ?`, [deviceHash]);
  return row ? row.user_id : null;
}

export async function bindDevice(db, deviceHash, userId, nowIso) {
  await db.run(
    `INSERT INTO device_bindings (device_hash, user_id, bound_at) VALUES (?, ?, ?)
     ON CONFLICT(device_hash) DO UPDATE SET user_id = excluded.user_id, bound_at = excluded.bound_at`,
    [deviceHash, userId, nowIso],
  );
}

export async function insertSession(db, { tokenHash, userId, expiresAt, createdAt }) {
  await db.run(
    `INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
    [tokenHash, userId, expiresAt, createdAt],
  );
}

export async function getSessionUser(db, tokenHash) {
  return db.first(
    `SELECT users.id, users.display_name, users.role, users.active, sessions.expires_at
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ?`,
    [tokenHash],
  );
}

export async function deleteSession(db, tokenHash) {
  await db.run(`DELETE FROM sessions WHERE token_hash = ?`, [tokenHash]);
}

export async function listPunches(db, userId) {
  const rows = await db.all(
    `SELECT id, user_id, kind, punched_at, source, created_at, updated_at
     FROM punches WHERE user_id = ? ORDER BY punched_at, id`,
    [userId],
  );
  return rows.map((row) => ({
    ...row,
    atMs: Date.parse(row.punched_at),
  }));
}

export async function listRates(db, userId) {
  const rows = await db.all(
    `SELECT id, user_id, hourly_cents, effective_on, created_at, created_by
     FROM rate_history WHERE user_id = ? ORDER BY effective_on, id`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    hourlyCents: row.hourly_cents,
    effectiveOn: row.effective_on,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }));
}

export async function getEmployee(db, userId) {
  return db.first(
    `SELECT id, display_name, role FROM users WHERE id = ? AND active = 1`,
    [userId],
  );
}

export async function addAudit(db, entry) {
  await db.run(
    `INSERT INTO audit_log
      (actor_user_id, action, entity_type, entity_id, target_user_id, before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.actorId,
      entry.action,
      entry.entityType,
      entry.entityId == null ? null : String(entry.entityId),
      entry.targetUserId ?? null,
      entry.before == null ? null : JSON.stringify(entry.before),
      entry.after == null ? null : JSON.stringify(entry.after),
      entry.at,
    ],
  );
}

export function punchSnapshot(row) {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    punchedAt: row.punched_at,
    source: row.source,
  };
}

-- JCT timecard. Fake local data is inserted by scripts/seed.js, not by this file.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('employee', 'owner')),
  pin_salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  pin_iterations INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS punches (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('clock_in', 'clock_out', 'lunch_out', 'lunch_in')),
  punched_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('self', 'owner')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_punches_user_time ON punches (user_id, punched_at);

CREATE TABLE IF NOT EXISTS rate_history (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  hourly_cents INTEGER NOT NULL CHECK (hourly_cents >= 0 AND hourly_cents <= 100000),
  effective_on TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  UNIQUE (user_id, effective_on)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS signin_lockouts (
  scope TEXT NOT NULL CHECK (scope IN ('ip', 'user')),
  scope_key TEXT NOT NULL,
  fail_count INTEGER NOT NULL,
  last_failed_at TEXT,
  locked_until TEXT,
  PRIMARY KEY (scope, scope_key)
);

CREATE TABLE IF NOT EXISTS device_bindings (
  device_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  bound_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  target_user_id INTEGER,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log (target_user_id, id);

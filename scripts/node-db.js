import { DatabaseSync } from 'node:sqlite';

export function createNodeDb(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON');
  return {
    exec(sql) {
      db.exec(sql);
    },
    async all(sql, params = []) {
      return db.prepare(sql).all(...params).map((row) => ({ ...row }));
    },
    async first(sql, params = []) {
      const row = db.prepare(sql).get(...params);
      return row ? { ...row } : null;
    },
    async run(sql, params = []) {
      const info = db.prepare(sql).run(...params);
      return { changes: Number(info.changes), lastRowId: Number(info.lastInsertRowid) };
    },
    async transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* already closed */ }
        throw error;
      }
    },
  };
}

// Adapter so the Worker (D1) and the local server / tests (node:sqlite)
// present the same tiny query API. node:sqlite stays out of this file so
// the Worker bundle does not import it.

export function createD1Adapter(d1) {
  return {
    async all(sql, params = []) {
      const statement = params.length ? d1.prepare(sql).bind(...params) : d1.prepare(sql);
      const result = await statement.all();
      return result.results ?? [];
    },
    async first(sql, params = []) {
      const statement = params.length ? d1.prepare(sql).bind(...params) : d1.prepare(sql);
      const row = await statement.first();
      return row ?? null;
    },
    async run(sql, params = []) {
      const statement = params.length ? d1.prepare(sql).bind(...params) : d1.prepare(sql);
      const result = await statement.run();
      return {
        changes: Number(result.meta?.changes ?? 0),
        lastRowId: Number(result.meta?.last_row_id ?? 0),
      };
    },
    // D1 batches are atomic, but this app's edits need read-then-write
    // decisions. The local server wraps those in a SQLite transaction.
    // On D1 the statements run in order without an interactive transaction.
    async transaction(fn) {
      return fn();
    },
  };
}

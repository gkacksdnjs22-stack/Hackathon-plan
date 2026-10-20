import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// A small D1-compatible adapter. Production uses the D1 binding directly;
// Node development uses its own explicitly selected SQLite file.
export function createLocalDatabase({ filename = ':memory:' } = {}) {
  if (typeof filename !== 'string' || !filename || filename.includes('\0')) throw new TypeError('Invalid database filename');
  if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const sqlite = new DatabaseSync(filename, { timeout: 5000 });
  sqlite.exec(readFileSync(new URL('./account-schema.sql', import.meta.url), 'utf8'));
  const execute = (sql, values) => {
    const result = sqlite.prepare(sql).run(...values);
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  };
  function statement(sql, values = []) {
    return {
      bind(...bindings) { return statement(sql, bindings); },
      async first(column) {
        const result = sqlite.prepare(sql).get(...values);
        if (!result) return null;
        return column === undefined ? { ...result } : result[column] ?? null;
      },
      async all() { return { success: true, results: sqlite.prepare(sql).all(...values).map(row => ({ ...row })) }; },
      async run() { return execute(sql, values); },
      _run() { return execute(sql, values); }
    };
  }
  return {
    prepare(sql) { return statement(sql); },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(item => item._run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    close() { sqlite.close(); }
  };
}

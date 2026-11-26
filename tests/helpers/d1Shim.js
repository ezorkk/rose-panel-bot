// Cloudflare D1 test double backed by Node's built-in `node:sqlite` (`new DatabaseSync(':memory:')`).
// Implements D1's Workers binding surface (`prepare(sql).bind(...).all()` / `.first()` / `.run()`
// and transactional `batch([...])`), including D1's strict rejection of `undefined` bind parameters.

import { DatabaseSync } from 'node:sqlite';

function normalizeBindValues(values) {
  return values.map((val, idx) => {
    if (val === undefined) {
      throw new TypeError(`D1_TYPE_ERROR: Type 'undefined' not supported for value at index ${idx}`);
    }
    if (typeof val === 'boolean') {
      return val ? 1 : 0;
    }
    return val;
  });
}

function toPlainObject(row) {
  if (!row || typeof row !== 'object') return row;
  return { ...row };
}

export function createD1Shim() {
  const sqlite = new DatabaseSync(':memory:');
  const stats = {
    queries: 0,
    batches: 0,
  };

  function executeStatement(sql, boundArgs, mode = 'auto') {
    stats.queries += 1;
    const stmt = sqlite.prepare(sql);
    const returnsRows = stmt.columns().length > 0;

    if (mode === 'first') {
      if (!returnsRows) {
        stmt.run(...boundArgs);
        return null;
      }
      const row = stmt.get(...boundArgs);
      return row === undefined ? null : toPlainObject(row);
    }

    if (returnsRows && mode !== 'run') {
      const rawRows = stmt.all(...boundArgs);
      const results = rawRows.map(toPlainObject);
      return {
        success: true,
        results,
        meta: {
          duration: 0,
          changes: 0,
          last_row_id: 0,
          changed_db: false,
          size_after: 0,
          rows_read: results.length,
          rows_written: 0,
        },
      };
    }

    const info = stmt.run(...boundArgs);
    const changes = Number(info?.changes || 0);
    const lastRowId = Number(info?.lastInsertRowid || 0);
    return {
      success: true,
      results: [],
      meta: {
        duration: 0,
        changes,
        last_row_id: lastRowId,
        changed_db: changes > 0,
        size_after: 0,
        rows_read: 0,
        rows_written: changes,
      },
    };
  }

  function makePreparedStatement(sql, boundArgs = []) {
    return {
      _sql: sql,
      _args: boundArgs,
      bind(...values) {
        return makePreparedStatement(sql, normalizeBindValues(values));
      },
      async all() {
        return executeStatement(sql, boundArgs, 'all');
      },
      async run() {
        return executeStatement(sql, boundArgs, 'run');
      },
      async first(colName) {
        const row = executeStatement(sql, boundArgs, 'first');
        if (!row) return null;
        if (colName !== undefined) {
          return Object.prototype.hasOwnProperty.call(row, colName) ? row[colName] : null;
        }
        return row;
      },
      async raw(options = {}) {
        stats.queries += 1;
        const stmt = sqlite.prepare(sql);
        const cols = stmt.columns().map((c) => c.name);
        stmt.setReturnArrays(true);
        const rows = stmt.all(...boundArgs).map((r) => [...r]);
        return options?.columnNames ? [cols, ...rows] : rows;
      },
    };
  }

  return {
    prepare(sql) {
      if (typeof sql !== 'string' || !sql.trim()) {
        throw new Error('D1_ERROR: SQL string is required');
      }
      return makePreparedStatement(sql, []);
    },

    async batch(statements) {
      if (!Array.isArray(statements)) {
        throw new TypeError('D1_ERROR: batch() expects an array of prepared statements');
      }
      stats.batches += 1;
      const out = [];
      sqlite.exec('BEGIN');
      try {
        for (const stmt of statements) {
          if (!stmt || typeof stmt._sql !== 'string') {
            throw new TypeError('D1_ERROR: Invalid prepared statement in batch()');
          }
          out.push(executeStatement(stmt._sql, stmt._args || [], 'auto'));
        }
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        try {
          sqlite.exec('ROLLBACK');
        } catch {
          // Ignore rollback failure if transaction already closed
        }
        throw err;
      }
    },

    async exec(sql) {
      stats.queries += 1;
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },

    // Test inspection helpers
    _sqlite: sqlite,
    _stats: stats,
  };
}

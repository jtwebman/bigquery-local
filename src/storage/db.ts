/**
 * DuckDB connection wrapper.
 *
 * `createDb({ path })` opens a DuckDB instance and connection (defaulting to
 * `:memory:`) and returns a small `Db` handle the rest of the codebase uses
 * exclusively. Routes, metadata stores, and SQL translator output all flow
 * through this module — nothing else imports `@duckdb/node-api`.
 *
 * `prepare(sql)` returns a thin wrapper backed by a per-connection cache
 * keyed on the exact SQL string, so hot paths (per-row inserts, repeated
 * lookups) reuse a single underlying `DuckDBPreparedStatement`.
 */

import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBPreparedStatement, DuckDBValue } from '@duckdb/node-api';

export interface DbConfig {
  /** File path, or `:memory:` (the default) for a transient in-memory database. */
  readonly path?: string;
}

export interface Db {
  /** Execute SQL with no result rows (DDL / DML). */
  exec(sql: string, params?: readonly unknown[]): Promise<void>;
  /** Run SQL and return rows as plain JS-typed objects. */
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<readonly Row[]>;
  /** Run SQL and return both rows and column metadata. Used by the query
   * endpoint when it needs to synthesize a result schema for the response. */
  queryWithSchema(sql: string, params?: readonly unknown[]): Promise<QueryResult>;
  /** Get a reusable prepared statement; the same SQL string returns the same cached statement. */
  prepare(sql: string): PreparedStatement;
  /** Close the connection and instance. Safe to call more than once. */
  close(): Promise<void>;
}

export interface QueryResult {
  /** Column names in select order. */
  readonly columnNames: readonly string[];
  /** DuckDB type strings per column (e.g. `BIGINT`, `VARCHAR`, `TIMESTAMP WITH TIME ZONE`). */
  readonly columnTypes: readonly string[];
  /** Plain JS-typed row objects keyed by column name. */
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}

export interface PreparedStatement {
  exec(params?: readonly unknown[]): Promise<void>;
  all<Row = Record<string, unknown>>(params?: readonly unknown[]): Promise<readonly Row[]>;
}

export async function createDb(config: DbConfig = {}): Promise<Db> {
  const path = config.path ?? ':memory:';
  const instance = await DuckDBInstance.create(path);
  const connection = await instance.connect();
  const preparedCache = new Map<string, Promise<DuckDBPreparedStatement>>();
  let closed = false;

  function ensureOpen(): void {
    if (closed) {
      throw new Error('Database is closed.');
    }
  }

  function asDuckValues(params: readonly unknown[] | undefined): DuckDBValue[] | undefined {
    if (params === undefined || params.length === 0) return undefined;
    return params as DuckDBValue[];
  }

  async function getPrepared(sql: string): Promise<DuckDBPreparedStatement> {
    const existing = preparedCache.get(sql);
    if (existing !== undefined) return existing;
    const fresh = connection.prepare(sql);
    preparedCache.set(sql, fresh);
    return fresh;
  }

  async function bindAndRun(
    stmt: DuckDBPreparedStatement,
    params: readonly unknown[] | undefined,
  ): Promise<void> {
    const values = asDuckValues(params);
    if (values !== undefined) stmt.bind(values);
    await stmt.run();
  }

  return {
    async exec(sql, params) {
      ensureOpen();
      const values = asDuckValues(params);
      if (values === undefined) {
        await connection.run(sql);
      } else {
        await connection.run(sql, values);
      }
    },
    async query(sql, params) {
      ensureOpen();
      const values = asDuckValues(params);
      const reader =
        values === undefined
          ? await connection.runAndReadAll(sql)
          : await connection.runAndReadAll(sql, values);
      // `getRowObjectsJS()` returns plain JS-typed values (number, bigint,
      // boolean, Date, string, Uint8Array, …); callers narrow via the Row
      // generic parameter.
      return reader.getRowObjectsJS() as readonly Record<string, unknown>[] as never;
    },
    async queryWithSchema(sql, params): Promise<QueryResult> {
      ensureOpen();
      const values = asDuckValues(params);
      const reader =
        values === undefined
          ? await connection.runAndReadAll(sql)
          : await connection.runAndReadAll(sql, values);
      const columnNames = reader.columnNames();
      const columnTypes = reader.columnTypes().map((t) => t.toString());
      const rows = reader.getRowObjectsJS() as readonly Record<string, unknown>[];
      return { columnNames, columnTypes, rows };
    },
    prepare(sql) {
      ensureOpen();
      return {
        async exec(params) {
          ensureOpen();
          const stmt = await getPrepared(sql);
          await bindAndRun(stmt, params);
        },
        async all(params) {
          ensureOpen();
          const stmt = await getPrepared(sql);
          const values = asDuckValues(params);
          if (values !== undefined) stmt.bind(values);
          const reader = await stmt.runAndReadAll();
          return reader.getRowObjectsJS() as readonly Record<string, unknown>[] as never;
        },
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      preparedCache.clear();
      connection.closeSync();
      instance.closeSync();
    },
  };
}

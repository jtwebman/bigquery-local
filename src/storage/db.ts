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

import {
  BIGINT,
  BLOB,
  BOOLEAN,
  DATE,
  DECIMAL,
  DOUBLE,
  DuckDBInstance,
  DuckDBListType,
  DuckDBScalarFunction,
  FLOAT,
  INTEGER,
  TIME,
  TIMESTAMP,
  TIMESTAMPTZ,
  VARCHAR,
} from '@duckdb/node-api';
import type { DuckDBPreparedStatement, DuckDBType, DuckDBValue } from '@duckdb/node-api';

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
  /** Register a scalar function backed by a JS callback. The callback runs
   * in the host Node process via the DuckDB scalar-function API; the actual
   * sandboxing for `LANGUAGE js` UDFs happens upstream in
   * `src/sql/jsUdf.ts`, which executes user-supplied JS inside a V8 isolate
   * (isolated-vm) and only hands a marshaled-value callback down here. */
  registerScalarFunction(spec: ScalarFunctionSpec): void;
  /** Register a cleanup hook that runs during `close()` (in registration
   * order). Used by `src/sql/jsUdf.ts` to dispose its V8 isolate. */
  onClose(hook: () => void | Promise<void>): void;
  /** Close the connection and instance. Safe to call more than once. */
  close(): Promise<void>;
}

/** A scalar function spec for `Db.registerScalarFunction`. Type strings use
 * DuckDB's textual form (e.g. `BIGINT`, `VARCHAR`, `DOUBLE`, `DECIMAL(38, 9)`,
 * `BOOLEAN`, `BLOB`, `DATE`, `TIME`, `TIMESTAMP`, `TIMESTAMP WITH TIME ZONE`,
 * `JSON`, `<inner>[]` for arrays). */
export interface ScalarFunctionSpec {
  readonly name: string;
  readonly argTypes: readonly string[];
  readonly returnType: string;
  readonly callback: (args: readonly unknown[]) => unknown;
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

// DuckDB type id for the spatial extension's GEOMETRY type (backs GEOGRAPHY).
// It isn't in the node-api's known type enum, so asType()/getRowObjectsJS()
// throw "Unexpected type id: 40" on it; only the raw columnTypeId() is safe.
const DUCKDB_GEOMETRY_TYPE_ID = 40;

// Parse a DuckDB type string (e.g. "BIGINT", "VARCHAR", "DECIMAL(38, 9)",
// "BIGINT[]", "TIMESTAMP WITH TIME ZONE") into a runtime type object suitable
// for DuckDBScalarFunction.setReturnType / addParameter. Only covers the types
// our JS UDF runtime hands in.
function parseDuckType(text: string): DuckDBType {
  const trimmed = text.trim();
  if (trimmed.endsWith('[]')) {
    return new DuckDBListType(parseDuckType(trimmed.slice(0, -2)));
  }
  const upper = trimmed.toUpperCase();
  const dec = /^DECIMAL\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(upper);
  if (dec !== null) {
    return DECIMAL(Number(dec[1]), Number(dec[2]));
  }
  switch (upper) {
    case 'BIGINT':
    case 'INT64':
      return BIGINT;
    case 'INTEGER':
      return INTEGER;
    case 'DOUBLE':
      return DOUBLE;
    case 'FLOAT':
      return FLOAT;
    case 'BOOLEAN':
    case 'BOOL':
      return BOOLEAN;
    case 'VARCHAR':
    case 'STRING':
    case 'JSON':
      return VARCHAR;
    case 'BLOB':
    case 'BYTES':
      return BLOB;
    case 'DATE':
      return DATE;
    case 'TIME':
      return TIME;
    case 'TIMESTAMP':
    case 'DATETIME':
      return TIMESTAMP;
    case 'TIMESTAMPTZ':
    case 'TIMESTAMP WITH TIME ZONE':
      return TIMESTAMPTZ;
    default:
      throw new Error(`Unsupported DuckDB type "${text}" for scalar function registration.`);
  }
}

// Install + load a DuckDB extension, tolerant of a cold cache hit by many
// connections at once: an extension auto-installs on first use (downloading
// into DUCKDB_HOME), and a concurrent LOAD can fire before another process
// finishes writing it. Retry LOAD (re-running INSTALL) a few times so the
// first-time race settles. Docker bakes the cache, so this is a no-op there.
async function loadExtension(
  connection: { run(sql: string): Promise<unknown> },
  name: string,
  installSql: string,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await connection.run(installSql);
    } catch {
      // Concurrent install, or already installed; LOAD decides availability.
    }
    try {
      await connection.run(`LOAD ${name}`);
      return;
    } catch (err) {
      lastErr = err;
      // Backoff grows to ~1s, plus jitter to de-sync a thundering herd of
      // parallel first-time installs (community downloads can take a beat).
      const backoff = Math.min(1000, 100 * (attempt + 1)) + Math.floor(Math.random() * 100);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  throw lastErr;
}

export async function createDb(config: DbConfig = {}): Promise<Db> {
  const path = config.path ?? ':memory:';
  const instance = await DuckDBInstance.create(path);
  const connection = await instance.connect();
  // Anchor DuckDB's session timezone to UTC so unzone'd TIMESTAMP literals
  // (which BQ treats as UTC) don't drift through the host's local zone.
  await connection.run("SET TimeZone='UTC'");
  // BQ treats NULL as the smallest value: NULLs first in ASC, last in
  // DESC. DuckDB defaults to NULLs-last for both.
  await connection.run("SET default_null_order = 'nulls_first_on_asc_last_on_desc'");
  // Spatial extension backs the GEOGRAPHY type and every ST_* function.
  await loadExtension(connection, 'spatial', 'INSTALL spatial');
  // BigQuery's ST_DISTANCE is geodesic in meters using (lng, lat); DuckDB's
  // ST_Distance is planar Cartesian and ST_Distance_Sphere flips the
  // argument order. Register a Haversine macro on the BQ convention.
  // R = 6371010.0 matches the S2 library (BQ's geography backend);
  // gets us bit-for-bit ST_DISTANCE parity for POINT-POINT queries.
  await connection.run(`
    CREATE OR REPLACE MACRO bq_st_distance(g1, g2) AS
      CASE
        WHEN ST_GeometryType(g1) = 'POINT' AND ST_GeometryType(g2) = 'POINT' THEN
          6371010.0 * 2 * asin(sqrt(
            pow(sin(radians(ST_Y(g2) - ST_Y(g1)) / 2), 2) +
            cos(radians(ST_Y(g1))) * cos(radians(ST_Y(g2))) *
            pow(sin(radians(ST_X(g2) - ST_X(g1)) / 2), 2)
          ))
        ELSE ST_Distance(g1, g2)
      END
  `);
  await connection.run(`
    CREATE OR REPLACE MACRO bq_st_dwithin(g1, g2, m) AS
      bq_st_distance(g1, g2) <= m
  `);
  // SHA512 via the community crypto extension's crypto_hash('sha2-512', x):
  // native (no JS-callback ThreadSafeFunction to leak), returns BYTES like BQ.
  await loadExtension(connection, 'crypto', 'INSTALL crypto FROM community');
  // BIGNUMERIC alias: real BQ BIGNUMERIC is DECIMAL(76, 38); DuckDB caps DECIMAL
  // precision at 38, so we back it with DECIMAL(38, 9) — same as NUMERIC. The
  // type name is registered so `CAST(... AS BIGNUMERIC)` works in user SQL;
  // wire encoders still emit BQ-fidelity Avro precision=77/scale=38 + Arrow
  // Decimal256(76, 38) by padding the unscaled int on the way out.
  await connection.run('CREATE TYPE BIGNUMERIC AS DECIMAL(38, 9)').catch(() => {
    // File-backed DBs that opened with the type already registered will throw
    // "Type already exists" — that's the expected state, ignore.
  });
  const preparedCache = new Map<string, Promise<DuckDBPreparedStatement>>();
  const closeHooks: Array<() => void | Promise<void>> = [];
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
      // The spatial extension's GEOMETRY type (which backs GEOGRAPHY) reports
      // DuckDB type id 40 — a type the node-api doesn't recognize, so both
      // columnTypes() and getRowObjectsJS() throw "Unexpected type id: 40" the
      // moment a result column is GEOMETRY. The raw columnTypeId() never throws,
      // so detect geometry columns by id and re-run with each wrapped in
      // ST_AsText — they read back as BQ WKT text, the same conversion
      // bqSelectExpression applies on the table-read path. The column type is
      // still reported as GEOMETRY so the result schema maps to GEOGRAPHY (not
      // STRING). A geometry output column implies a SELECT, so the re-run is safe.
      // Coerce to number: columnTypeId() is typed as the DuckDBTypeId enum,
      // which doesn't include 40 (the node-api doesn't model GEOMETRY).
      const geoFlags = columnNames.map(
        (_, i) => (reader.columnTypeId(i) as number) === DUCKDB_GEOMETRY_TYPE_ID,
      );
      if (geoFlags.some(Boolean)) {
        const q = (name: string): string => `"${name.replace(/"/g, '""')}"`;
        const projection = columnNames
          .map((name, i) =>
            geoFlags[i] ? `replace(ST_AsText(${q(name)}), ' (', '(') AS ${q(name)}` : q(name),
          )
          .join(', ');
        const inner = sql.trim().replace(/;\s*$/, '');
        const wrappedSql = `SELECT ${projection} FROM (${inner}) AS _bq_geo`;
        const wrapped =
          values === undefined
            ? await connection.runAndReadAll(wrappedSql)
            : await connection.runAndReadAll(wrappedSql, values);
        const wrappedTypes = wrapped.columnTypes().map((t) => t.toString());
        return {
          columnNames: wrapped.columnNames(),
          columnTypes: wrappedTypes.map((t, i) => (geoFlags[i] ? 'GEOMETRY' : t)),
          rows: wrapped.getRowObjectsJS() as readonly Record<string, unknown>[],
        };
      }
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
    registerScalarFunction(spec: ScalarFunctionSpec): void {
      ensureOpen();
      const f = new DuckDBScalarFunction();
      f.setName(spec.name);
      f.setReturnType(parseDuckType(spec.returnType));
      for (const t of spec.argTypes) {
        f.addParameter(parseDuckType(t));
      }
      // setSpecialHandling lets NULL args reach the callback (default is to
      // short-circuit and emit NULL); BQ JS UDFs do receive null and may
      // return a non-null value, so we need the full path.
      f.setSpecialHandling();
      f.setMainFunction((_info, chunk, output) => {
        const n = chunk.rowCount;
        const argCount = spec.argTypes.length;
        const vecs = Array.from({ length: argCount }, (_, i) => chunk.getColumnVector(i));
        for (let row = 0; row < n; row++) {
          const args = vecs.map((v) => v.getItem(row));
          try {
            const result = spec.callback(args);
            output.setItem(row, result as DuckDBValue);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`UDF "${spec.name}" failed at row ${row}: ${msg}`);
          }
        }
        output.flush();
      });
      connection.registerScalarFunction(f);
    },
    onClose(hook) {
      ensureOpen();
      closeHooks.push(hook);
    },
    async close() {
      if (closed) return;
      closed = true;
      // Run hooks in reverse registration order, isolating each failure so
      // one bad hook doesn't strand the connection.
      for (let i = closeHooks.length - 1; i >= 0; i--) {
        try {
          await closeHooks[i]?.();
        } catch {
          /* best-effort cleanup */
        }
      }
      preparedCache.clear();
      connection.closeSync();
      instance.closeSync();
    },
  };
}

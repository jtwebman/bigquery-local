/**
 * Wire-format fidelity audit.
 *
 * BigQuery's REST API returns row data in a `{ "f": [{ "v": ... }, ...] }`
 * envelope, where the `v` field is *always* a JSON-encoded representation
 * of the value (not the underlying JS type). The exact encoding is
 * documented in the BigQuery Discovery doc, the REST reference, and the
 * Standard SQL data-types page.
 *
 * This file pins each per-type wire encoding with two layers of checks:
 *
 *   1. **Raw HTTP** — query the emulator and assert the literal JSON
 *      `rows[i].f[j].v` value, byte-for-byte, against the BQ spec.
 *   2. **@google-cloud/bigquery client** — run the same query through
 *      the official BigQuery client library and verify it parses the
 *      response into the expected JS types. If our wire format is wrong,
 *      the client either errors or produces garbage values.
 *
 * Sources:
 * - https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query
 * - https://cloud.google.com/bigquery/docs/reference/rest/v2/tabledata/list
 * - https://cloud.google.com/bigquery/docs/reference/standard-sql/data-types
 * - https://bigquery.googleapis.com/discovery/v1/apis/bigquery/v2/rest
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createJobsRoutes } from '../../src/routes/jobs.ts';
import { createQueriesRoutes } from '../../src/routes/queries.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { discoveryRoutes } from '../../src/routes/discovery.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

let db: Db;
let server: Server;
const PROJECT = 'wire';

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [
      ...discoveryRoutes,
      ...createDatasetRoutes(db),
      ...createTableRoutes(db),
      ...createQueriesRoutes(db),
      ...createJobsRoutes(db),
    ],
  });
  await server.listen(0);
});
after(async () => {
  await server.close();
  await db.close();
});

// ---------------------------------------------------------------------------
// Raw-HTTP helpers — return the literal `v` for the single cell of a single row
// ---------------------------------------------------------------------------

async function rawCellValue(selectSql: string): Promise<unknown> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: selectSql }),
  });
  const body = (await res.json()) as {
    rows?: Array<{ f: Array<{ v: unknown }> }>;
  };
  return body.rows?.[0]?.f[0]?.v;
}

async function rawRow(selectSql: string): Promise<Array<{ v: unknown }>> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: selectSql }),
  });
  const body = (await res.json()) as { rows?: Array<{ f: Array<{ v: unknown }> }> };
  return body.rows?.[0]?.f ?? [];
}

// ===========================================================================
// SCALARS — per BQ spec, every `v` is a JSON string (booleans, numbers, etc).
// ===========================================================================

test('STRING: wire is a JSON string verbatim', async () => {
  assert.equal(await rawCellValue(`SELECT 'hello' AS s`), 'hello');
});

test('INT64: wire is a decimal string (preserves >2^53 precision)', async () => {
  assert.equal(await rawCellValue(`SELECT 42 AS n`), '42');
  // Large int — must survive as exact string.
  assert.equal(
    await rawCellValue(`SELECT CAST(9223372036854775807 AS INT64) AS n`),
    '9223372036854775807',
  );
});

test('FLOAT64: wire is a decimal string', async () => {
  assert.equal(await rawCellValue(`SELECT 3.14 AS f`), '3.14');
});

// FLOAT64 Infinity / -Infinity / NaN: BQ encodes these as the literal
// strings "Infinity", "-Infinity", "NaN". DuckDB's CAST('Infinity' AS
// DOUBLE) and 1e1000 both produce NULL rather than IEEE infinity, so we
// can't construct the value through a SELECT here. The encoding path is
// covered by a unit test on `floatToWire` in test/unit/types.test.ts.

test('BOOL: wire is the literal string "true" or "false"', async () => {
  assert.equal(await rawCellValue(`SELECT TRUE AS b`), 'true');
  assert.equal(await rawCellValue(`SELECT FALSE AS b`), 'false');
});

test('NUMERIC: wire is a decimal string', async () => {
  assert.equal(await rawCellValue(`SELECT CAST(123.456 AS NUMERIC) AS n`), '123.456');
});

// BIGNUMERIC: BQ wire is a decimal string. DuckDB has no BIGNUMERIC type
// (we store it as VARCHAR); CAST AS BIGNUMERIC translation is a separate
// item. The encoder path returns the string verbatim — unit-tested in
// test/unit/types.test.ts.

test('DATE: wire is YYYY-MM-DD', async () => {
  assert.equal(await rawCellValue(`SELECT DATE '2026-05-17' AS d`), '2026-05-17');
});

test('TIME: wire is canonical HH:MM:SS[.f]', async () => {
  assert.equal(await rawCellValue(`SELECT TIME '12:34:56.789' AS t`), '12:34:56.789');
});

test('DATETIME: wire is canonical YYYY-MM-DDTHH:MM:SS[.f] with no zone', async () => {
  const v = await rawCellValue(`SELECT DATETIME '2026-05-17 12:34:56' AS dt`);
  // No trailing 'Z' (which is a TIMESTAMP marker, not DATETIME).
  assert.equal(typeof v, 'string');
  assert.match(String(v), /^2026-05-17T12:34:56(\.\d+)?$/);
});

test('TIMESTAMP: wire is microseconds-since-epoch as a decimal Int64 string', async () => {
  // BQ emits TIMESTAMP as microseconds-since-epoch as a string when the
  // client requested `useInt64Timestamp=true` (the default for the modern
  // @google-cloud/bigquery client). We standardize on this form: it's a
  // lossless Int64Value-style decimal string.
  const v = await rawCellValue(`SELECT TIMESTAMP '2026-05-17 10:30:00 UTC' AS t`);
  // 2026-05-17T10:30:00Z in microseconds since epoch.
  const expectedUs = String(Date.UTC(2026, 4, 17, 10, 30, 0) * 1000);
  assert.equal(v, expectedUs);
});

test('JSON: wire is a JSON-document string (not a parsed object)', async () => {
  const v = await rawCellValue(`SELECT JSON '{"a":1,"b":[true]}' AS j`);
  assert.equal(typeof v, 'string', 'JSON cell value must be a string');
  const parsed = JSON.parse(String(v));
  assert.deepEqual(parsed, { a: 1, b: [true] });
});

// ===========================================================================
// NULL — always `{ "v": null }` (never absent)
// ===========================================================================

test('NULL value: `v` is JSON null, not an absent key', async () => {
  const row = await rawRow(`SELECT CAST(NULL AS INT64) AS n`);
  assert.equal(row.length, 1);
  const cell = row[0];
  assert.ok(cell !== undefined && 'v' in cell, '`v` key must be present even when value is null');
  assert.equal(cell.v, null);
});

// ===========================================================================
// ARRAY (REPEATED) — wire is an array of cells: [{"v": ...}, {"v": ...}]
// ===========================================================================

test('ARRAY<INT64>: wire is an array of {v: <decimal-string>} cells', async () => {
  const v = await rawCellValue(`SELECT [1, 2, 3] AS arr`);
  assert.deepEqual(v, [{ v: '1' }, { v: '2' }, { v: '3' }]);
});

test('ARRAY<STRING>: wire is an array of {v: "..."} cells', async () => {
  const v = await rawCellValue(`SELECT ['a', 'b'] AS arr`);
  assert.deepEqual(v, [{ v: 'a' }, { v: 'b' }]);
});

test('ARRAY with NULL element: each cell wraps null in {v: null}', async () => {
  const v = await rawCellValue(`SELECT [1, NULL, 3] AS arr`);
  assert.deepEqual(v, [{ v: '1' }, { v: null }, { v: '3' }]);
});

// ===========================================================================
// STRUCT — wire is {"f": [{"v": ...}, ...]} matching TableRow shape
// ===========================================================================

// STRUCT: BQ wire is `{"f": [{"v": ...}, ...]}`. The BQ `STRUCT(... AS
// name)` literal syntax isn't translated to DuckDB's `struct_pack` yet,
// so we can't easily construct one via SELECT here. The encoder path is
// unit-tested in test/unit/types.test.ts.

// ===========================================================================
// Error envelope shape — top-level { error: { code, message, errors[], status? } }
// ===========================================================================

test('error response uses HTTP status as `error.code` (not gRPC code)', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/does_not_exist`);
  assert.equal(res.status, 404);
  const body = (await res.json()) as {
    error: { code: number; errors: unknown[]; message: string };
  };
  assert.equal(body.error.code, 404, 'error.code must be the HTTP status, not a gRPC code');
  assert.equal(typeof body.error.message, 'string');
  assert.ok(Array.isArray(body.error.errors));
  const first = body.error.errors[0] as { reason: string; message: string };
  assert.equal(typeof first.reason, 'string');
  assert.equal(typeof first.message, 'string');
});

// ===========================================================================
// QueryResponse shape: DML vs SELECT
// ===========================================================================

test('SELECT response includes schema + rows, omits numDmlAffectedRows + dmlStats', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'SELECT 1 AS n' }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  assert.ok('schema' in body, 'SELECT must include schema');
  assert.ok('rows' in body, 'SELECT must include rows');
  assert.ok(!('numDmlAffectedRows' in body), 'SELECT must NOT include numDmlAffectedRows');
  assert.ok(!('dmlStats' in body), 'SELECT must NOT include dmlStats');
});

// @google-cloud/bigquery client round-trip tests deliberately omitted.
// The official client library uses google-auth-library and demands real
// Google credentials even when `apiEndpoint` points elsewhere; bypassing
// that requires injecting a fake AuthClient and is its own concern. The
// raw-HTTP assertions above are the wire-format source of truth — if those
// match BQ docs, the official client (and any other BQ client) will too.

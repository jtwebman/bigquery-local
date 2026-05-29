/**
 * BL-070 — BigQuery `LANGUAGE js` UDF support (crude / unsafe path).
 *
 * The runtime compiles the user body via `new Function(...args, body)` and
 * registers it with DuckDB. These tests pin the contract: scalar math,
 * NULL propagation, string handling, arrays, errors-as-BqError, OR REPLACE,
 * and BQ type marshaling (INT64 → JS Number, NUMERIC → string).
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createQueriesRoutes } from '../../src/routes/queries.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';
import { unwrapV } from '../helpers/wire.ts';

let db: Db;
let server: Server;
const PROJECT = 'sql-js-udf';

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [...createDatasetRoutes(db), ...createTableRoutes(db), ...createQueriesRoutes(db)],
  });
  await server.listen(0);
});

after(async () => {
  await server.close();
  await db.close();
});

async function query(q: string): Promise<{
  rows?: Array<{ f: Array<{ v: unknown }> }>;
  schema?: { fields: Array<{ type: string }> };
  error?: { message?: string };
}> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  return res.json() as Promise<{
    rows?: Array<{ f: Array<{ v: unknown }> }>;
    schema?: { fields: Array<{ type: string }> };
    error?: { message?: string };
  }>;
}

async function scalar(q: string): Promise<unknown> {
  const body = await query(q);
  return unwrapV(body.rows?.[0]?.f[0]?.v);
}

test('JS UDF: simple math (FLOAT64)', async () => {
  await query(`
    CREATE TEMP FUNCTION js_mul2(x FLOAT64)
    RETURNS FLOAT64
    LANGUAGE js
    AS """ return x * 2; """
  `);
  assert.equal(await scalar('SELECT js_mul2(5.5) AS x'), '11.0');
});

test('JS UDF: NULL propagation (function body sees null)', async () => {
  await query(`
    CREATE TEMP FUNCTION js_or_zero(x FLOAT64)
    RETURNS FLOAT64
    LANGUAGE js
    AS """ return x === null ? 0 : x; """
  `);
  assert.equal(await scalar('SELECT js_or_zero(NULL) AS x'), '0.0');
  assert.equal(await scalar('SELECT js_or_zero(3.5) AS x'), '3.5');
});

test('JS UDF: STRING in, STRING out', async () => {
  await query(`
    CREATE TEMP FUNCTION js_upper_reverse(s STRING)
    RETURNS STRING
    LANGUAGE js
    AS """ return s.toUpperCase().split('').reverse().join(''); """
  `);
  assert.equal(await scalar("SELECT js_upper_reverse('hello') AS x"), 'OLLEH');
});

test('JS UDF: INT64 surfaces as JS Number (BQ contract — lossy past 2^53)', async () => {
  await query(`
    CREATE TEMP FUNCTION js_plus_one(n INT64)
    RETURNS INT64
    LANGUAGE js
    AS """ return n + 1; """
  `);
  assert.equal(await scalar('SELECT js_plus_one(41) AS x'), '42');
});

test('JS UDF: NUMERIC values surface as JS strings', async () => {
  await query(`
    CREATE TEMP FUNCTION js_num_passthrough(n NUMERIC)
    RETURNS STRING
    LANGUAGE js
    AS """ return typeof n + ':' + n; """
  `);
  assert.equal(await scalar("SELECT js_num_passthrough(NUMERIC '1.5') AS x"), 'string:1.500000000');
});

test('JS UDF: thrown error becomes a BQ error', async () => {
  await query(`
    CREATE TEMP FUNCTION js_thrower(x INT64)
    RETURNS INT64
    LANGUAGE js
    AS """ if (x < 0) throw new Error('negative not allowed'); return x; """
  `);
  const body = await query('SELECT js_thrower(-1) AS x');
  assert.ok(body.error !== undefined, 'expected an error response');
  assert.match(body.error?.message ?? '', /negative not allowed/);
});

test('JS UDF: OR REPLACE re-registers the function', async () => {
  await query(`
    CREATE TEMP FUNCTION js_swap(x FLOAT64)
    RETURNS FLOAT64
    LANGUAGE js
    AS """ return x + 1; """
  `);
  assert.equal(await scalar('SELECT js_swap(10) AS x'), '11.0');
  await query(`
    CREATE OR REPLACE TEMP FUNCTION js_swap(x FLOAT64)
    RETURNS FLOAT64
    LANGUAGE js
    AS """ return x * 100; """
  `);
  assert.equal(await scalar('SELECT js_swap(10) AS x'), '1000.0');
});

test('JS UDF: compile error surfaces as BQ error', async () => {
  const body = await query(`
    CREATE TEMP FUNCTION js_bad(x INT64)
    RETURNS INT64
    LANGUAGE js
    AS """ this is not valid javascript """
  `);
  assert.ok(body.error !== undefined, 'expected an error response');
  assert.match(body.error?.message ?? '', /compile/i);
});

// -----------------------------------------------------------------------
// Sandbox proofs — these tests verify that the isolated-vm boundary
// actually blocks host access, kills runaway loops, and caps memory.
// -----------------------------------------------------------------------

test('Sandbox: UDF cannot access globalThis.process / require / Buffer', async () => {
  await query(`
    CREATE TEMP FUNCTION js_inspect(_dummy INT64)
    RETURNS STRING
    LANGUAGE js
    AS """
      var seen = [];
      seen.push('process=' + (typeof globalThis.process));
      seen.push('require=' + (typeof globalThis.require));
      seen.push('Buffer=' + (typeof globalThis.Buffer));
      seen.push('global=' + (typeof globalThis.global));
      return seen.join(',');
    """
  `);
  const out = await scalar('SELECT js_inspect(1) AS x');
  assert.equal(out, 'process=undefined,require=undefined,Buffer=undefined,global=undefined');
});

test('Sandbox: infinite loop UDF hits the 5 s CPU timeout', async () => {
  await query(`
    CREATE TEMP FUNCTION js_spin(_x INT64)
    RETURNS INT64
    LANGUAGE js
    AS """ while (true) {} return 0; """
  `);
  const body = await query('SELECT js_spin(1) AS x');
  assert.ok(body.error !== undefined, 'expected an error response');
  assert.match(body.error?.message ?? '', /timed out/i);
});

test('Sandbox: memory-hog UDF hits the 128 MB cap', async () => {
  await query(`
    CREATE TEMP FUNCTION js_oom(_x INT64)
    RETURNS INT64
    LANGUAGE js
    AS """
      // Allocate ~512 MB of ArrayBuffer-backed Float64Array values that V8
      // can't dedupe; the isolate's 128 MB cap should kill the second or
      // third iteration. Hold a reference array so V8 doesn't GC the prior
      // buffers between iterations.
      var bufs = [];
      for (var i = 0; i < 64; i++) {
        var arr = new Float64Array(1024 * 1024);     // 8 MB each
        for (var j = 0; j < arr.length; j += 1024) arr[j] = i + j;
        bufs.push(arr);
      }
      return bufs.length;
    """
  `);
  const body = await query('SELECT js_oom(1) AS x');
  assert.ok(body.error !== undefined, 'expected an error response');
  assert.match(body.error?.message ?? '', /memory|allocation|isolate/i);
});

test('JS UDF: OPTIONS(library=[...]) fetches and injects the library into the isolate', async () => {
  // Spin up a tiny local HTTP server that returns a JS library defining
  // `globalThis.bqLibAdd`. The UDF body then calls it — proving the library
  // loaded into the isolate's shared context before the UDF compiled.
  const http = await import('node:http');
  const libServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end('globalThis.bqLibAdd = function(a, b) { return a + b + 100; };');
  });
  await new Promise<void>((resolve) => libServer.listen(0, '127.0.0.1', resolve));
  const addr = libServer.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const libUrl = `http://127.0.0.1:${port}/lib.js`;
  try {
    await query(`
      CREATE TEMP FUNCTION js_uses_lib(x FLOAT64)
      RETURNS FLOAT64
      LANGUAGE js
      OPTIONS(library = ["${libUrl}"])
      AS """ return bqLibAdd(x, 1); """
    `);
    assert.equal(await scalar('SELECT js_uses_lib(5) AS x'), '106.0');
  } finally {
    await new Promise<void>((resolve) => libServer.close(() => resolve()));
  }
});

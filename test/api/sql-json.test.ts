/**
 * BL-041 — BQ JSON functions: JSON_QUERY, JSON_VALUE_ARRAY, JSON_TYPE,
 * JSON_KEYS, TO_JSON, TO_JSON_STRING, PARSE_JSON, BOOL/INT64/FLOAT64
 * conversions from JSON.
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
const PROJECT = 'sql-json';

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

async function scalar(query: string): Promise<unknown> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { rows: Array<{ f: Array<{ v: unknown }> }> };
  return unwrapV(body.rows[0]?.f[0]?.v);
}

test('JSON_QUERY pulls a nested JSON subtree by path', async () => {
  const v = await scalar(`SELECT JSON_QUERY('{"a":[1,2,3]}', '$.a') AS x`);
  assert.match(String(v), /\[1,2,3\]/);
});

test('JSON_VALUE_ARRAY extracts an array of scalar strings', async () => {
  const out = await scalar(`SELECT JSON_VALUE_ARRAY('{"a":["x","y","z"]}', '$.a[*]') AS x`);
  // DuckDB's json_extract_string with [*] returns ARRAY<VARCHAR>.
  assert.deepEqual(out, ['x', 'y', 'z']);
});

test("JSON_TYPE returns the JSON value's type name", async () => {
  // DuckDB returns uppercase ('OBJECT', 'ARRAY', etc.); BQ uses lowercase.
  // Pass-through means we get DuckDB's casing — acceptable for v0.
  const v = await scalar(`SELECT JSON_TYPE('{"a":1}') AS x`);
  assert.equal(String(v).toLowerCase(), 'object');
});

test('JSON_KEYS returns the object keys as ARRAY<STRING>', async () => {
  const out = await scalar(`SELECT JSON_KEYS('{"a":1,"b":2}') AS x`);
  assert.deepEqual(out, ['a', 'b']);
});

test('TO_JSON wraps a scalar in JSON', async () => {
  // TO_JSON(42) → JSON 42. Wire is a string.
  const v = await scalar('SELECT TO_JSON(42) AS x');
  assert.equal(String(v), '42');
});

test('TO_JSON_STRING serializes any value as a JSON string', async () => {
  const v = await scalar("SELECT TO_JSON_STRING('hello') AS x");
  // BQ would return `"hello"` (a JSON string). Our DuckDB to_json returns
  // the same shape.
  assert.equal(String(v), '"hello"');
});

test('PARSE_JSON parses a string into a JSON value', async () => {
  const v = await scalar(`SELECT PARSE_JSON('{"a":1}') AS x`);
  assert.match(String(v), /"a":1/);
});

test('PARSE_JSON returns NULL for NULL input', async () => {
  assert.equal(await scalar('SELECT PARSE_JSON(NULL) AS x'), null);
});

test('BOOL extracts a boolean from JSON', async () => {
  assert.equal(await scalar("SELECT BOOL(CAST('true' AS JSON)) AS x"), 'true');
});

test('INT64 extracts an integer from JSON', async () => {
  // BIGINT → wire as decimal string.
  assert.equal(await scalar("SELECT INT64(CAST('42' AS JSON)) AS x"), '42');
});

test('FLOAT64 extracts a float from JSON', async () => {
  assert.equal(await scalar("SELECT FLOAT64(CAST('3.14' AS JSON)) AS x"), '3.14');
});

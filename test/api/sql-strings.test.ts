/**
 * BL-037 — happy-path coverage for BQ string functions.
 *
 * Each test runs one query through POST /queries and asserts the wire
 * cell value. Proves the translator emits SQL DuckDB accepts and that
 * the result type round-trips through `duckTypeToBq`.
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
const PROJECT = 'sql-strings';

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

/** Run a one-row SELECT and return `f[0].v`. */
async function scalar(query: string): Promise<unknown> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { rows: Array<{ f: Array<{ v: unknown }> }> };
  return unwrapV(body.rows[0]?.f[0]?.v);
}

// ---------------------------------------------------------------------------
// Renamed → DuckDB equivalents
// ---------------------------------------------------------------------------

test('REGEXP_CONTAINS returns BOOL true on a match', async () => {
  assert.equal(await scalar("SELECT REGEXP_CONTAINS('hello-world', r'\\d+') AS x"), 'false');
  assert.equal(await scalar("SELECT REGEXP_CONTAINS('user42', r'\\d+') AS x"), 'true');
});

test('FORMAT uses printf-style placeholders', async () => {
  // BQ FORMAT('%s=%d', 'a', 7) → "a=7"
  assert.equal(await scalar("SELECT FORMAT('%s=%d', 'a', 7) AS x"), 'a=7');
});

test('NORMALIZE collapses unicode to NFC', async () => {
  // 'å' (a + combining ring) → 'å' (NFC composed).
  assert.equal(await scalar("SELECT NORMALIZE('å') AS x"), 'å');
});

test('NORMALIZE_AND_CASEFOLD lowercases plus NFC-normalizes', async () => {
  assert.equal(await scalar("SELECT NORMALIZE_AND_CASEFOLD('Å') AS x"), 'å');
});

// ---------------------------------------------------------------------------
// Pass-throughs — name matches DuckDB; we test the wire path still works.
// ---------------------------------------------------------------------------

test('REGEXP_EXTRACT pulls the first match (2-arg form)', async () => {
  assert.equal(await scalar("SELECT REGEXP_EXTRACT('order-2026-abc', r'\\d+') AS x"), '2026');
});

test('REGEXP_EXTRACT_ALL returns ARRAY<STRING>', async () => {
  const out = await scalar("SELECT REGEXP_EXTRACT_ALL('a1 b2 c3', r'\\d') AS x");
  assert.deepEqual(out, ['1', '2', '3']);
});

test('REGEXP_REPLACE substitutes matches', async () => {
  assert.equal(await scalar("SELECT REGEXP_REPLACE('a1b2c3', r'\\d', '_') AS x"), 'a_b_c_');
});

test('LPAD and RPAD pad to the requested width', async () => {
  assert.equal(await scalar("SELECT LPAD('7', 3, '0') AS x"), '007');
  assert.equal(await scalar("SELECT RPAD('hi', 5, '.') AS x"), 'hi...');
});

test('TRANSLATE replaces characters one-to-one', async () => {
  assert.equal(await scalar("SELECT TRANSLATE('hello', 'el', 'ip') AS x"), 'hippo');
});

test('REPEAT returns the string repeated n times', async () => {
  assert.equal(await scalar("SELECT REPEAT('ab', 3) AS x"), 'ababab');
});

test('REVERSE returns the string reversed', async () => {
  assert.equal(await scalar("SELECT REVERSE('hello') AS x"), 'olleh');
});

test('OCTET_LENGTH returns byte length, not char count', async () => {
  // 'café' = 5 bytes in UTF-8 (4 chars; the é is 2 bytes).
  // INT64 returns as a decimal string in BQ wire format.
  assert.equal(await scalar("SELECT OCTET_LENGTH('café') AS x"), '5');
});

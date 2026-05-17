/**
 * BL-042 — BQ array functions.
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

let db: Db;
let server: Server;
const PROJECT = 'sql-array';

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
  return body.rows[0]?.f[0]?.v;
}

test('GENERATE_ARRAY returns an inclusive range', async () => {
  const out = await scalar('SELECT GENERATE_ARRAY(1, 5) AS x');
  assert.deepEqual(out, ['1', '2', '3', '4', '5']);
});

test('ARRAY_TO_STRING joins with a separator', async () => {
  assert.equal(await scalar("SELECT ARRAY_TO_STRING(['a', 'b', 'c'], '-') AS x"), 'a-b-c');
});

test('ARRAY_CONCAT concatenates two arrays', async () => {
  const out = await scalar('SELECT ARRAY_CONCAT([1, 2], [3, 4]) AS x');
  assert.deepEqual(out, ['1', '2', '3', '4']);
});

test('ARRAY_LENGTH returns the element count', async () => {
  assert.equal(await scalar('SELECT ARRAY_LENGTH([10, 20, 30]) AS x'), '3');
});

test('ARRAY_REVERSE reverses element order', async () => {
  const out = await scalar('SELECT ARRAY_REVERSE([1, 2, 3]) AS x');
  assert.deepEqual(out, ['3', '2', '1']);
});

test('OFFSET(n) is 0-indexed array subscript', async () => {
  assert.equal(await scalar('SELECT [10, 20, 30][OFFSET(1)] AS x'), '20');
});

test('ORDINAL(n) is 1-indexed array subscript', async () => {
  assert.equal(await scalar('SELECT [10, 20, 30][ORDINAL(1)] AS x'), '10');
});

test('SAFE_OFFSET returns NULL for out-of-range subscript', async () => {
  assert.equal(await scalar('SELECT [10, 20, 30][SAFE_OFFSET(99)] AS x'), null);
});

test('FLATTEN flattens nested arrays one level', async () => {
  const out = await scalar('SELECT FLATTEN([[1, 2], [3, 4]]) AS x');
  assert.deepEqual(out, ['1', '2', '3', '4']);
});

test('ARRAY_AGG collects values into an array', async () => {
  const out = await scalar('SELECT ARRAY_AGG(unnest ORDER BY unnest) AS r FROM UNNEST([3, 1, 2])');
  assert.deepEqual(out, ['1', '2', '3']);
});

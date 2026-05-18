/**
 * BL-043 — BQ aggregate functions.
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
const PROJECT = 'sql-agg';

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

test('STRING_AGG joins string values', async () => {
  const v = await scalar(
    "SELECT STRING_AGG(s, ',' ORDER BY s) AS r FROM UNNEST(['c','a','b']) AS t(s)",
  );
  assert.equal(v, 'a,b,c');
});

test('ANY_VALUE returns one of the values', async () => {
  const v = await scalar('SELECT ANY_VALUE(n) AS r FROM UNNEST([5, 7, 9]) AS t(n)');
  assert.ok([5, 7, 9].map(String).includes(String(v)));
});

test('LOGICAL_AND / LOGICAL_OR aggregate booleans', async () => {
  // BQ wires BOOL as the literal strings "true" / "false".
  assert.equal(
    await scalar('SELECT LOGICAL_AND(b) AS r FROM UNNEST([true, true]) AS t(b)'),
    'true',
  );
  assert.equal(
    await scalar('SELECT LOGICAL_OR(b) AS r FROM UNNEST([false, true]) AS t(b)'),
    'true',
  );
});

test('BIT_AND / BIT_OR / BIT_XOR aggregate integers', async () => {
  assert.equal(await scalar('SELECT BIT_AND(n) AS r FROM UNNEST([7, 6, 5]) AS t(n)'), '4');
  assert.equal(await scalar('SELECT BIT_OR(n) AS r FROM UNNEST([1, 2, 4]) AS t(n)'), '7');
  assert.equal(await scalar('SELECT BIT_XOR(n) AS r FROM UNNEST([1, 2, 3]) AS t(n)'), '0');
});

test('COUNTIF counts rows matching a predicate', async () => {
  const v = await scalar('SELECT COUNTIF(n > 1) AS r FROM UNNEST([0, 1, 2, 3]) AS t(n)');
  assert.equal(v, '2');
});

test('MIN / MAX over a column', async () => {
  assert.equal(await scalar('SELECT MIN(n) AS r FROM UNNEST([3, 1, 2]) AS t(n)'), '1');
  assert.equal(await scalar('SELECT MAX(n) AS r FROM UNNEST([3, 1, 2]) AS t(n)'), '3');
});

test('ARRAY_CONCAT_AGG concatenates arrays into one', async () => {
  // Build a CTE of two array rows; ARRAY_CONCAT_AGG flattens into one array.
  const v = await scalar(
    'WITH t AS (SELECT [1,2] AS a UNION ALL SELECT [3,4]) SELECT ARRAY_CONCAT_AGG(a) AS r FROM t',
  );
  // Order depends on grouping in DuckDB; assert both elements present in some order.
  assert.deepEqual((v as string[]).sort(), ['1', '2', '3', '4']);
});

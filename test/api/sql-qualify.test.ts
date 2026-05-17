/**
 * BL-057 — QUALIFY clause for filtering on window-function results.
 *
 * DuckDB supports QUALIFY with BQ-compatible semantics (filter applied
 * after the window functions evaluate), so the translator passes it
 * through verbatim.
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
const PROJECT = 'sql-qualify';
const DATASET = 'ds';

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [...createDatasetRoutes(db), ...createTableRoutes(db), ...createQueriesRoutes(db)],
  });
  await server.listen(0);
  await fetch(`${server.url}/projects/${PROJECT}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: DATASET } }),
  });
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'sales' },
      schema: {
        fields: [
          { name: 'region', type: 'STRING' },
          { name: 'product', type: 'STRING' },
          { name: 'amount', type: 'INT64' },
        ],
      },
    }),
  });
  await postQuery(
    `INSERT INTO \`${DATASET}.sales\` VALUES
       ('east','a',10),('east','b',20),('east','c',5),
       ('west','a',30),('west','b',40),('west','c',15)`,
  );
});
after(async () => {
  await server.close();
  await db.close();
});

interface QueryResponse {
  rows?: Array<{ f: Array<{ v: string | null }> }>;
}

async function postQuery(query: string): Promise<QueryResponse> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return (await res.json()) as QueryResponse;
}

async function selectRows(query: string): Promise<Array<Array<string | null>>> {
  return ((await postQuery(query)).rows ?? []).map((row) => row.f.map((f) => f.v));
}

// ---------------------------------------------------------------------------
// QUALIFY with an inline window expression — top-N-per-partition
// ---------------------------------------------------------------------------

test('QUALIFY ROW_NUMBER() OVER (…) <= N keeps the top N per partition', async () => {
  const rows = await selectRows(
    `SELECT region, product, amount
     FROM \`${DATASET}.sales\`
     QUALIFY ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC) <= 2
     ORDER BY region, amount DESC`,
  );
  assert.deepEqual(rows, [
    ['east', 'b', '20'],
    ['east', 'a', '10'],
    ['west', 'b', '40'],
    ['west', 'a', '30'],
  ]);
});

// ---------------------------------------------------------------------------
// QUALIFY referencing a SELECT-list alias for a window expression
// ---------------------------------------------------------------------------

test('QUALIFY can reference a window-function alias from SELECT', async () => {
  const rows = await selectRows(
    `SELECT region, product, amount,
            ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC) AS rn
     FROM \`${DATASET}.sales\`
     QUALIFY rn <= 2
     ORDER BY region, amount DESC`,
  );
  assert.deepEqual(rows, [
    ['east', 'b', '20', '1'],
    ['east', 'a', '10', '2'],
    ['west', 'b', '40', '1'],
    ['west', 'a', '30', '2'],
  ]);
});

// ---------------------------------------------------------------------------
// QUALIFY with RANK + WITH TIES semantics via DENSE_RANK
// ---------------------------------------------------------------------------

test('QUALIFY DENSE_RANK = 1 keeps every row tied for the top within partition', async () => {
  // Insert a tie so DENSE_RANK=1 catches both.
  await postQuery(`INSERT INTO \`${DATASET}.sales\` VALUES ('east','d',20)`);
  const rows = await selectRows(
    `SELECT region, product, amount
     FROM \`${DATASET}.sales\`
     WHERE region = 'east'
     QUALIFY DENSE_RANK() OVER (PARTITION BY region ORDER BY amount DESC) = 1
     ORDER BY product`,
  );
  // Both 'b' and 'd' tied at amount=20 (the partition max).
  assert.deepEqual(rows, [
    ['east', 'b', '20'],
    ['east', 'd', '20'],
  ]);
});

// ---------------------------------------------------------------------------
// QUALIFY in combination with WHERE — WHERE applies first, QUALIFY second
// ---------------------------------------------------------------------------

test('WHERE + QUALIFY: WHERE narrows the partition, QUALIFY filters its windowed result', async () => {
  const rows = await selectRows(
    `SELECT region, product, amount
     FROM \`${DATASET}.sales\`
     WHERE amount >= 10
     QUALIFY ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount) = 1
     ORDER BY region`,
  );
  assert.deepEqual(rows, [
    // east: 'a' (10) wins (after WHERE excludes 'c'=5)
    ['east', 'a', '10'],
    // west: 'c' (15) wins
    ['west', 'c', '15'],
  ]);
});

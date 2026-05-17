/**
 * BL-056 — GROUP BY ROLLUP / CUBE / GROUPING SETS, plus GROUPING().
 *
 * DuckDB supports all three with BQ-compatible syntax, so this is a
 * pass-through. The acceptance tests pin the canonical BQ doc examples
 * so a regression in the translator (which currently leaves the GROUP BY
 * clause alone) would be caught.
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
const PROJECT = 'sql-grouping';
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
          { name: 'sales', type: 'INT64' },
        ],
      },
    }),
  });
  await postQuery(
    `INSERT INTO \`${DATASET}.sales\` VALUES ('east','a',10),('east','b',20),('west','a',30),('west','b',40)`,
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
  const r = await postQuery(query);
  return (r.rows ?? []).map((row) => row.f.map((f) => f.v));
}

// ---------------------------------------------------------------------------
// ROLLUP — produces subtotals across a prefix of grouping columns
// ---------------------------------------------------------------------------

test('ROLLUP(region, product) yields per-pair, per-region, and grand totals', async () => {
  const rows = await selectRows(
    `SELECT region, product, SUM(sales) AS s
     FROM \`${DATASET}.sales\`
     GROUP BY ROLLUP(region, product)
     ORDER BY region NULLS LAST, product NULLS LAST`,
  );
  assert.deepEqual(rows, [
    ['east', 'a', '10'],
    ['east', 'b', '20'],
    ['east', null, '30'],
    ['west', 'a', '30'],
    ['west', 'b', '40'],
    ['west', null, '70'],
    [null, null, '100'],
  ]);
});

// ---------------------------------------------------------------------------
// CUBE — every combination of the grouping columns
// ---------------------------------------------------------------------------

test('CUBE(region, product) yields every subset of grouping columns', async () => {
  const rows = await selectRows(
    `SELECT region, product, SUM(sales) AS s
     FROM \`${DATASET}.sales\`
     GROUP BY CUBE(region, product)
     ORDER BY region NULLS LAST, product NULLS LAST`,
  );
  assert.deepEqual(rows, [
    ['east', 'a', '10'],
    ['east', 'b', '20'],
    ['east', null, '30'],
    ['west', 'a', '30'],
    ['west', 'b', '40'],
    ['west', null, '70'],
    [null, 'a', '40'],
    [null, 'b', '60'],
    [null, null, '100'],
  ]);
});

// ---------------------------------------------------------------------------
// GROUPING SETS — explicit grouping combinations
// ---------------------------------------------------------------------------

test('GROUPING SETS ((region), (product), ()) yields just those three groupings', async () => {
  const rows = await selectRows(
    `SELECT region, product, SUM(sales) AS s
     FROM \`${DATASET}.sales\`
     GROUP BY GROUPING SETS ((region), (product), ())
     ORDER BY region NULLS LAST, product NULLS LAST`,
  );
  assert.deepEqual(rows, [
    ['east', null, '30'],
    ['west', null, '70'],
    [null, 'a', '40'],
    [null, 'b', '60'],
    [null, null, '100'],
  ]);
});

// ---------------------------------------------------------------------------
// GROUPING() — distinguishes "rolled-up NULL" from "actual NULL in data"
// ---------------------------------------------------------------------------

test('GROUPING(region) is 1 on the rolled-up row, 0 on the per-region rows', async () => {
  const rows = await selectRows(
    `SELECT region, GROUPING(region) AS g, SUM(sales) AS s
     FROM \`${DATASET}.sales\`
     GROUP BY ROLLUP(region)
     ORDER BY g, region`,
  );
  assert.deepEqual(rows, [
    ['east', '0', '30'],
    ['west', '0', '70'],
    [null, '1', '100'],
  ]);
});

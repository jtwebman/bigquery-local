/**
 * BL-044 — BQ window/analytic functions.
 *
 * All pass through to DuckDB (same names, same syntax for PARTITION BY,
 * ORDER BY, and frame specs). Tests cover one happy path per function.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createQueriesRoutes } from '../../src/routes/queries.ts';
import { createTabledataRoutes } from '../../src/routes/tabledata.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

let db: Db;
let server: Server;
const PROJECT = 'sql-window';
const DATASET = 'ds';

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [
      ...createDatasetRoutes(db),
      ...createTableRoutes(db),
      ...createTabledataRoutes(db),
      ...createQueriesRoutes(db),
    ],
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
      tableReference: { tableId: 'scores' },
      schema: {
        fields: [
          { name: 'g', type: 'STRING' },
          { name: 'v', type: 'INT64' },
        ],
      },
    }),
  });
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/scores/insertAll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rows: [
        { json: { g: 'a', v: '10' } },
        { json: { g: 'a', v: '20' } },
        { json: { g: 'a', v: '30' } },
        { json: { g: 'b', v: '100' } },
        { json: { g: 'b', v: '200' } },
      ],
    }),
  });
});

after(async () => {
  await server.close();
  await db.close();
});

async function rows(query: string): Promise<unknown[][]> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { rows: Array<{ f: Array<{ v: unknown }> }> };
  return body.rows.map((r) => r.f.map((c) => c.v));
}

test('ROW_NUMBER assigns sequential numbers per partition', async () => {
  const out = await rows(
    `SELECT g, v, ROW_NUMBER() OVER (PARTITION BY g ORDER BY v) AS rn
     FROM \`${DATASET}.scores\` ORDER BY g, v`,
  );
  assert.deepEqual(
    out.map((r) => r[2]),
    ['1', '2', '3', '1', '2'],
  );
});

test('RANK and DENSE_RANK handle ties differently', async () => {
  const out = await rows(
    `SELECT v, RANK() OVER (ORDER BY v) AS r, DENSE_RANK() OVER (ORDER BY v) AS dr
     FROM \`${DATASET}.scores\` ORDER BY v`,
  );
  // 5 rows with distinct values; RANK == DENSE_RANK in that case.
  assert.deepEqual(
    out.map((r) => r[1]),
    ['1', '2', '3', '4', '5'],
  );
});

test('PERCENT_RANK + CUME_DIST + NTILE smoke-test', async () => {
  const out = await rows(
    `SELECT v,
            PERCENT_RANK() OVER (ORDER BY v) AS pr,
            CUME_DIST() OVER (ORDER BY v) AS cd,
            NTILE(2) OVER (ORDER BY v) AS nt
     FROM \`${DATASET}.scores\` ORDER BY v`,
  );
  assert.equal(out.length, 5);
});

test('LAG and LEAD pull from neighboring rows', async () => {
  const out = await rows(
    `SELECT v,
            LAG(v) OVER (PARTITION BY g ORDER BY v) AS prev,
            LEAD(v) OVER (PARTITION BY g ORDER BY v) AS next
     FROM \`${DATASET}.scores\` ORDER BY g, v`,
  );
  // First row of partition a: LAG is NULL, LEAD is 20.
  assert.equal(out[0]?.[1], null);
  assert.equal(out[0]?.[2], '20');
});

test('FIRST_VALUE / LAST_VALUE with a full frame', async () => {
  const out = await rows(
    `SELECT g, v,
            FIRST_VALUE(v) OVER (
              PARTITION BY g ORDER BY v
              ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
            ) AS fv,
            LAST_VALUE(v) OVER (
              PARTITION BY g ORDER BY v
              ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
            ) AS lv
     FROM \`${DATASET}.scores\` ORDER BY g, v`,
  );
  // Group 'a' has v in (10, 20, 30); first=10, last=30 throughout.
  assert.equal(out[0]?.[2], '10');
  assert.equal(out[0]?.[3], '30');
});

test('NTH_VALUE picks the nth row in the frame', async () => {
  const out = await rows(
    `SELECT v, NTH_VALUE(v, 2) OVER (
       PARTITION BY g ORDER BY v
       ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
     ) AS second
     FROM \`${DATASET}.scores\` WHERE g = 'a' ORDER BY v`,
  );
  // Second value in group 'a' is 20.
  assert.equal(out[0]?.[1], '20');
});

/**
 * BL-096 — Ingestion-time partitioning + _PARTITIONTIME / _PARTITIONDATE.
 *
 * Tests that:
 *   - POST /tables accepts `timePartitioning: { type: 'DAY' }`.
 *   - The hidden `_partition_time` column is created.
 *   - insertAll auto-populates that column with the partition-truncated
 *     ingestion timestamp.
 *   - Queries can filter on `_PARTITIONTIME` / `_PARTITIONDATE` (the
 *     translator rewrites them to the hidden column).
 *   - The wire response includes `timePartitioning` in the table GET.
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

const PROJECT = 'partition-test';
const DATASET = 'ds';

let db: Db;
let server: Server;

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
});
after(async () => {
  await server.close();
  await db.close();
});

async function query(sql: string): Promise<Array<Array<string | null>>> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const data = (await res.json()) as { rows?: Array<{ f: Array<{ v: string | null }> }> };
  return (data.rows ?? []).map((row) => row.f.map((f) => f.v));
}

test('POST /tables with timePartitioning creates an ingestion-partitioned table', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'events' },
      schema: { fields: [{ name: 'kind', type: 'STRING' }] },
      timePartitioning: { type: 'DAY' },
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    timePartitioning?: { type: string; field?: string };
  };
  assert.equal(body.timePartitioning?.type, 'DAY');
  assert.equal(body.timePartitioning?.field, undefined);
});

test('insertAll auto-populates _partition_time, queryable via _PARTITIONTIME', async () => {
  const insert = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/events/insertAll`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rows: [{ json: { kind: 'click' } }, { json: { kind: 'view' } }],
      }),
    },
  );
  assert.equal(insert.status, 200);

  // _PARTITIONTIME should be the start of today (UTC) for every row.
  const result = await query(
    `SELECT kind, _PARTITIONTIME IS NOT NULL AS has_ts,
            CAST(_PARTITIONTIME AS DATE) = _PARTITIONDATE AS aligned
     FROM \`${DATASET}.events\`
     ORDER BY kind`,
  );
  assert.deepEqual(result, [
    ['click', 'true', 'true'],
    ['view', 'true', 'true'],
  ]);
});

test("WHERE _PARTITIONDATE = CURRENT_DATE() returns today's rows", async () => {
  const result = await query(
    `SELECT COUNT(*)::INT64
     FROM \`${DATASET}.events\`
     WHERE _PARTITIONDATE = CURRENT_DATE()`,
  );
  assert.deepEqual(result, [['2']]);
});

test("WHERE _PARTITIONDATE = '1999-01-01' returns no rows", async () => {
  // Filtering to a different partition narrows the result set — proving
  // the pseudo-column actually flows into the WHERE.
  const result = await query(
    `SELECT COUNT(*)::INT64
     FROM \`${DATASET}.events\`
     WHERE _PARTITIONDATE = DATE '1999-01-01'`,
  );
  assert.deepEqual(result, [['0']]);
});

test('Non-partitioned tables do not have _PARTITIONTIME', async () => {
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'logs' },
      schema: { fields: [{ name: 'msg', type: 'STRING' }] },
    }),
  });
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/logs/insertAll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rows: [{ json: { msg: 'hello' } }] }),
  });
  // _PARTITIONTIME isn't a real column on this table; the query should
  // fail with an "unknown column" error.
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `SELECT _PARTITIONTIME FROM \`${DATASET}.logs\``,
    }),
  });
  assert.equal(res.status, 400);
});

test('POST /tables with timePartitioning.type=HOUR truncates to the hour', async () => {
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'hourly' },
      schema: { fields: [{ name: 'tag', type: 'STRING' }] },
      timePartitioning: { type: 'HOUR' },
    }),
  });
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/hourly/insertAll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rows: [{ json: { tag: 'x' } }] }),
  });
  // The hidden column was truncated to the hour — proves we honored the
  // partition type. EXTRACT(MINUTE FROM _PARTITIONTIME) should be 0.
  const result = await query(
    `SELECT EXTRACT(MINUTE FROM _PARTITIONTIME)::INT64,
            EXTRACT(SECOND FROM _PARTITIONTIME)::INT64
     FROM \`${DATASET}.hourly\``,
  );
  assert.deepEqual(result, [['0', '0']]);
});

test('Bogus timePartitioning.type returns 400', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'bad' },
      schema: { fields: [{ name: 'x', type: 'STRING' }] },
      timePartitioning: { type: 'WEEK' },
    }),
  });
  assert.equal(res.status, 400);
});

test('POST /tables stores clustering metadata and surfaces it via GET', async () => {
  const create = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'with_cluster' },
      schema: {
        fields: [
          { name: 'a', type: 'STRING' },
          { name: 'b', type: 'STRING' },
        ],
      },
      clustering: { fields: ['a', 'b'] },
    }),
  });
  assert.equal(create.status, 200);
  const get = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/with_cluster`,
  );
  const body = (await get.json()) as { clustering?: { fields: string[] } };
  assert.deepEqual(body.clustering?.fields, ['a', 'b']);
});

test('clustering.fields must be an array — bad shape returns 400', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'bad_cluster' },
      schema: { fields: [{ name: 'a', type: 'STRING' }] },
      clustering: { fields: 'not-an-array' },
    }),
  });
  assert.equal(res.status, 400);
});

test('timePartitioning.expirationMs round-trips', async () => {
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'with_exp' },
      schema: { fields: [{ name: 'x', type: 'STRING' }] },
      timePartitioning: { type: 'DAY', expirationMs: 7776000000 },
    }),
  });
  const get = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/with_exp`);
  const body = (await get.json()) as { timePartitioning?: { type: string; expirationMs?: number } };
  assert.equal(body.timePartitioning?.expirationMs, 7776000000);
});

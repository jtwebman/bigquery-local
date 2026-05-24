/**
 * BL-097 — Column partitioning + BL-100 clustering keys.
 *
 * Column partitioning differs from ingestion-time partitioning (BL-096)
 * in that the partition column is a real user-named column on the
 * table — not a hidden `_partition_time`. Queries filter via the
 * column's normal value; the partitioning metadata is informational
 * for `INFORMATION_SCHEMA.COLUMNS.is_partitioning_column`.
 *
 * Clustering: stored as metadata, surfaced via INFORMATION_SCHEMA and
 * GET /tables. v0 doesn't physically sort rows on insert (no observable
 * difference at our scale).
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

const PROJECT = 'col-part-test';
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

// ---------------------------------------------------------------------------
// BL-097 — column partitioning
// ---------------------------------------------------------------------------

test('Column-partitioned table stores partition.field and exposes it via GET', async () => {
  const create = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'orders' },
      schema: {
        fields: [
          { name: 'id', type: 'INT64' },
          { name: 'order_date', type: 'DATE' },
          { name: 'amount', type: 'FLOAT64' },
        ],
      },
      timePartitioning: { type: 'DAY', field: 'order_date' },
    }),
  });
  assert.equal(create.status, 200);
  const body = (await create.json()) as {
    timePartitioning?: { type: string; field?: string };
  };
  assert.equal(body.timePartitioning?.type, 'DAY');
  assert.equal(body.timePartitioning?.field, 'order_date');
});

test('Column-partitioned tables do NOT add a hidden _partition_time column', async () => {
  // INFORMATION_SCHEMA.COLUMNS shows exactly the user columns.
  const cols = await query(
    `SELECT column_name FROM ${DATASET}.INFORMATION_SCHEMA.COLUMNS
     WHERE table_name = 'orders'
     ORDER BY ordinal_position`,
  );
  assert.deepEqual(cols, [['id'], ['order_date'], ['amount']]);
});

test('is_partitioning_column = YES for the partition column, NO for the others', async () => {
  const cols = await query(
    `SELECT column_name, is_partitioning_column
     FROM ${DATASET}.INFORMATION_SCHEMA.COLUMNS
     WHERE table_name = 'orders'
     ORDER BY ordinal_position`,
  );
  assert.deepEqual(cols, [
    ['id', 'NO'],
    ['order_date', 'YES'],
    ['amount', 'NO'],
  ]);
});

test('insertAll into a column-partitioned table stores rows; WHERE on partition col filters', async () => {
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/orders/insertAll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rows: [
        { json: { id: 1, order_date: '2026-05-20', amount: 9.99 } },
        { json: { id: 2, order_date: '2026-05-21', amount: 12.5 } },
        { json: { id: 3, order_date: '2026-05-20', amount: 7.0 } },
      ],
    }),
  });

  // WHERE on the partition column behaves like any column filter — and
  // crucially does NOT need _PARTITIONTIME (which isn't available on
  // column-partitioned tables in BQ).
  const filtered = await query(
    `SELECT id::INT64 FROM \`${DATASET}.orders\`
     WHERE order_date = DATE '2026-05-20'
     ORDER BY id`,
  );
  assert.deepEqual(filtered, [['1'], ['3']]);
});

test('_PARTITIONTIME is unavailable on column-partitioned tables (no hidden column)', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `SELECT _PARTITIONTIME FROM \`${DATASET}.orders\``,
    }),
  });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// BL-100 — clustering keys
// ---------------------------------------------------------------------------

test('Table with clustering stores fields and surfaces them via INFORMATION_SCHEMA', async () => {
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'sessions' },
      schema: {
        fields: [
          { name: 'user_id', type: 'STRING' },
          { name: 'session_id', type: 'STRING' },
          { name: 'started_at', type: 'TIMESTAMP' },
        ],
      },
      clustering: { fields: ['user_id', 'session_id'] },
    }),
  });
  const cols = await query(
    `SELECT column_name, clustering_ordinal_position
     FROM ${DATASET}.INFORMATION_SCHEMA.COLUMNS
     WHERE table_name = 'sessions' AND clustering_ordinal_position IS NOT NULL
     ORDER BY clustering_ordinal_position`,
  );
  assert.deepEqual(cols, [
    ['user_id', '1'],
    ['session_id', '2'],
  ]);
});

test('PATCH can update clustering on an existing table', async () => {
  // Already created above with [user_id, session_id]. Patch to add a third.
  const patch = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/sessions`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clustering: { fields: ['user_id', 'session_id', 'started_at'] },
      }),
    },
  );
  assert.equal(patch.status, 200);
  const body = (await patch.json()) as { clustering?: { fields: string[] } };
  assert.deepEqual(body.clustering?.fields, ['user_id', 'session_id', 'started_at']);
});

test('PATCH preserves existing clustering when not provided in the body', async () => {
  const patch = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/sessions`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'updated' }),
    },
  );
  assert.equal(patch.status, 200);
  const body = (await patch.json()) as {
    description?: string;
    clustering?: { fields: string[] };
  };
  assert.equal(body.description, 'updated');
  assert.deepEqual(body.clustering?.fields, ['user_id', 'session_id', 'started_at']);
});

test('PATCH cannot change timePartitioning', async () => {
  // Try to flip orders from column to ingestion-time partitioning.
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/orders`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ timePartitioning: { type: 'DAY' } }),
  });
  assert.equal(res.status, 400);
});

test('PATCH accepts an unchanged timePartitioning (idempotent full-resource PATCH)', async () => {
  // Echoing back the same partitioning shape should not error — clients
  // commonly do a GET-then-PATCH round-trip.
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/orders`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      timePartitioning: { type: 'DAY', field: 'order_date' },
    }),
  });
  assert.equal(res.status, 200);
});

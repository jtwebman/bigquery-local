/**
 * BL-075 — INFORMATION_SCHEMA.TABLES / COLUMNS / COLUMN_FIELD_PATHS /
 * TABLE_OPTIONS.
 *
 * Exercises both region-scoped (`\`region-us\`.INFORMATION_SCHEMA.X`) and
 * dataset-scoped (`<dataset>.INFORMATION_SCHEMA.X`) reference forms, plus
 * `\`project.region\``, `\`project.dataset\``, and bare
 * `project.dataset.INFORMATION_SCHEMA.X`.
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
const PROJECT = 'is-test';
const DATASET_A = 'sales';
const DATASET_B = 'logs';

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [...createDatasetRoutes(db), ...createTableRoutes(db), ...createQueriesRoutes(db)],
  });
  await server.listen(0);

  await postJson(`/projects/${PROJECT}/datasets`, {
    datasetReference: { datasetId: DATASET_A },
  });
  await postJson(`/projects/${PROJECT}/datasets`, {
    datasetReference: { datasetId: DATASET_B },
  });

  // sales.orders — scalars + REPEATED. Partitioning + clustering are
  // exercised separately in test/unit/meta.test.ts via upsertTable, since
  // the tables route doesn't wire those fields yet (BL-096 / BL-100).
  await postJson(`/projects/${PROJECT}/datasets/${DATASET_A}/tables`, {
    tableReference: { tableId: 'orders' },
    description: 'Order facts',
    schema: {
      fields: [
        { name: 'order_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'customer_id', type: 'STRING' },
        { name: 'amount', type: 'NUMERIC' },
        { name: 'tags', type: 'STRING', mode: 'REPEATED' },
        { name: 'order_ts', type: 'TIMESTAMP' },
      ],
    },
  });

  // sales.customers — STRUCT nesting so COLUMN_FIELD_PATHS has something to do.
  await postJson(`/projects/${PROJECT}/datasets/${DATASET_A}/tables`, {
    tableReference: { tableId: 'customers' },
    schema: {
      fields: [
        { name: 'id', type: 'STRING', mode: 'REQUIRED' },
        {
          name: 'address',
          type: 'STRUCT',
          fields: [
            { name: 'city', type: 'STRING' },
            { name: 'zip', type: 'STRING' },
          ],
        },
      ],
    },
  });

  // logs.events — different dataset to verify the schema filter.
  await postJson(`/projects/${PROJECT}/datasets/${DATASET_B}/tables`, {
    tableReference: { tableId: 'events' },
    schema: {
      fields: [
        { name: 'ts', type: 'TIMESTAMP' },
        { name: 'kind', type: 'STRING' },
      ],
    },
  });
});

after(async () => {
  await server.close();
  await db.close();
});

interface QueryResponse {
  rows?: Array<{ f: Array<{ v: unknown }> }>;
  schema?: { fields: Array<{ name: string }> };
}

async function postJson(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} ${res.status}: ${await res.text()}`);
}

async function query(sql: string): Promise<QueryResponse> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`query failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as QueryResponse;
}

async function rows(sql: string): Promise<Array<Array<string | null>>> {
  return ((await query(sql)).rows ?? []).map((row) =>
    row.f.map((f) => (f.v === null || f.v === undefined ? null : String(f.v))),
  );
}

// ---------------------------------------------------------------------------
// TABLES
// ---------------------------------------------------------------------------

test('region-scoped `region-us`.INFORMATION_SCHEMA.TABLES lists all tables in project', async () => {
  const result = await rows(
    `SELECT table_schema, table_name, table_type, is_insertable_into
     FROM \`region-us\`.INFORMATION_SCHEMA.TABLES
     ORDER BY table_schema, table_name`,
  );
  assert.deepEqual(result, [
    ['logs', 'events', 'BASE TABLE', 'YES'],
    ['sales', 'customers', 'BASE TABLE', 'YES'],
    ['sales', 'orders', 'BASE TABLE', 'YES'],
  ]);
});

test('dataset-scoped `<dataset>.INFORMATION_SCHEMA.TABLES filters to that dataset', async () => {
  const result = await rows(
    `SELECT table_name FROM ${DATASET_A}.INFORMATION_SCHEMA.TABLES
     ORDER BY table_name`,
  );
  assert.deepEqual(result, [['customers'], ['orders']]);
});

test('`project.region`.INFORMATION_SCHEMA.TABLES scopes by project', async () => {
  const result = await rows(
    `SELECT count(*)::INT64 FROM \`${PROJECT}.region-us\`.INFORMATION_SCHEMA.TABLES`,
  );
  assert.deepEqual(result, [['3']]);
});

// ---------------------------------------------------------------------------
// COLUMNS
// ---------------------------------------------------------------------------

test('INFORMATION_SCHEMA.COLUMNS returns one row per top-level column with BQ types', async () => {
  const result = await rows(
    `SELECT column_name, ordinal_position, is_nullable, data_type
     FROM ${DATASET_A}.INFORMATION_SCHEMA.COLUMNS
     WHERE table_name = 'orders'
     ORDER BY ordinal_position`,
  );
  assert.deepEqual(result, [
    ['order_id', '1', 'NO', 'STRING'],
    ['customer_id', '2', 'YES', 'STRING'],
    ['amount', '3', 'YES', 'NUMERIC'],
    ['tags', '4', 'YES', 'ARRAY<STRING>'],
    ['order_ts', '5', 'YES', 'TIMESTAMP'],
  ]);
});

test('INFORMATION_SCHEMA.COLUMNS renders STRUCT data_type with nested field list', async () => {
  const result = await rows(
    `SELECT column_name, data_type
     FROM ${DATASET_A}.INFORMATION_SCHEMA.COLUMNS
     WHERE table_name = 'customers'
     ORDER BY ordinal_position`,
  );
  assert.deepEqual(result, [
    ['id', 'STRING'],
    ['address', 'STRUCT<city STRING, zip STRING>'],
  ]);
});

// ---------------------------------------------------------------------------
// COLUMN_FIELD_PATHS
// ---------------------------------------------------------------------------

test('INFORMATION_SCHEMA.COLUMN_FIELD_PATHS yields one row per nested path', async () => {
  const result = await rows(
    `SELECT column_name, field_path, data_type
     FROM ${DATASET_A}.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS
     WHERE table_name = 'customers'
     ORDER BY column_name, field_path`,
  );
  assert.deepEqual(result, [
    ['address', 'address', 'STRUCT<city STRING, zip STRING>'],
    ['address', 'address.city', 'STRING'],
    ['address', 'address.zip', 'STRING'],
    ['id', 'id', 'STRING'],
  ]);
});

// ---------------------------------------------------------------------------
// TABLE_OPTIONS
// ---------------------------------------------------------------------------

test('INFORMATION_SCHEMA.TABLE_OPTIONS exposes description as a string-typed option', async () => {
  const result = await rows(
    `SELECT table_name, option_name, option_type, option_value
     FROM ${DATASET_A}.INFORMATION_SCHEMA.TABLE_OPTIONS
     WHERE table_name = 'orders'`,
  );
  assert.deepEqual(result, [['orders', 'description', 'STRING', '"Order facts"']]);
});

// ---------------------------------------------------------------------------
// Unsupported view → clear error
// ---------------------------------------------------------------------------

test('Querying an unsupported INFORMATION_SCHEMA view fails with unsupportedFeature', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `SELECT * FROM \`region-us\`.INFORMATION_SCHEMA.JOBS`,
    }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: { errors?: Array<{ reason: string }> } };
  assert.equal(body.error?.errors?.[0]?.reason, 'unsupportedFeature');
});

// ---------------------------------------------------------------------------
// Schema filter — dataset-scoped query never leaks across datasets
// ---------------------------------------------------------------------------

test('Dataset-scoped INFORMATION_SCHEMA does not return rows from other datasets', async () => {
  const result = await rows(`SELECT table_name FROM ${DATASET_B}.INFORMATION_SCHEMA.TABLES`);
  assert.deepEqual(result, [['events']]);
});

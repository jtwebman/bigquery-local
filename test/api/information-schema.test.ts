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

  // A view over sales.orders — visible to INFORMATION_SCHEMA.VIEWS.
  await postJson(`/projects/${PROJECT}/queries`, {
    query: `CREATE VIEW \`${DATASET_A}.recent_orders\` AS SELECT order_id FROM \`${DATASET_A}.orders\``,
  });

  // A SQL UDF and a procedure — visible to INFORMATION_SCHEMA.ROUTINES.
  await postJson(`/projects/${PROJECT}/queries`, {
    query: `CREATE FUNCTION \`${DATASET_A}.double_amount\`(x INT64) RETURNS INT64 AS (x * 2)`,
  });
  await postJson(`/projects/${PROJECT}/queries`, {
    query: `CREATE PROCEDURE \`${DATASET_A}.log_msg\`(IN msg STRING, OUT result STRING)
            BEGIN
              SET result = CONCAT('logged: ', msg);
            END`,
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

test('region-scoped `region-us`.INFORMATION_SCHEMA.TABLES lists all tables + views in project', async () => {
  const result = await rows(
    `SELECT table_schema, table_name, table_type, is_insertable_into
     FROM \`region-us\`.INFORMATION_SCHEMA.TABLES
     ORDER BY table_schema, table_name`,
  );
  assert.deepEqual(result, [
    ['logs', 'events', 'BASE TABLE', 'YES'],
    ['sales', 'customers', 'BASE TABLE', 'YES'],
    ['sales', 'orders', 'BASE TABLE', 'YES'],
    ['sales', 'recent_orders', 'VIEW', 'NO'],
  ]);
});

test('dataset-scoped `<dataset>.INFORMATION_SCHEMA.TABLES filters to that dataset', async () => {
  const result = await rows(
    `SELECT table_name FROM ${DATASET_A}.INFORMATION_SCHEMA.TABLES
     ORDER BY table_name`,
  );
  assert.deepEqual(result, [['customers'], ['orders'], ['recent_orders']]);
});

test('`project.region`.INFORMATION_SCHEMA.TABLES scopes by project', async () => {
  const result = await rows(
    `SELECT count(*)::INT64 FROM \`${PROJECT}.region-us\`.INFORMATION_SCHEMA.TABLES`,
  );
  assert.deepEqual(result, [['4']]);
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
// VIEWS / MATERIALIZED_VIEWS (BL-076)
// ---------------------------------------------------------------------------

test('INFORMATION_SCHEMA.VIEWS lists views with view_definition + use_standard_sql=YES', async () => {
  const result = await rows(
    `SELECT table_schema, table_name, view_definition, check_option, use_standard_sql
     FROM ${DATASET_A}.INFORMATION_SCHEMA.VIEWS`,
  );
  assert.equal(result.length, 1);
  const [schema, name, definition, checkOption, useStd] = result[0] as Array<string | null>;
  assert.equal(schema, DATASET_A);
  assert.equal(name, 'recent_orders');
  assert.match(definition ?? '', /SELECT order_id FROM/);
  assert.equal(checkOption, null);
  assert.equal(useStd, 'YES');
});

test('INFORMATION_SCHEMA.VIEWS excludes base tables', async () => {
  const result = await rows(
    `SELECT table_name FROM \`region-us\`.INFORMATION_SCHEMA.VIEWS ORDER BY table_name`,
  );
  assert.deepEqual(result, [['recent_orders']]);
});

test('INFORMATION_SCHEMA.MATERIALIZED_VIEWS returns no rows until MVs exist (BL-101)', async () => {
  const result = await rows(
    `SELECT count(*)::INT64 FROM \`region-us\`.INFORMATION_SCHEMA.MATERIALIZED_VIEWS`,
  );
  assert.deepEqual(result, [['0']]);
});

// ---------------------------------------------------------------------------
// ROUTINES / PARAMETERS / ROUTINE_OPTIONS (BL-077)
// ---------------------------------------------------------------------------

test('INFORMATION_SCHEMA.ROUTINES lists SQL functions and procedures', async () => {
  const result = await rows(
    `SELECT specific_name, routine_type, data_type, routine_body, routine_definition
     FROM ${DATASET_A}.INFORMATION_SCHEMA.ROUTINES
     ORDER BY specific_name`,
  );
  assert.equal(result.length, 2);
  const [doubleAmount, logMsg] = result as Array<Array<string | null>>;
  assert.equal(doubleAmount?.[0], 'double_amount');
  assert.equal(doubleAmount?.[1], 'FUNCTION');
  assert.equal(doubleAmount?.[2], 'INT64');
  assert.equal(doubleAmount?.[3], 'SQL');
  assert.match(doubleAmount?.[4] ?? '', /x\s*\*\s*2/);
  assert.equal(logMsg?.[0], 'log_msg');
  assert.equal(logMsg?.[1], 'PROCEDURE');
  assert.equal(logMsg?.[2], null);
  assert.equal(logMsg?.[3], 'SQL');
});

test('INFORMATION_SCHEMA.PARAMETERS unnests routine arguments with ordinals + modes', async () => {
  const result = await rows(
    `SELECT specific_name, ordinal_position, parameter_mode, parameter_name, data_type
     FROM ${DATASET_A}.INFORMATION_SCHEMA.PARAMETERS
     ORDER BY specific_name, ordinal_position`,
  );
  assert.deepEqual(result, [
    ['double_amount', '1', 'IN', 'x', 'INT64'],
    ['log_msg', '1', 'IN', 'msg', 'STRING'],
    ['log_msg', '2', 'OUT', 'result', 'STRING'],
  ]);
});

test('INFORMATION_SCHEMA.ROUTINE_OPTIONS is empty (we do not persist options)', async () => {
  const result = await rows(
    `SELECT count(*)::INT64 FROM ${DATASET_A}.INFORMATION_SCHEMA.ROUTINE_OPTIONS`,
  );
  assert.deepEqual(result, [['0']]);
});

test('Routine-shaped views filter by specific_catalog (not table_catalog)', async () => {
  // Cross-project query against a different project's routines returns
  // zero rows — confirms the project filter applies to the right column.
  const result = await rows(
    `SELECT count(*)::INT64
     FROM \`other-project.${DATASET_A}\`.INFORMATION_SCHEMA.ROUTINES`,
  );
  assert.deepEqual(result, [['0']]);
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

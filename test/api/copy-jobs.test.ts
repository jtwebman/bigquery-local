/**
 * BL-095 — Copy jobs.
 *
 * Verifies that a copy job duplicates the source's schema + rows into a
 * fresh destination (auto-created), and honors writeDisposition for
 * append / truncate / empty-only.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createJobsRoutes } from '../../src/routes/jobs.ts';
import { createQueriesRoutes } from '../../src/routes/queries.ts';
import { createTabledataRoutes } from '../../src/routes/tabledata.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

const PROJECT = 'copy-test';
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
      ...createJobsRoutes(db),
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
      tableReference: { tableId: 'orders' },
      schema: {
        fields: [
          { name: 'id', type: 'INT64', mode: 'REQUIRED' },
          { name: 'amount', type: 'FLOAT64' },
        ],
      },
    }),
  });
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/orders/insertAll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rows: [{ json: { id: 1, amount: 9.99 } }, { json: { id: 2, amount: 12.5 } }],
    }),
  });
});
after(async () => {
  await server.close();
  await db.close();
});

interface JobResponse {
  status: { state: string };
  statistics?: { copy?: { copiedRows?: string } };
}

async function postCopy(body: unknown): Promise<{ status: number; body: JobResponse }> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as JobResponse };
}

async function rowsOf(table: string): Promise<Array<Array<string | null>>> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `SELECT id, amount FROM \`${DATASET}.${table}\` ORDER BY id` }),
  });
  const data = (await res.json()) as { rows?: Array<{ f: Array<{ v: string | null }> }> };
  return (data.rows ?? []).map((row) => row.f.map((f) => f.v));
}

test('COPY creates the destination with the source schema + rows', async () => {
  const { status, body } = await postCopy({
    configuration: {
      copy: {
        sourceTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders' },
        destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders_copy' },
      },
    },
  });
  assert.equal(status, 200);
  assert.equal(body.status.state, 'DONE');
  assert.equal(body.statistics?.copy?.copiedRows, '2');

  const rows = await rowsOf('orders_copy');
  assert.deepEqual(rows, [
    ['1', '9.99'],
    ['2', '12.5'],
  ]);
});

test('COPY into an existing non-empty destination with WRITE_EMPTY returns 409', async () => {
  const { status, body } = await postCopy({
    configuration: {
      copy: {
        sourceTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders' },
        destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders_copy' },
      },
    },
  });
  assert.equal(status, 409);
  const err = body as unknown as { error?: { errors?: Array<{ reason: string }> } };
  assert.equal(err.error?.errors?.[0]?.reason, 'duplicate');
});

test('COPY with WRITE_TRUNCATE replaces rows in the destination', async () => {
  const { status, body } = await postCopy({
    configuration: {
      copy: {
        sourceTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders' },
        destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders_copy' },
        writeDisposition: 'WRITE_TRUNCATE',
      },
    },
  });
  assert.equal(status, 200);
  assert.equal(body.statistics?.copy?.copiedRows, '2');
  // Still only 2 rows — the previous 2 were replaced, not duplicated.
  const rows = await rowsOf('orders_copy');
  assert.equal(rows.length, 2);
});

test('COPY with WRITE_APPEND adds rows on top of the destination', async () => {
  const { status } = await postCopy({
    configuration: {
      copy: {
        sourceTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders' },
        destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders_copy' },
        writeDisposition: 'WRITE_APPEND',
      },
    },
  });
  assert.equal(status, 200);
  // Now we have 4 rows: the truncate-then-restore in the previous test
  // left 2, this one adds 2 more.
  const rows = await rowsOf('orders_copy');
  assert.equal(rows.length, 4);
});

test('COPY from a missing source returns 404', async () => {
  const { status } = await postCopy({
    configuration: {
      copy: {
        sourceTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'nonexistent' },
        destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'dst' },
      },
    },
  });
  assert.equal(status, 404);
});

test('CLONE and SNAPSHOT are treated as deep copies in v0', async () => {
  // Both should succeed with operationType set to either variant.
  for (const op of ['CLONE', 'SNAPSHOT']) {
    const { status } = await postCopy({
      configuration: {
        copy: {
          sourceTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders' },
          destinationTable: {
            projectId: PROJECT,
            datasetId: DATASET,
            tableId: `orders_${op.toLowerCase()}`,
          },
          operationType: op,
        },
      },
    });
    assert.equal(status, 200);
  }
});

test('Bogus operationType returns 400', async () => {
  const { status } = await postCopy({
    configuration: {
      copy: {
        sourceTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders' },
        destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'bogus' },
        operationType: 'NOT_A_REAL_OP',
      },
    },
  });
  assert.equal(status, 400);
});

test('Bogus writeDisposition returns 400', async () => {
  const { status } = await postCopy({
    configuration: {
      copy: {
        sourceTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders' },
        destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders_bad' },
        writeDisposition: 'WRITE_WHATEVER',
      },
    },
  });
  assert.equal(status, 400);
});

test('COPY from an empty-schema source returns 400', async () => {
  // Create a table with no fields so the copy fails on the schema check.
  // Building a zero-field schema isn't possible via POST /tables (the
  // route rejects empty fields), but we can roll one in via SQL.
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'no_schema' },
      // Schema with one field — but then we'll patch it out via direct
      // _bq.tables update, which is what real metadata corruption looks
      // like and is more realistic than blocking-via-the-route.
      schema: { fields: [{ name: 'placeholder', type: 'STRING' }] },
    }),
  });
  await db.exec(
    `UPDATE _bq.tables SET "schema" = '{"fields":[]}'::JSON
       WHERE project = $1 AND dataset_id = $2 AND table_id = 'no_schema'`,
    [PROJECT, DATASET],
  );
  const { status, body } = await postCopy({
    configuration: {
      copy: {
        sourceTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'no_schema' },
        destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'dst' },
      },
    },
  });
  assert.equal(status, 400);
  const err = body as unknown as { error?: { errors?: Array<{ reason: string }> } };
  assert.equal(err.error?.errors?.[0]?.reason, 'invalid');
});

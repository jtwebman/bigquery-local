/**
 * List endpoints: GET /projects/{p}/datasets and
 * GET /projects/{p}/datasets/{d}/tables.
 *
 * Both share pagination semantics: `maxResults` (default 50, hard cap 1000),
 * opaque `pageToken` (an offset string), and `nextPageToken` set only when
 * there's more to read.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

interface DatasetListWire {
  kind: string;
  etag: string;
  datasets: Array<{
    kind: string;
    id: string;
    datasetReference: { projectId: string; datasetId: string };
  }>;
  nextPageToken?: string;
}

interface TableListWire {
  kind: string;
  etag: string;
  tables: Array<{
    kind: string;
    id: string;
    tableReference: { projectId: string; datasetId: string; tableId: string };
    type: string;
    creationTime: string;
  }>;
  totalItems: number;
  nextPageToken?: string;
}

interface GoogleErrorBody {
  error: { code: number; errors: Array<{ reason: string; message: string }>; message: string };
}

let db: Db;
let server: Server;

const PROJECT = 'list-tests';

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [...createDatasetRoutes(db), ...createTableRoutes(db)],
  });
  await server.listen(0);
});

after(async () => {
  await server.close();
  await db.close();
});

async function createDataset(id: string): Promise<void> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: id } }),
  });
  assert.equal(res.status, 200);
}

async function createTable(datasetId: string, tableId: string): Promise<void> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${datasetId}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId },
      schema: { fields: [{ name: 'id', type: 'STRING' }] },
    }),
  });
  assert.equal(res.status, 200);
}

// ---------------------------------------------------------------------------
// GET /projects/{p}/datasets
// ---------------------------------------------------------------------------

test('GET /datasets returns an empty list for an unknown project', async () => {
  const res = await fetch(`${server.url}/projects/empty-project/datasets`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as DatasetListWire;
  assert.equal(body.kind, 'bigquery#datasetList');
  assert.deepEqual(body.datasets, []);
  assert.equal(body.nextPageToken, undefined);
});

test('GET /datasets returns all datasets when total <= page size', async () => {
  for (const id of ['ds_a', 'ds_b', 'ds_c']) await createDataset(id);
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as DatasetListWire;
  assert.equal(body.kind, 'bigquery#datasetList');
  assert.equal(body.datasets.length, 3);
  assert.equal(body.nextPageToken, undefined);
  // Each entry has the stripped-down shape (no etag, creationTime, etc.).
  assert.equal(body.datasets[0]?.kind, 'bigquery#dataset');
  assert.deepEqual(
    body.datasets.map((d) => d.datasetReference.datasetId),
    ['ds_a', 'ds_b', 'ds_c'],
  );
  assert.equal(body.datasets[0]?.id, `${PROJECT}:ds_a`);
});

test('GET /datasets paginates with maxResults', async () => {
  // Three datasets already in the project from the previous test.
  const r1 = await fetch(`${server.url}/projects/${PROJECT}/datasets?maxResults=2`);
  const b1 = (await r1.json()) as DatasetListWire;
  assert.equal(b1.datasets.length, 2);
  assert.equal(b1.nextPageToken, '2');
  assert.deepEqual(
    b1.datasets.map((d) => d.datasetReference.datasetId),
    ['ds_a', 'ds_b'],
  );

  const r2 = await fetch(`${server.url}/projects/${PROJECT}/datasets?maxResults=2&pageToken=2`);
  const b2 = (await r2.json()) as DatasetListWire;
  assert.equal(b2.datasets.length, 1);
  assert.equal(b2.nextPageToken, undefined);
  assert.equal(b2.datasets[0]?.datasetReference.datasetId, 'ds_c');
});

test('GET /datasets rejects a bad maxResults', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets?maxResults=0`);
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
});

test('GET /datasets rejects a malformed pageToken', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets?pageToken=hello`);
  assert.equal(res.status, 400);
});

test('GET /datasets clamps maxResults above the hard cap', async () => {
  // Hard cap is 1000; asking for 5000 should not error, just clamp silently.
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets?maxResults=5000`);
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// GET /projects/{p}/datasets/{d}/tables
// ---------------------------------------------------------------------------

test('GET /tables returns 404 when the parent dataset does not exist', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/no_such_ds/tables`);
  assert.equal(res.status, 404);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'notFound');
});

test('GET /tables returns an empty list for a dataset with no tables', async () => {
  await createDataset('ds_empty');
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/ds_empty/tables`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as TableListWire;
  assert.equal(body.kind, 'bigquery#tableList');
  assert.deepEqual(body.tables, []);
  assert.equal(body.totalItems, 0);
});

test('GET /tables paginates with maxResults + pageToken', async () => {
  await createDataset('ds_with_tables');
  for (const id of ['t_a', 't_b', 't_c', 't_d', 't_e']) {
    await createTable('ds_with_tables', id);
  }
  const r1 = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/ds_with_tables/tables?maxResults=2`,
  );
  const b1 = (await r1.json()) as TableListWire;
  assert.equal(b1.tables.length, 2);
  assert.equal(b1.nextPageToken, '2');
  assert.deepEqual(
    b1.tables.map((t) => t.tableReference.tableId),
    ['t_a', 't_b'],
  );
  // totalItems = offset (0) + page length (2) since there's more to read.
  assert.equal(b1.totalItems, 2);

  const r2 = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/ds_with_tables/tables?maxResults=2&pageToken=2`,
  );
  const b2 = (await r2.json()) as TableListWire;
  assert.deepEqual(
    b2.tables.map((t) => t.tableReference.tableId),
    ['t_c', 't_d'],
  );
  assert.equal(b2.nextPageToken, '4');

  const r3 = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/ds_with_tables/tables?maxResults=2&pageToken=4`,
  );
  const b3 = (await r3.json()) as TableListWire;
  assert.equal(b3.tables.length, 1);
  assert.equal(b3.nextPageToken, undefined);
  // Last page: totalItems = offset (4) + 1 = 5 (the true total).
  assert.equal(b3.totalItems, 5);
});

test('GET /tables list entries carry tableReference + type + creationTime', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/ds_with_tables/tables`);
  const body = (await res.json()) as TableListWire;
  const entry = body.tables[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.kind, 'bigquery#table');
  assert.equal(entry.tableReference.projectId, PROJECT);
  assert.equal(entry.tableReference.datasetId, 'ds_with_tables');
  assert.equal(entry.tableReference.tableId, 't_a');
  assert.equal(entry.type, 'TABLE');
  assert.match(entry.creationTime, /^\d+$/);
  assert.equal(entry.id, `${PROJECT}:ds_with_tables.t_a`);
});

test('GET /tables rejects a malformed pageToken', async () => {
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/ds_with_tables/tables?pageToken=-1`,
  );
  assert.equal(res.status, 400);
});

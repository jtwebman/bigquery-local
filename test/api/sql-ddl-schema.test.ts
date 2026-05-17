/**
 * BL-055 — DDL: SCHEMA. SQL surface for dataset metadata (REST parity).
 *
 *   CREATE SCHEMA [IF NOT EXISTS] <name>
 *   DROP   SCHEMA [IF EXISTS]     <name> [CASCADE]
 *
 * The translator's pass-through wouldn't qualify the schema name as
 * `<project>__<datasetId>`, so the DDL path bypasses it: we parse the
 * target ourselves, call `upsertDataset` / `deleteDataset`, and emit
 * the DuckDB DDL directly using `datasetSchemaName`.
 *
 * Acceptance: `CREATE SCHEMA test` makes the dataset visible via REST GET.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createJobsRoutes } from '../../src/routes/jobs.ts';
import { createQueriesRoutes } from '../../src/routes/queries.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

let db: Db;
let server: Server;
const PROJECT = 'sql-ddl-schema';

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [
      ...createDatasetRoutes(db),
      ...createTableRoutes(db),
      ...createQueriesRoutes(db),
      ...createJobsRoutes(db),
    ],
  });
  await server.listen(0);
});
after(async () => {
  await server.close();
  await db.close();
});

async function postQuery(
  query: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function getDataset(
  datasetId: string,
): Promise<{ status: number; json: { datasetReference?: { datasetId: string } } }> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${datasetId}`);
  return {
    status: res.status,
    json: (await res.json()) as { datasetReference?: { datasetId: string } },
  };
}

// ---------------------------------------------------------------------------
// CREATE SCHEMA
// ---------------------------------------------------------------------------

test('CREATE SCHEMA: dataset becomes visible via REST GET', async () => {
  const r = await postQuery('CREATE SCHEMA test_basic');
  assert.equal(r.status, 200);
  const get = await getDataset('test_basic');
  assert.equal(get.status, 200);
  assert.equal(get.json.datasetReference?.datasetId, 'test_basic');
});

test('CREATE SCHEMA on an existing dataset: 409 duplicate', async () => {
  await postQuery('CREATE SCHEMA test_dup');
  const r = await postQuery('CREATE SCHEMA test_dup');
  assert.equal(r.status, 409);
});

test('CREATE SCHEMA IF NOT EXISTS is idempotent', async () => {
  const a = await postQuery('CREATE SCHEMA IF NOT EXISTS test_idem');
  const b = await postQuery('CREATE SCHEMA IF NOT EXISTS test_idem');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const get = await getDataset('test_idem');
  assert.equal(get.status, 200);
});

test('CREATE SCHEMA with a backtick-quoted name', async () => {
  const r = await postQuery('CREATE SCHEMA `test_backtick`');
  assert.equal(r.status, 200);
  assert.equal((await getDataset('test_backtick')).status, 200);
});

// ---------------------------------------------------------------------------
// DROP SCHEMA
// ---------------------------------------------------------------------------

test('DROP SCHEMA removes an empty dataset', async () => {
  await postQuery('CREATE SCHEMA test_drop');
  const r = await postQuery('DROP SCHEMA test_drop');
  assert.equal(r.status, 200);
  assert.equal((await getDataset('test_drop')).status, 404);
});

test('DROP SCHEMA on missing dataset without IF EXISTS: 404', async () => {
  const r = await postQuery('DROP SCHEMA test_does_not_exist');
  assert.equal(r.status, 404);
});

test('DROP SCHEMA IF EXISTS on a missing dataset: 200 silently', async () => {
  const r = await postQuery('DROP SCHEMA IF EXISTS test_silent');
  assert.equal(r.status, 200);
});

test('DROP SCHEMA without CASCADE on a non-empty dataset surfaces DuckDB error', async () => {
  await postQuery('CREATE SCHEMA test_nonempty');
  // Create a table in it via REST.
  const tres = await fetch(`${server.url}/projects/${PROJECT}/datasets/test_nonempty/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 't' },
      schema: { fields: [{ name: 'a', type: 'INT64' }] },
    }),
  });
  assert.equal(tres.status, 200);
  const r = await postQuery('DROP SCHEMA test_nonempty');
  assert.equal(r.status, 400);
  // Dataset metadata should still be present (drop failed before reconcile).
  assert.equal((await getDataset('test_nonempty')).status, 200);
});

test('DROP SCHEMA CASCADE on a non-empty dataset succeeds and clears table metadata', async () => {
  await postQuery('CREATE SCHEMA test_cascade');
  await fetch(`${server.url}/projects/${PROJECT}/datasets/test_cascade/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 't' },
      schema: { fields: [{ name: 'a', type: 'INT64' }] },
    }),
  });
  const r = await postQuery('DROP SCHEMA test_cascade CASCADE');
  assert.equal(r.status, 200);
  assert.equal((await getDataset('test_cascade')).status, 404);
  // The child table is also gone from the table list.
  const list = await fetch(`${server.url}/projects/${PROJECT}/datasets/test_cascade/tables`);
  // The dataset is gone → tables.list returns 404 (parent missing).
  assert.equal(list.status, 404);
});

// ---------------------------------------------------------------------------
// Persisted job
// ---------------------------------------------------------------------------

test('persisted job has statementType=CREATE_SCHEMA', async () => {
  const r = await postQuery('CREATE SCHEMA test_jobcheck');
  const body = r.json as { jobReference: { jobId: string } };
  const jobRes = await fetch(`${server.url}/projects/${PROJECT}/jobs/${body.jobReference.jobId}`);
  const job = (await jobRes.json()) as {
    statistics: { query: { statementType: string } };
  };
  assert.equal(job.statistics.query.statementType, 'CREATE_SCHEMA');
});

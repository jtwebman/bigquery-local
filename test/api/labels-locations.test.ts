/**
 * BL-154 + BL-155 — Labels propagation + location handling.
 *
 * Labels: round-trip through POST + PATCH on tables and jobs. PATCH
 * preserves existing labels when not provided in the body.
 *
 * Locations: dataset.location round-trips. Jobs accept
 * jobReference.location (defaults to 'US') and reject cross-location
 * queries against datasets with a different stored location.
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

const PROJECT = 'labels-loc-test';

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
});
after(async () => {
  await server.close();
  await db.close();
});

// ---------------------------------------------------------------------------
// BL-154 — Labels on tables
// ---------------------------------------------------------------------------

test('POST /tables stores labels and GET returns them', async () => {
  await fetch(`${server.url}/projects/${PROJECT}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: 'd1' } }),
  });
  const create = await fetch(`${server.url}/projects/${PROJECT}/datasets/d1/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 't1' },
      schema: { fields: [{ name: 'id', type: 'STRING' }] },
      labels: { team: 'platform', cost_center: '42' },
    }),
  });
  assert.equal(create.status, 200);
  const body = (await create.json()) as { labels?: Record<string, string> };
  assert.deepEqual(body.labels, { team: 'platform', cost_center: '42' });
});

test('PATCH /tables can update labels (replace)', async () => {
  const patch = await fetch(`${server.url}/projects/${PROJECT}/datasets/d1/tables/t1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ labels: { team: 'data', env: 'prod' } }),
  });
  assert.equal(patch.status, 200);
  const body = (await patch.json()) as { labels?: Record<string, string> };
  assert.deepEqual(body.labels, { team: 'data', env: 'prod' });
});

test('PATCH /tables preserves labels when not in the body', async () => {
  const patch = await fetch(`${server.url}/projects/${PROJECT}/datasets/d1/tables/t1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'unrelated' }),
  });
  const body = (await patch.json()) as {
    description?: string;
    labels?: Record<string, string>;
  };
  assert.equal(body.description, 'unrelated');
  assert.deepEqual(body.labels, { team: 'data', env: 'prod' });
});

test('Non-string label value returns 400', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/d1/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'bad' },
      schema: { fields: [{ name: 'x', type: 'STRING' }] },
      labels: { team: 42 },
    }),
  });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// BL-154 — Labels on jobs
// ---------------------------------------------------------------------------

test('POST /jobs stores configuration.labels; GET surfaces them', async () => {
  const post = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      configuration: {
        query: { query: 'SELECT 1 AS one' },
        labels: { owner: 'analytics', priority: 'low' },
      },
      jobReference: { jobId: 'labeled-job' },
    }),
  });
  assert.equal(post.status, 200);
  const get = await fetch(`${server.url}/projects/${PROJECT}/jobs/labeled-job`);
  const body = (await get.json()) as {
    configuration: { labels?: Record<string, string> };
  };
  assert.deepEqual(body.configuration.labels, { owner: 'analytics', priority: 'low' });
});

// ---------------------------------------------------------------------------
// BL-155 — Locations
// ---------------------------------------------------------------------------

test('Dataset location round-trips via POST + GET', async () => {
  await fetch(`${server.url}/projects/${PROJECT}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      datasetReference: { datasetId: 'eu_ds' },
      location: 'EU',
    }),
  });
  const get = await fetch(`${server.url}/projects/${PROJECT}/datasets/eu_ds`);
  const body = (await get.json()) as { location?: string };
  assert.equal(body.location, 'EU');
});

test('Job with no location runs against any dataset (lenient default)', async () => {
  // Create an EU dataset + table; query without specifying job location.
  await fetch(`${server.url}/projects/${PROJECT}/datasets/eu_ds/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'events' },
      schema: { fields: [{ name: 'id', type: 'INT64' }] },
    }),
  });
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `SELECT * FROM \`eu_ds.events\`` }),
  });
  assert.equal(res.status, 200);
});

test('Cross-location job (US job, EU dataset) fails with invalid', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      configuration: { query: { query: `SELECT * FROM \`eu_ds.events\`` } },
      jobReference: { jobId: 'us-job-against-eu', location: 'US' },
    }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: { errors?: Array<{ reason: string }> } };
  assert.equal(body.error?.errors?.[0]?.reason, 'invalid');
});

test('Matching-location job (EU job, EU dataset) succeeds', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      configuration: { query: { query: `SELECT * FROM \`eu_ds.events\`` } },
      jobReference: { jobId: 'eu-job', location: 'EU' },
    }),
  });
  assert.equal(res.status, 200);
});

test('Cross-location guard skips one-part backticks (no dataset to resolve)', async () => {
  // `t` alone has no dataset prefix — guard ignores it. Query still
  // fails because `t` isn't a real table, but at the query-exec layer
  // not the location guard.
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'SELECT * FROM `t`' }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: { errors?: Array<{ message: string }> } };
  // Confirm the error isn't a location mismatch — it's an unknown-table error.
  assert.doesNotMatch(body.error?.errors?.[0]?.message ?? '', /location/i);
});

test('Cross-location guard ignores datasets that have no stored location', async () => {
  // Dataset created with no `location` is treated as compatible with any job.
  await fetch(`${server.url}/projects/${PROJECT}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: 'unlocated' } }),
  });
  await fetch(`${server.url}/projects/${PROJECT}/datasets/unlocated/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'data' },
      schema: { fields: [{ name: 'id', type: 'INT64' }] },
    }),
  });
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      configuration: { query: { query: `SELECT * FROM \`unlocated.data\`` } },
      jobReference: { jobId: 'eu-against-unlocated', location: 'EU' },
    }),
  });
  assert.equal(res.status, 200);
});

test('Cross-location guard skips backticks pointing at missing datasets', async () => {
  // Backtick references `no_such_dataset` — guard finds the dataset is
  // null and skips. Query then fails with a table-not-found / DuckDB
  // error, not a location error.
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      configuration: {
        query: { query: `SELECT * FROM \`no_such_dataset.t\`` },
      },
      jobReference: { jobId: 'dangling-ref', location: 'EU' },
    }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: { errors?: Array<{ message: string }> } };
  // Not a location mismatch — confirms the guard saw `null` and moved on.
  assert.doesNotMatch(body.error?.errors?.[0]?.message ?? '', /location/i);
});

test('Cross-location guard handles 3-part backticks (project.dataset.table)', async () => {
  // Use the fully-qualified `${PROJECT}.eu_ds.events` form; the guard
  // pulls the project from parts[0] and the dataset from parts[1].
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      configuration: {
        query: { query: `SELECT * FROM \`${PROJECT}.eu_ds.events\`` },
      },
      jobReference: { jobId: 'us-against-eu-fqn', location: 'US' },
    }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: { errors?: Array<{ message: string }> } };
  assert.match(body.error?.errors?.[0]?.message ?? '', /location/i);
});

test('Cross-location guard dedupes repeated dataset references', async () => {
  // Same dataset twice in the FROM clause shouldn't trigger redundant
  // lookups (verified indirectly: query succeeds even though the same
  // EU dataset appears twice).
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      configuration: {
        query: {
          query: `SELECT a.id FROM \`eu_ds.events\` a JOIN \`eu_ds.events\` b ON a.id = b.id`,
        },
      },
      jobReference: { jobId: 'self-join', location: 'EU' },
    }),
  });
  assert.equal(res.status, 200);
});

test('Job preserves its location on GET /jobs/{j}', async () => {
  const get = await fetch(`${server.url}/projects/${PROJECT}/jobs/eu-job`);
  const body = (await get.json()) as {
    jobReference: { location: string };
    id: string;
  };
  assert.equal(body.jobReference.location, 'EU');
  // The composite ID also embeds the location.
  assert.match(body.id, /:EU\.eu-job$/);
});

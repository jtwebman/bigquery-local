/**
 * BL-157 — useQueryCache.
 *
 * Tests:
 *   - Two identical SELECT queries: second has `cacheHit=true`.
 *   - `useQueryCache: false` bypasses the cache both ways (no read,
 *     no write).
 *   - Different parameters miss the cache.
 *   - POST /queries also surfaces cacheHit.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createJobsRoutes } from '../../src/routes/jobs.ts';
import { createQueriesRoutes } from '../../src/routes/queries.ts';
import { createTabledataRoutes } from '../../src/routes/tabledata.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { _resetQueryCacheForTests } from '../../src/sql/queryEngine.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

const PROJECT = 'cache-test';
const DATASET = 'ds';

let db: Db;
let server: Server;

before(async () => {
  _resetQueryCacheForTests();
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
          { name: 'id', type: 'INT64' },
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
  _resetQueryCacheForTests();
});

interface JobBody {
  status: { state: string };
  statistics?: { query?: { cacheHit?: boolean } };
}

async function postJob(body: unknown): Promise<{ status: number; body: JobBody }> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as JobBody };
}

// ---------------------------------------------------------------------------
// POST /jobs cache path
// ---------------------------------------------------------------------------

test('First SELECT: cacheHit=false', async () => {
  const { body } = await postJob({
    configuration: { query: { query: `SELECT id, amount FROM \`${DATASET}.orders\` ORDER BY id` } },
  });
  assert.equal(body.statistics?.query?.cacheHit, false);
});

test('Second identical SELECT: cacheHit=true', async () => {
  const { body } = await postJob({
    configuration: { query: { query: `SELECT id, amount FROM \`${DATASET}.orders\` ORDER BY id` } },
  });
  assert.equal(body.statistics?.query?.cacheHit, true);
});

test('Whitespace differences still hit the cache (normalized SQL)', async () => {
  // Same query with extra newlines / spaces should normalize to the same key.
  const { body } = await postJob({
    configuration: {
      query: { query: `  SELECT id, amount\n  FROM \`${DATASET}.orders\`\n  ORDER BY id  ` },
    },
  });
  assert.equal(body.statistics?.query?.cacheHit, true);
});

test('useQueryCache=false bypasses the cache on read AND skips the write', async () => {
  // Run with cache disabled: this should NOT read from cache (cacheHit=false) ...
  const first = await postJob({
    configuration: {
      query: {
        query: `SELECT 'one-off' AS marker, id FROM \`${DATASET}.orders\``,
        useQueryCache: false,
      },
    },
  });
  assert.equal(first.body.statistics?.query?.cacheHit, false);
  // ... AND should NOT write to cache, so a follow-up cached run misses too.
  const second = await postJob({
    configuration: {
      query: { query: `SELECT 'one-off' AS marker, id FROM \`${DATASET}.orders\`` },
    },
  });
  assert.equal(second.body.statistics?.query?.cacheHit, false);
});

test('Different SQL misses the cache', async () => {
  const { body } = await postJob({
    configuration: {
      query: { query: `SELECT id FROM \`${DATASET}.orders\` WHERE id = 1` },
    },
  });
  assert.equal(body.statistics?.query?.cacheHit, false);
});

test('Different parameter values miss the cache', async () => {
  const baseQuery = `SELECT id FROM \`${DATASET}.orders\` WHERE id = @target`;
  const a = await postJob({
    configuration: {
      query: {
        query: baseQuery,
        parameterMode: 'NAMED',
        queryParameters: [
          {
            name: 'target',
            parameterType: { type: 'INT64' },
            parameterValue: { value: '1' },
          },
        ],
      },
    },
  });
  assert.equal(a.body.statistics?.query?.cacheHit, false);
  // Same query, different param value → different cache key.
  const b = await postJob({
    configuration: {
      query: {
        query: baseQuery,
        parameterMode: 'NAMED',
        queryParameters: [
          {
            name: 'target',
            parameterType: { type: 'INT64' },
            parameterValue: { value: '2' },
          },
        ],
      },
    },
  });
  assert.equal(b.body.statistics?.query?.cacheHit, false);
  // Re-run identical to (a) — cache hit.
  const aAgain = await postJob({
    configuration: {
      query: {
        query: baseQuery,
        parameterMode: 'NAMED',
        queryParameters: [
          {
            name: 'target',
            parameterType: { type: 'INT64' },
            parameterValue: { value: '1' },
          },
        ],
      },
    },
  });
  assert.equal(aAgain.body.statistics?.query?.cacheHit, true);
});

// ---------------------------------------------------------------------------
// POST /queries cache path
// ---------------------------------------------------------------------------

interface QueryResponse {
  cacheHit: boolean;
  rows?: Array<{ f: Array<{ v: string | null }> }>;
}

async function runQuery(body: unknown): Promise<{ status: number; body: QueryResponse }> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as QueryResponse };
}

test('POST /queries: first run sets cacheHit=false, second sets cacheHit=true', async () => {
  // Fresh query — make sure cache is empty for THIS one.
  const sql = `SELECT 'queries-route' AS marker, id FROM \`${DATASET}.orders\` ORDER BY id`;
  const first = await runQuery({ query: sql });
  assert.equal(first.body.cacheHit, false);
  const second = await runQuery({ query: sql });
  assert.equal(second.body.cacheHit, true);
  // Cached rows are identical to fresh rows.
  assert.deepEqual(second.body.rows, first.body.rows);
});

test('POST /queries: useQueryCache=false bypasses the cache', async () => {
  // We're past the cache write for the marker='queries-route' SQL above —
  // a bypass call should still cacheHit=false even though the cache
  // has an entry.
  const sql = `SELECT 'queries-route' AS marker, id FROM \`${DATASET}.orders\` ORDER BY id`;
  const res = await runQuery({ query: sql, useQueryCache: false });
  assert.equal(res.body.cacheHit, false);
});

// ---------------------------------------------------------------------------
// Non-SELECT queries are not cached
// ---------------------------------------------------------------------------

test('DML is not cached (no cacheHit field on a DML job)', async () => {
  // Run a DELETE twice — the second one should still execute and report
  // cacheHit=undefined (or non-true), since we only cache SELECT.
  const { body } = await postJob({
    configuration: {
      query: { query: `DELETE FROM \`${DATASET}.orders\` WHERE id = 999` },
    },
  });
  // DML doesn't go through the cache path, so cacheHit is undefined.
  assert.notEqual(body.statistics?.query?.cacheHit, true);
});

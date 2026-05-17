/**
 * GET /queries/{j} — pageToken / startIndex polish (BL-036).
 *
 * Adds:
 *   - opaque pageTokens (base64 of `{ jobId, offset }`)
 *   - jobId binding: a token from job A cannot be used on job B (400)
 *   - startIndex as an alternative entry point
 *   - out-of-range offset (past totalRows) → 400
 *   - pageToken wins when both pageToken and startIndex are supplied
 *
 * The "happy path" pagination tests live in `test/api/jobs.test.ts` —
 * these focus on the new edges.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createJobsRoutes, encodeQueryPageToken } from '../../src/routes/jobs.ts';
import { createQueriesRoutes } from '../../src/routes/queries.ts';
import { createTabledataRoutes } from '../../src/routes/tabledata.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

interface QueryResultsResponse {
  kind: string;
  totalRows: string;
  rows: Array<{ f: Array<{ v: unknown }> }>;
  pageToken?: string;
}

interface GoogleErrorBody {
  error: { code: number; errors: Array<{ reason: string; message: string }>; message: string };
}

let db: Db;
let server: Server;

const PROJECT = 'page-token-tests';
const DATASET = 'ds';
const TABLE = 't';

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
      tableReference: { tableId: TABLE },
      schema: { fields: [{ name: 'id', type: 'STRING' }] },
    }),
  });
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}/insertAll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rows: Array.from({ length: 5 }, (_, i) => ({ json: { id: `r${i}` } })),
    }),
  });
});

after(async () => {
  await server.close();
  await db.close();
});

async function runQuery(): Promise<string> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `SELECT id FROM \`${DATASET}.${TABLE}\` ORDER BY id` }),
  });
  const body = (await res.json()) as { jobReference: { jobId: string } };
  return body.jobReference.jobId;
}

async function getResults(
  jobId: string,
  qs: string,
): Promise<{ status: number; body: QueryResultsResponse }> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries/${jobId}${qs}`);
  return { status: res.status, body: (await res.json()) as QueryResultsResponse };
}

// ---------------------------------------------------------------------------
// startIndex
// ---------------------------------------------------------------------------

test('startIndex is an alternative entry point into the result set', async () => {
  const jobId = await runQuery();
  const { body } = await getResults(jobId, '?startIndex=2&maxResults=2');
  assert.deepEqual(
    body.rows.map((r) => r.f[0]?.v),
    ['r2', 'r3'],
  );
});

test('startIndex=0 is the same as no startIndex', async () => {
  const jobId = await runQuery();
  const a = await getResults(jobId, '?maxResults=2');
  const b = await getResults(jobId, '?startIndex=0&maxResults=2');
  assert.deepEqual(a.body.rows, b.body.rows);
});

test('negative startIndex is rejected', async () => {
  const jobId = await runQuery();
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries/${jobId}?startIndex=-1`);
  assert.equal(res.status, 400);
});

test('startIndex past totalRows → 400 (not an empty success)', async () => {
  const jobId = await runQuery();
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries/${jobId}?startIndex=99`);
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.match(err.error.errors[0]?.message ?? '', /past the result set/);
});

test('startIndex at exactly totalRows is allowed and returns no rows', async () => {
  // Boundary case: offset == totalRows reads zero rows; that's still a
  // valid "I'm done" position, not an error.
  const jobId = await runQuery();
  const { status, body } = await getResults(jobId, '?startIndex=5');
  assert.equal(status, 200);
  assert.deepEqual(body.rows, []);
  assert.equal(body.pageToken, undefined);
});

// ---------------------------------------------------------------------------
// pageToken (opaque)
// ---------------------------------------------------------------------------

test('pageToken issued for one job is rejected for another job', async () => {
  const jobA = await runQuery();
  const jobB = await runQuery();
  // Get a token from job A.
  const p1 = await getResults(jobA, '?maxResults=2');
  assert.ok(p1.body.pageToken !== undefined);
  // Try to use it on job B.
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/queries/${jobB}?pageToken=${encodeURIComponent(p1.body.pageToken)}`,
  );
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.match(err.error.errors[0]?.message ?? '', /different job/);
});

test('malformed pageToken (not valid base64-JSON) → 400', async () => {
  const jobId = await runQuery();
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/queries/${jobId}?pageToken=not-a-real-token`,
  );
  assert.equal(res.status, 400);
});

test('forged pageToken with the right jobId but offset past the end → 400', async () => {
  // A client that figured out the encoding still gets caught by the range check.
  const jobId = await runQuery();
  const forged = encodeQueryPageToken(jobId, 999);
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/queries/${jobId}?pageToken=${encodeURIComponent(forged)}`,
  );
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.match(err.error.errors[0]?.message ?? '', /past the result set/);
});

test('pageToken wins when both pageToken and startIndex are supplied', async () => {
  const jobId = await runQuery();
  const p1 = await getResults(jobId, '?maxResults=2');
  // Page 1 → 2 rows + token pointing at offset 2.
  // If we also send startIndex=4, pageToken should win → we get rows from offset 2.
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/queries/${jobId}?pageToken=${encodeURIComponent(p1.body.pageToken ?? '')}&startIndex=4&maxResults=2`,
  );
  const body = (await res.json()) as QueryResultsResponse;
  assert.deepEqual(
    body.rows.map((r) => r.f[0]?.v),
    ['r2', 'r3'],
  );
});

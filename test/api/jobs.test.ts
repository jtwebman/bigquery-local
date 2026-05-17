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

interface JobResource {
  kind: string;
  id: string;
  jobReference: { projectId: string; jobId: string; location: string };
  configuration: { query: { query: string } };
  status: { state: string };
  statistics: {
    creationTime: string;
    query?: { statementType: string; schema?: { fields: Array<{ name: string; type: string }> } };
  };
}
interface QueryResultsResponse {
  kind: string;
  schema: { fields: Array<{ name: string; type: string }> };
  jobReference: { projectId: string; jobId: string; location: string };
  totalRows: string;
  rows: Array<{ f: Array<{ v: unknown }> }>;
  pageToken?: string;
  jobComplete: boolean;
}
interface GoogleErrorBody {
  error: { code: number; errors: Array<{ reason: string; message: string }>; message: string };
}

let db: Db;
let server: Server;
const PROJECT = 'jobs-test';
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
  // Seed 5 rows so pagination has something to slice.
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}/insertAll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rows: [
        { json: { id: 'a' } },
        { json: { id: 'b' } },
        { json: { id: 'c' } },
        { json: { id: 'd' } },
        { json: { id: 'e' } },
      ],
    }),
  });
});

after(async () => {
  await server.close();
  await db.close();
});

async function postJob(body: object): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

// ---------------------------------------------------------------------------
// POST /jobs
// ---------------------------------------------------------------------------

test('POST /jobs runs a query and returns a bigquery#job resource', async () => {
  const { status, json } = await postJob({
    configuration: { query: { query: 'SELECT 1 AS one' } },
  });
  assert.equal(status, 200);
  const job = json as JobResource;
  assert.equal(job.kind, 'bigquery#job');
  assert.equal(job.status.state, 'DONE');
  assert.equal(job.configuration.query.query, 'SELECT 1 AS one');
  assert.match(job.jobReference.jobId, /[0-9a-f-]{36}/);
  assert.equal(job.statistics.query?.statementType, 'SELECT');
  assert.equal(job.statistics.query?.schema?.fields[0]?.name, 'one');
});

test('POST /jobs honors a client-supplied jobReference.jobId', async () => {
  const customId = 'my-custom-job-id';
  const { status, json } = await postJob({
    jobReference: { jobId: customId },
    configuration: { query: { query: 'SELECT 1' } },
  });
  assert.equal(status, 200);
  const job = json as JobResource;
  assert.equal(job.jobReference.jobId, customId);
});

test('POST /jobs with parameterized query persists the parameters', async () => {
  const { status, json } = await postJob({
    configuration: {
      query: {
        query: 'SELECT @n + 1 AS plus_one',
        queryParameters: [
          {
            name: 'n',
            parameterType: { type: 'INT64' },
            parameterValue: { value: '41' },
          },
        ],
      },
    },
  });
  assert.equal(status, 200);
  const job = json as JobResource;
  assert.equal(job.status.state, 'DONE');
});

test('POST /jobs rejects configuration.load with unsupportedFeature', async () => {
  const { status, json } = await postJob({
    configuration: { load: { destinationTable: { tableId: 't' } } },
  });
  assert.equal(status, 400);
  const err = json as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'unsupportedFeature');
  assert.match(err.error.errors[0]?.message ?? '', /load/);
});

test('POST /jobs rejects configuration.copy with unsupportedFeature', async () => {
  const { status } = await postJob({ configuration: { copy: {} } });
  assert.equal(status, 400);
});

test('POST /jobs rejects configuration.extract with unsupportedFeature', async () => {
  const { status } = await postJob({ configuration: { extract: {} } });
  assert.equal(status, 400);
});

test('POST /jobs returns 400 when configuration.query is missing', async () => {
  const { status, json } = await postJob({ configuration: {} });
  assert.equal(status, 400);
  const err = json as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
  assert.match(err.error.errors[0]?.message ?? '', /configuration\.query/);
});

// ---------------------------------------------------------------------------
// GET /jobs/{j}
// ---------------------------------------------------------------------------

test('GET /jobs/{j} returns the persisted job after POST', async () => {
  const created = (
    await postJob({
      configuration: { query: { query: 'SELECT 42 AS answer' } },
    })
  ).json as JobResource;
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs/${created.jobReference.jobId}`);
  assert.equal(res.status, 200);
  const job = (await res.json()) as JobResource;
  assert.equal(job.jobReference.jobId, created.jobReference.jobId);
  assert.equal(job.status.state, 'DONE');
  assert.equal(job.statistics.query?.schema?.fields[0]?.name, 'answer');
});

test('GET /jobs/{j} returns 404 for an unknown job', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs/never-existed`);
  assert.equal(res.status, 404);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'notFound');
});

// ---------------------------------------------------------------------------
// GET /queries/{j} — pagination
// ---------------------------------------------------------------------------

async function runQueryForRows(query: string): Promise<string> {
  // POST /queries returns the same job-persisting flow; we just need a jobId.
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { jobReference: { jobId: string } };
  return body.jobReference.jobId;
}

test('GET /queries/{j} returns all rows when total <= page size', async () => {
  const jobId = await runQueryForRows(`SELECT id FROM \`${DATASET}.${TABLE}\` ORDER BY id`);
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries/${jobId}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as QueryResultsResponse;
  assert.equal(body.kind, 'bigquery#getQueryResultsResponse');
  assert.equal(body.totalRows, '5');
  assert.equal(body.rows.length, 5);
  assert.equal(body.jobComplete, true);
  assert.equal(body.pageToken, undefined);
  assert.deepEqual(
    body.rows.map((r) => r.f[0]?.v),
    ['a', 'b', 'c', 'd', 'e'],
  );
});

test('GET /queries/{j}?maxResults=2 returns the first 2 with an opaque pageToken', async () => {
  const jobId = await runQueryForRows(`SELECT id FROM \`${DATASET}.${TABLE}\` ORDER BY id`);
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries/${jobId}?maxResults=2`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as QueryResultsResponse;
  assert.equal(body.rows.length, 2);
  // Token is opaque (no longer a bare integer string).
  assert.ok(body.pageToken !== undefined && body.pageToken.length > 0);
  assert.ok(!/^\d+$/.test(body.pageToken));
  assert.deepEqual(
    body.rows.map((r) => r.f[0]?.v),
    ['a', 'b'],
  );
});

test('GET /queries/{j} round-trips a pageToken to the next slice', async () => {
  const jobId = await runQueryForRows(`SELECT id FROM \`${DATASET}.${TABLE}\` ORDER BY id`);
  const r1 = await fetch(`${server.url}/projects/${PROJECT}/queries/${jobId}?maxResults=2`);
  const b1 = (await r1.json()) as QueryResultsResponse;
  // Use the returned token verbatim — that's the whole point of "opaque".
  const r2 = await fetch(
    `${server.url}/projects/${PROJECT}/queries/${jobId}?pageToken=${encodeURIComponent(b1.pageToken ?? '')}&maxResults=2`,
  );
  const b2 = (await r2.json()) as QueryResultsResponse;
  assert.deepEqual(
    b2.rows.map((r) => r.f[0]?.v),
    ['c', 'd'],
  );
});

test('GET /queries/{j} the last-page pageToken from the API yields the final slice with no further token', async () => {
  const jobId = await runQueryForRows(`SELECT id FROM \`${DATASET}.${TABLE}\` ORDER BY id`);
  // Page 1 → 2 rows + token. Page 2 → 2 rows + token. Page 3 → 1 row + no token.
  const r1 = await fetch(`${server.url}/projects/${PROJECT}/queries/${jobId}?maxResults=2`);
  const b1 = (await r1.json()) as QueryResultsResponse;
  const r2 = await fetch(
    `${server.url}/projects/${PROJECT}/queries/${jobId}?pageToken=${encodeURIComponent(b1.pageToken ?? '')}&maxResults=2`,
  );
  const b2 = (await r2.json()) as QueryResultsResponse;
  const r3 = await fetch(
    `${server.url}/projects/${PROJECT}/queries/${jobId}?pageToken=${encodeURIComponent(b2.pageToken ?? '')}&maxResults=2`,
  );
  const b3 = (await r3.json()) as QueryResultsResponse;
  assert.equal(b3.rows.length, 1);
  assert.equal(b3.pageToken, undefined);
});

test('GET /queries/{j} returns 404 for unknown job', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries/never-existed`);
  assert.equal(res.status, 404);
});

test('GET /queries/{j} rejects bad maxResults', async () => {
  const jobId = await runQueryForRows('SELECT 1');
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries/${jobId}?maxResults=zero`);
  assert.equal(res.status, 400);
});

test('GET /queries/{j} rejects bad pageToken', async () => {
  const jobId = await runQueryForRows('SELECT 1');
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries/${jobId}?pageToken=-1`);
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// Body-shape validation — malformed input lands in BqError.invalid
// ---------------------------------------------------------------------------

test('POST /jobs rejects a body that is not a JSON object', async () => {
  const { status, json } = await postJob([] as unknown as object);
  assert.equal(status, 400);
  const err = json as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
  assert.match(err.error.errors[0]?.message ?? '', /request body/);
});

test('POST /jobs rejects when jobReference is not an object', async () => {
  const { status, json } = await postJob({
    jobReference: 'not-an-object',
    configuration: { query: { query: 'SELECT 1' } },
  });
  assert.equal(status, 400);
  const err = json as GoogleErrorBody;
  assert.match(err.error.errors[0]?.message ?? '', /jobReference/);
});

test('POST /jobs rejects when jobReference.jobId is not a string', async () => {
  const { status, json } = await postJob({
    jobReference: { jobId: 12345 },
    configuration: { query: { query: 'SELECT 1' } },
  });
  assert.equal(status, 400);
  const err = json as GoogleErrorBody;
  assert.match(err.error.errors[0]?.message ?? '', /jobReference\.jobId/);
});

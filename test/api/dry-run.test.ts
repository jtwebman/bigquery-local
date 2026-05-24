/**
 * dryRun: validate + plan a query without executing it.
 *
 * Covers both entry points:
 *   POST /projects/{p}/queries           { query, dryRun: true }
 *   POST /projects/{p}/jobs              configuration.dryRun: true
 *                                        OR configuration.query.dryRun: true
 *
 * What dryRun guarantees (matching real BQ):
 *   - Returns the result schema the query would produce.
 *   - Returns `jobComplete: true` and `totalBytesProcessed: "0"`.
 *   - Never writes rows, never persists a job.
 *   - SQL errors (unknown column, bad syntax, type mismatch) come back as
 *     400 invalid — the same shape as a regular run-time error.
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

interface QueryResponseWire {
  kind: string;
  schema: { fields: Array<{ name: string; type: string }> };
  jobReference: { projectId: string; jobId: string };
  totalRows: string;
  rows: Array<{ f: Array<{ v: unknown }> }>;
  totalBytesProcessed: string;
  jobComplete: boolean;
}

interface JobResourceWire {
  kind: string;
  id: string;
  jobReference: { projectId: string; jobId: string };
  configuration: { query: { query: string }; dryRun?: boolean };
  status: { state: string };
  statistics: { query?: { schema?: { fields: Array<{ name: string; type: string }> } } };
}

interface GoogleErrorBody {
  error: { code: number; errors: Array<{ reason: string; message: string }>; message: string };
}

let db: Db;
let server: Server;

const PROJECT = 'dry-run-tests';
const DATASET = 'ds';

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
  // Seed: dataset + table for the dryRun-against-a-real-table test.
  await fetch(`${server.url}/projects/${PROJECT}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: DATASET } }),
  });
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'events' },
      schema: {
        fields: [
          { name: 'id', type: 'STRING' },
          { name: 'score', type: 'INT64' },
        ],
      },
    }),
  });
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/events/insertAll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rows: [{ json: { id: 'a', score: '1' } }, { json: { id: 'b', score: '2' } }],
    }),
  });
});

after(async () => {
  await server.close();
  await db.close();
});

async function postQuery(body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function postJob(body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

// ---------------------------------------------------------------------------
// POST /queries
// ---------------------------------------------------------------------------

test('POST /queries dryRun=true returns schema with no rows', async () => {
  const { status, json } = await postQuery({
    query: 'SELECT 1 AS one, CAST(2 AS DOUBLE) AS two',
    dryRun: true,
  });
  assert.equal(status, 200);
  const body = json as QueryResponseWire;
  assert.equal(body.kind, 'bigquery#queryResponse');
  assert.equal(body.jobComplete, true);
  assert.equal(body.totalRows, '0');
  assert.deepEqual(body.rows, []);
  // BL-099: totalBytesProcessed = output rows × per-row schema estimate.
  // For SELECT 1 AS one, ... AS two the output is one row of two
  // 8-byte numbers, so we expect a small positive value (≥1).
  assert.ok(
    Number(body.totalBytesProcessed) > 0,
    `expected > 0 bytes, got ${body.totalBytesProcessed}`,
  );
  // Schema is filled in.
  assert.equal(body.schema.fields.length, 2);
  assert.equal(body.schema.fields[0]?.name, 'one');
  assert.equal(body.schema.fields[0]?.type, 'INT64');
  assert.equal(body.schema.fields[1]?.name, 'two');
  assert.equal(body.schema.fields[1]?.type, 'FLOAT64');
});

test('POST /queries dryRun against a real table types the projection correctly', async () => {
  const { status, json } = await postQuery({
    query: `SELECT id, score + 10 AS bumped FROM \`${DATASET}.events\``,
    dryRun: true,
  });
  assert.equal(status, 200);
  const body = json as QueryResponseWire;
  assert.equal(body.totalRows, '0');
  assert.equal(body.rows.length, 0);
  assert.deepEqual(
    body.schema.fields.map((f) => f.name),
    ['id', 'bumped'],
  );
  assert.deepEqual(
    body.schema.fields.map((f) => f.type),
    ['STRING', 'INT64'],
  );
});

test('POST /queries dryRun: invalid SQL → 400 with parse error', async () => {
  const { status, json } = await postQuery({
    query: `SELECT no_such_column FROM \`${DATASET}.events\``,
    dryRun: true,
  });
  assert.equal(status, 400);
  const err = json as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
  assert.match(err.error.errors[0]?.message ?? '', /no_such_column/);
});

test('POST /queries dryRun does NOT persist a job (no GET on returned jobId)', async () => {
  const { json } = await postQuery({ query: 'SELECT 1 AS one', dryRun: true });
  const { jobId } = (json as QueryResponseWire).jobReference;
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs/${jobId}`);
  assert.equal(res.status, 404);
});

test('POST /queries dryRun rejects a non-boolean dryRun', async () => {
  const { status, json } = await postQuery({ query: 'SELECT 1', dryRun: 'yes' });
  assert.equal(status, 400);
  const err = json as GoogleErrorBody;
  assert.match(err.error.errors[0]?.message ?? '', /dryRun must be a boolean/);
});

// ---------------------------------------------------------------------------
// POST /jobs
// ---------------------------------------------------------------------------

test('POST /jobs with configuration.dryRun=true returns schema, no rows persisted', async () => {
  const { status, json } = await postJob({
    configuration: {
      dryRun: true,
      query: { query: `SELECT id FROM \`${DATASET}.events\`` },
    },
  });
  assert.equal(status, 200);
  const body = json as JobResourceWire;
  assert.equal(body.kind, 'bigquery#job');
  assert.equal(body.status.state, 'DONE');
  assert.equal(body.configuration.dryRun, true);
  assert.equal(body.statistics.query?.schema?.fields[0]?.name, 'id');
  // Not persisted: GET on the returned jobId returns 404.
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs/${body.jobReference.jobId}`);
  assert.equal(res.status, 404);
});

test('POST /jobs also accepts dryRun under configuration.query (legacy shape)', async () => {
  const { status, json } = await postJob({
    configuration: {
      query: { query: 'SELECT 1 AS x', dryRun: true },
    },
  });
  assert.equal(status, 200);
  const body = json as JobResourceWire;
  assert.equal(body.configuration.dryRun, true);
  assert.equal(body.statistics.query?.schema?.fields[0]?.name, 'x');
});

test('POST /jobs dryRun with parameters validates the parameter shape', async () => {
  const { status, json } = await postJob({
    configuration: {
      dryRun: true,
      query: {
        query: 'SELECT @n * 2 AS doubled',
        queryParameters: [
          {
            name: 'n',
            parameterType: { type: 'INT64' },
            parameterValue: { value: '21' },
          },
        ],
      },
    },
  });
  assert.equal(status, 200);
  const body = json as JobResourceWire;
  assert.equal(body.statistics.query?.schema?.fields[0]?.name, 'doubled');
  assert.equal(body.statistics.query?.schema?.fields[0]?.type, 'INT64');
});

test('POST /jobs dryRun: invalid SQL → 400', async () => {
  const { status, json } = await postJob({
    configuration: {
      dryRun: true,
      query: { query: 'SELECT * FROM no_such_table' },
    },
  });
  assert.equal(status, 400);
  const err = json as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
});

test('POST /jobs dryRun rejects a non-boolean configuration.dryRun', async () => {
  const { status, json } = await postJob({
    configuration: {
      dryRun: 'yes',
      query: { query: 'SELECT 1' },
    },
  });
  assert.equal(status, 400);
  const err = json as GoogleErrorBody;
  assert.match(err.error.errors[0]?.message ?? '', /configuration\.dryRun must be a boolean/);
});

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createQueriesRoutes } from '../../src/routes/queries.ts';
import { createTabledataRoutes } from '../../src/routes/tabledata.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

interface FieldWire {
  name: string;
  type: string;
  mode?: string;
}
interface QueryResponse {
  kind: string;
  schema: { fields: FieldWire[] };
  jobReference: { projectId: string; jobId: string; location: string };
  totalRows: string;
  rows: Array<{ f: Array<{ v: unknown }> }>;
  totalBytesProcessed: string;
  jobComplete: boolean;
  cacheHit: boolean;
}
interface GoogleErrorBody {
  error: { code: number; errors: Array<{ reason: string; message: string }>; message: string };
}

let db: Db;
let server: Server;

const PROJECT = 'queries-test';
const DATASET = 'ds';
const TABLE = 'events';

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [
      ...createDatasetRoutes(db),
      ...createTableRoutes(db),
      ...createTabledataRoutes(db),
      ...createQueriesRoutes(db),
    ],
  });
  await server.listen(0);
  // Create the parent dataset.
  await fetch(`${server.url}/projects/${PROJECT}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: DATASET } }),
  });
  // Create a table that mirrors the v0 reference workload shape.
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: TABLE },
      schema: {
        fields: [
          { name: 'id', type: 'STRING', mode: 'REQUIRED' },
          { name: 'type', type: 'STRING' },
          { name: 'created_at', type: 'TIMESTAMP' },
          { name: 'payload', type: 'JSON' },
        ],
      },
    }),
  });
  // Seed it with a few rows.
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}/insertAll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rows: [
        {
          json: {
            id: 'a',
            type: 'drops.dropInteraction',
            created_at: '2026-05-01T00:00:00Z',
            payload: '{"licenses":{"us-east":"L-1"}}',
          },
        },
        {
          json: {
            id: 'b',
            type: 'drops.dropInteraction',
            created_at: '2026-05-10T00:00:00Z',
            payload: '{"licenses":{"us-east":"L-2"}}',
          },
        },
        {
          json: {
            id: 'c',
            type: 'other',
            created_at: '2026-05-15T00:00:00Z',
            payload: '{"licenses":{}}',
          },
        },
      ],
    }),
  });
});

after(async () => {
  await server.close();
  await db.close();
});

async function runQuery(body: object): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

// ---------------------------------------------------------------------------
// Simple SELECT
// ---------------------------------------------------------------------------

test('queries: basic SELECT returns the expected wire shape', async () => {
  const { status, json } = await runQuery({
    query: `SELECT 1 AS one, 'hi' AS s`,
  });
  assert.equal(status, 200);
  const body = json as QueryResponse;
  assert.equal(body.kind, 'bigquery#queryResponse');
  assert.equal(body.jobComplete, true);
  assert.equal(body.cacheHit, false);
  assert.equal(body.totalRows, '1');
  assert.equal(body.schema.fields.length, 2);
  assert.equal(body.schema.fields[0]?.name, 'one');
  assert.equal(body.schema.fields[1]?.name, 's');
  // Wire format: rows[].f[].v.
  assert.equal(body.rows[0]?.f[0]?.v, '1');
  assert.equal(body.rows[0]?.f[1]?.v, 'hi');
});

// ---------------------------------------------------------------------------
// Backtick references resolve to the real dataset.table
// ---------------------------------------------------------------------------

test('queries: backtick-qualified table reference resolves correctly', async () => {
  const { status, json } = await runQuery({
    query: `SELECT id FROM \`${DATASET}.${TABLE}\` ORDER BY id`,
  });
  assert.equal(status, 200);
  const body = json as QueryResponse;
  assert.deepEqual(
    body.rows.map((r) => r.f[0]?.v),
    ['a', 'b', 'c'],
  );
});

test('queries: 3-part backtick targets the explicit project (cross-project read)', async () => {
  // 3-part `proj.ds.tbl` overrides the request URL's project, so a query
  // sent through /projects/queries-test can read /projects/PROJECT/.../...
  // explicitly. Use the URL's project here since that's where the data lives.
  const { status, json } = await runQuery({
    query: `SELECT id FROM \`${PROJECT}.${DATASET}.${TABLE}\` ORDER BY id`,
  });
  assert.equal(status, 200);
  const body = json as QueryResponse;
  assert.equal(body.totalRows, '3');
});

// ---------------------------------------------------------------------------
// JSON_VALUE → json_extract_string
// ---------------------------------------------------------------------------

test('queries: JSON_VALUE rewrite reads quoted JSON paths', async () => {
  const { status, json } = await runQuery({
    query: `
      SELECT
        id,
        JSON_VALUE(payload, '$.licenses."us-east"') AS license
      FROM \`${DATASET}.${TABLE}\`
      WHERE JSON_VALUE(payload, '$.licenses."us-east"') IS NOT NULL
      ORDER BY id
    `,
  });
  assert.equal(status, 200);
  const body = json as QueryResponse;
  assert.equal(body.totalRows, '2');
  assert.equal(body.rows[0]?.f[1]?.v, 'L-1');
  assert.equal(body.rows[1]?.f[1]?.v, 'L-2');
});

// ---------------------------------------------------------------------------
// STARTS_WITH
// ---------------------------------------------------------------------------

test('queries: STARTS_WITH filters correctly', async () => {
  const { status, json } = await runQuery({
    query: `SELECT id FROM \`${DATASET}.${TABLE}\` WHERE STARTS_WITH(type, 'drops.') ORDER BY id`,
  });
  assert.equal(status, 200);
  const body = json as QueryResponse;
  assert.deepEqual(
    body.rows.map((r) => r.f[0]?.v),
    ['a', 'b'],
  );
});

// ---------------------------------------------------------------------------
// TIMESTAMP_SUB / CURRENT_TIMESTAMP rewrites
// ---------------------------------------------------------------------------

test('queries: TIMESTAMP_SUB + CURRENT_TIMESTAMP rewrites resolve to a comparable timestamp', async () => {
  const { status, json } = await runQuery({
    query: `
      SELECT TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY) AS day_ago
    `,
  });
  assert.equal(status, 200);
  const body = json as QueryResponse;
  assert.equal(body.totalRows, '1');
  // BQ wires TIMESTAMP as microseconds-since-epoch (Int64Value string).
  // Just verify it's a positive integer string within ±2 days of "now".
  const usStr = String(body.rows[0]?.f[0]?.v ?? '');
  assert.match(usStr, /^\d+$/);
  const us = BigInt(usStr);
  const nowUs = BigInt(Date.now()) * 1000n;
  const twoDaysUs = 2n * 24n * 60n * 60n * 1000n * 1000n;
  assert.ok(us > nowUs - twoDaysUs && us < nowUs, `out-of-range timestamp ${usStr}`);
});

// ---------------------------------------------------------------------------
// Named parameters — scalar and array
// ---------------------------------------------------------------------------

test('queries: @since (TIMESTAMP) parameter narrows the result set', async () => {
  const { status, json } = await runQuery({
    query: `
      SELECT id FROM \`${DATASET}.${TABLE}\`
      WHERE created_at >= @since
      ORDER BY id
    `,
    queryParameters: [
      {
        name: 'since',
        parameterType: { type: 'TIMESTAMP' },
        parameterValue: { value: '2026-05-05T00:00:00Z' },
      },
    ],
  });
  assert.equal(status, 200);
  const body = json as QueryResponse;
  assert.deepEqual(
    body.rows.map((r) => r.f[0]?.v),
    ['b', 'c'],
  );
});

test('queries: @ids (ARRAY<STRING>) parameter via UNNEST works', async () => {
  const { status, json } = await runQuery({
    query: `
      SELECT id FROM \`${DATASET}.${TABLE}\`
      WHERE id IN UNNEST(@ids)
      ORDER BY id
    `,
    queryParameters: [
      {
        name: 'ids',
        parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
        parameterValue: { arrayValues: [{ value: 'a' }, { value: 'c' }] },
      },
    ],
  });
  assert.equal(status, 200);
  const body = json as QueryResponse;
  assert.deepEqual(
    body.rows.map((r) => r.f[0]?.v),
    ['a', 'c'],
  );
});

test('queries: INT64 parameter encodes as BIGINT', async () => {
  const { status, json } = await runQuery({
    query: 'SELECT @n + 1 AS plus_one',
    queryParameters: [
      {
        name: 'n',
        parameterType: { type: 'INT64' },
        parameterValue: { value: '41' },
      },
    ],
  });
  assert.equal(status, 200);
  const body = json as QueryResponse;
  assert.equal(body.rows[0]?.f[0]?.v, '42');
});

// ---------------------------------------------------------------------------
// jobReference + persistence
// ---------------------------------------------------------------------------

test('queries: jobReference.jobId is unique per call', async () => {
  const a = (await runQuery({ query: 'SELECT 1' })).json as QueryResponse;
  const b = (await runQuery({ query: 'SELECT 1' })).json as QueryResponse;
  assert.notEqual(a.jobReference.jobId, b.jobReference.jobId);
});

test('queries: persisted job + rows are readable from _bq tables', async () => {
  const res = (await runQuery({ query: "SELECT 'x' AS v" })).json as QueryResponse;
  const jobRows = await db.query<{ state: string; result_total_rows: bigint }>(
    `SELECT state, result_total_rows FROM _bq.jobs WHERE project = $1 AND job_id = $2`,
    [PROJECT, res.jobReference.jobId],
  );
  assert.equal(jobRows.length, 1);
  assert.equal(jobRows[0]?.state, 'DONE');
  assert.equal(jobRows[0]?.result_total_rows, 1n);

  const rowRows = await db.query<{ row_index: bigint }>(
    `SELECT row_index FROM _bq.job_rows WHERE job_id = $1 ORDER BY row_index`,
    [res.jobReference.jobId],
  );
  assert.equal(rowRows.length, 1);
  assert.equal(rowRows[0]?.row_index, 0n);
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test('queries: missing query field returns 400 invalid', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
});

test('queries: missing @-param value returns 400 invalid', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'SELECT @x',
      queryParameters: [],
    }),
  });
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.match(err.error.errors[0]?.message ?? '', /not provided/);
});

test('queries: unsupported BQ function surfaces unsupportedFeature 400', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'SELECT GENERATE_UUID()' }),
  });
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'unsupportedFeature');
});

test('queries: DuckDB-level error (bad column) surfaces as 400 invalid', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `SELECT no_such_column FROM \`${DATASET}.${TABLE}\`` }),
  });
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
});

test('queries: POST body that is not a JSON object returns 400', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(['not-an-object']),
  });
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
});

test('queries: POST body without a `query` field returns 400', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ notQuery: 'SELECT 1' }),
  });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// Parameter type coverage — make sure every scalar BqType binds correctly.
// ---------------------------------------------------------------------------

test('queries: BOOL scalar parameter binds true', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'SELECT @b AS got',
      queryParameters: [
        {
          name: 'b',
          parameterType: { type: 'BOOL' },
          parameterValue: { value: 'true' },
        },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as QueryResponse;
  // BQ wire format encodes BOOL as the literal string "true" / "false".
  assert.equal(body.rows[0]?.f[0]?.v, 'true');
});

test('queries: FLOAT64 scalar parameter binds as a decimal string', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'SELECT @x + 1.5 AS got',
      queryParameters: [
        {
          name: 'x',
          parameterType: { type: 'FLOAT64' },
          parameterValue: { value: '2.25' },
        },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as QueryResponse;
  assert.equal(body.rows[0]?.f[0]?.v, '3.75');
});

test('queries: STRUCT scalar parameter rejected with unsupportedFeature', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'SELECT @s AS got',
      queryParameters: [
        {
          name: 's',
          parameterType: { type: 'STRUCT' },
          parameterValue: { value: '{}' },
        },
      ],
    }),
  });
  assert.equal(res.status, 400);
});

test('queries: ARRAY<BOOL> binds via UNNEST', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'SELECT unnest FROM UNNEST(@flags)',
      queryParameters: [
        {
          name: 'flags',
          parameterType: { type: 'ARRAY', arrayType: { type: 'BOOL' } },
          parameterValue: { arrayValues: [{ value: 'true' }, { value: 'false' }] },
        },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as QueryResponse;
  assert.deepEqual(
    body.rows.map((r) => r.f[0]?.v),
    ['true', 'false'],
  );
});

test('queries: ARRAY<FLOAT64> elements come back as decimal strings', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'SELECT unnest FROM UNNEST(@nums) ORDER BY unnest',
      queryParameters: [
        {
          name: 'nums',
          parameterType: { type: 'ARRAY', arrayType: { type: 'FLOAT64' } },
          parameterValue: { arrayValues: [{ value: '2.5' }, { value: '1.5' }] },
        },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as QueryResponse;
  assert.deepEqual(
    body.rows.map((r) => r.f[0]?.v),
    ['1.5', '2.5'],
  );
});

test('queries: ARRAY<STRUCT> rejected with unsupportedFeature', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'SELECT unnest FROM UNNEST(@arr)',
      queryParameters: [
        {
          name: 'arr',
          parameterType: { type: 'ARRAY', arrayType: { type: 'STRUCT' } },
          parameterValue: { arrayValues: [{ value: '{}' }] },
        },
      ],
    }),
  });
  assert.equal(res.status, 400);
});

test('queries: DATETIME parameter casts cleanly for INTERVAL arithmetic', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'SELECT @t - INTERVAL 1 DAY AS day_ago',
      queryParameters: [
        {
          name: 't',
          parameterType: { type: 'DATETIME' },
          parameterValue: { value: '2026-05-16 12:00:00' },
        },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as QueryResponse;
  assert.match(String(body.rows[0]?.f[0]?.v ?? ''), /2026-05-15/);
});

test('queries: DATE parameter casts cleanly for INTERVAL arithmetic', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'SELECT @d + INTERVAL 7 DAY AS week_later',
      queryParameters: [
        {
          name: 'd',
          parameterType: { type: 'DATE' },
          parameterValue: { value: '2026-05-16' },
        },
      ],
    }),
  });
  assert.equal(res.status, 200);
});

test('queries: TIME parameter casts cleanly', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'SELECT @t AS got',
      queryParameters: [
        {
          name: 't',
          parameterType: { type: 'TIME' },
          parameterValue: { value: '12:34:56' },
        },
      ],
    }),
  });
  assert.equal(res.status, 200);
});

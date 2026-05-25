/**
 * BL-083 + BL-084 + BL-090 — Load jobs (CSV + NDJSON) with autodetect.
 *
 * Boots a tiny in-process GCS stub (same shape as test/unit/gcs.test.ts
 * uses), seeds a few objects, then posts load jobs through the public
 * /projects/{p}/jobs route. Verifies:
 *
 *   - Autodetect infers BQ types (INT64, FLOAT64, BOOL, STRING) from CSV.
 *   - Explicit schema bypasses autodetect.
 *   - NDJSON loads with implicit schema from JSON value types.
 *   - WRITE_TRUNCATE clears existing rows.
 *   - WRITE_EMPTY fails when the destination has rows.
 *   - Bad sourceFormat returns unsupportedFeature.
 */

import { strict as assert } from 'node:assert';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
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

const PROJECT = 'load-test';
const DATASET = 'ds';

interface StoredObject {
  readonly bytes: Buffer;
  readonly contentType: string;
}

const OBJECTS: Map<string, StoredObject> = new Map();

let db: Db;
let server: Server;
let gcs: HttpServer;
let gcsUrl: string;
let prevEmulatorHost: string | undefined;

before(async () => {
  OBJECTS.set('bq-load::orders.csv', {
    bytes: Buffer.from(
      'order_id,customer,amount,delivered\n' +
        '1,Alice,9.99,true\n' +
        '2,Bob,12.50,false\n' +
        '3,Charlie,7.00,true\n',
      'utf-8',
    ),
    contentType: 'text/csv',
  });
  OBJECTS.set('bq-load::events.ndjson', {
    bytes: Buffer.from(
      '{"id":1,"ts":"2026-05-20T10:00:00Z","payload":"a"}\n' +
        '{"id":2,"ts":"2026-05-20T10:00:01Z","payload":"b"}\n',
      'utf-8',
    ),
    contentType: 'application/x-ndjson',
  });
  OBJECTS.set('bq-load::strings-only.csv', {
    bytes: Buffer.from('id,note\n1,hello\n2,world\n', 'utf-8'),
    contentType: 'text/csv',
  });

  gcs = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const m = url.pathname.match(/^\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/);
    if (m === null) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const bucket = m[1] as string;
    const obj = decodeURIComponent(m[2] as string);
    const stored = OBJECTS.get(`${bucket}::${obj}`);
    if (stored === undefined) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 404 } }));
      return;
    }
    const alt = url.searchParams.get('alt') ?? 'json';
    if (alt === 'json') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          name: obj,
          bucket,
          size: String(stored.bytes.length),
          contentType: stored.contentType,
          updated: '2026-05-24T12:00:00.000Z',
        }),
      );
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', stored.contentType);
    res.end(stored.bytes);
  });
  await new Promise<void>((resolve) => gcs.listen(0, '127.0.0.1', resolve));
  const addr = gcs.address();
  if (addr === null || typeof addr === 'string') throw new Error('GCS stub failed to listen');
  gcsUrl = `http://127.0.0.1:${addr.port}`;
  prevEmulatorHost = process.env['STORAGE_EMULATOR_HOST'];
  process.env['STORAGE_EMULATOR_HOST'] = gcsUrl;

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
  await fetch(`${server.url}/projects/${PROJECT}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: DATASET } }),
  });
});

after(async () => {
  await server.close();
  await db.close();
  if (prevEmulatorHost === undefined) {
    delete process.env['STORAGE_EMULATOR_HOST'];
  } else {
    process.env['STORAGE_EMULATOR_HOST'] = prevEmulatorHost;
  }
  await new Promise<void>((resolve, reject) =>
    gcs.close((err) => (err === undefined ? resolve() : reject(err))),
  );
});

interface JobResponse {
  jobReference?: { jobId: string };
  status: { state: string; errorResult?: { reason: string; message: string } };
  statistics?: {
    load?: { outputRows?: string; outputBytes?: string; inputFiles?: string };
  };
  configuration?: { load?: { sourceUris?: string[]; sourceFormat?: string } };
}

async function postLoad(body: unknown): Promise<{ status: number; body: JobResponse }> {
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
    body: JSON.stringify({ query: `SELECT * FROM \`${DATASET}.${table}\` ORDER BY 1` }),
  });
  const body = (await res.json()) as {
    rows?: Array<{ f: Array<{ v: string | null }> }>;
  };
  return (body.rows ?? []).map((row) => row.f.map((f) => f.v));
}

async function columnsOf(
  table: string,
): Promise<Array<{ name: string; type: string; nullable: string }>> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `SELECT column_name, data_type, is_nullable
              FROM ${DATASET}.INFORMATION_SCHEMA.COLUMNS
              WHERE table_name = '${table}'
              ORDER BY ordinal_position`,
    }),
  });
  const body = (await res.json()) as {
    rows?: Array<{ f: Array<{ v: string | null }> }>;
  };
  return (body.rows ?? []).map((row) => ({
    name: row.f[0]?.v as string,
    type: row.f[1]?.v as string,
    nullable: row.f[2]?.v as string,
  }));
}

// ---------------------------------------------------------------------------
// CSV — autodetect
// ---------------------------------------------------------------------------

test('CSV load with autodetect creates the table, infers types, and inserts rows', async () => {
  const { status, body } = await postLoad({
    configuration: {
      load: {
        sourceUris: ['gs://bq-load/orders.csv'],
        sourceFormat: 'CSV',
        autodetect: true,
        destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders' },
      },
    },
  });
  assert.equal(status, 200);
  assert.equal(body.status.state, 'DONE');
  assert.equal(body.statistics?.load?.outputRows, '3');
  assert.equal(body.configuration?.load?.sourceFormat, 'CSV');

  // Inferred schema should give INT64, STRING, FLOAT64, BOOL.
  const cols = await columnsOf('orders');
  assert.deepEqual(cols, [
    { name: 'order_id', type: 'INT64', nullable: 'YES' },
    { name: 'customer', type: 'STRING', nullable: 'YES' },
    { name: 'amount', type: 'FLOAT64', nullable: 'YES' },
    { name: 'delivered', type: 'BOOL', nullable: 'YES' },
  ]);

  const rows = await rowsOf('orders');
  // BQ wire encodes INT64 as a string, FLOAT64 as a string (with one
  // decimal place for integer-valued floats since DuckDB sees them as
  // DOUBLE), BOOL as literal 'true'/'false'.
  assert.deepEqual(rows, [
    ['1', 'Alice', '9.99', 'true'],
    ['2', 'Bob', '12.5', 'false'],
    ['3', 'Charlie', '7.0', 'true'],
  ]);
});

// ---------------------------------------------------------------------------
// CSV — explicit schema overrides autodetection
// ---------------------------------------------------------------------------

test('CSV load with explicit schema uses caller-supplied types', async () => {
  const { status, body } = await postLoad({
    configuration: {
      load: {
        sourceUris: ['gs://bq-load/strings-only.csv'],
        sourceFormat: 'CSV',
        schema: {
          fields: [
            { name: 'id', type: 'STRING', mode: 'REQUIRED' },
            { name: 'note', type: 'STRING' },
          ],
        },
        destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'notes' },
      },
    },
  });
  assert.equal(status, 200);
  assert.equal(body.statistics?.load?.outputRows, '2');
  const cols = await columnsOf('notes');
  assert.deepEqual(cols, [
    { name: 'id', type: 'STRING', nullable: 'NO' },
    { name: 'note', type: 'STRING', nullable: 'YES' },
  ]);
});

// ---------------------------------------------------------------------------
// NDJSON
// ---------------------------------------------------------------------------

test('NDJSON load with autodetect infers types from JSON value types', async () => {
  const { status, body } = await postLoad({
    configuration: {
      load: {
        sourceUris: ['gs://bq-load/events.ndjson'],
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        autodetect: true,
        destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'events' },
      },
    },
  });
  assert.equal(status, 200);
  assert.equal(body.statistics?.load?.outputRows, '2');
  const cols = await columnsOf('events');
  assert.deepEqual(cols, [
    { name: 'id', type: 'INT64', nullable: 'YES' },
    { name: 'ts', type: 'TIMESTAMP', nullable: 'YES' },
    { name: 'payload', type: 'STRING', nullable: 'YES' },
  ]);
});

// ---------------------------------------------------------------------------
// WRITE_TRUNCATE / WRITE_EMPTY semantics
// ---------------------------------------------------------------------------

test('WRITE_TRUNCATE clears existing rows before inserting the new load', async () => {
  // Re-load orders with WRITE_TRUNCATE. Row count should still be 3, not 6.
  const { status, body } = await postLoad({
    configuration: {
      load: {
        sourceUris: ['gs://bq-load/orders.csv'],
        sourceFormat: 'CSV',
        autodetect: true,
        writeDisposition: 'WRITE_TRUNCATE',
        destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders' },
      },
    },
  });
  assert.equal(status, 200);
  assert.equal(body.statistics?.load?.outputRows, '3');
  const rows = await rowsOf('orders');
  assert.equal(rows.length, 3);
});

test('WRITE_EMPTY fails when the destination is not empty', async () => {
  const { status, body } = await postLoad({
    configuration: {
      load: {
        sourceUris: ['gs://bq-load/orders.csv'],
        sourceFormat: 'CSV',
        autodetect: true,
        writeDisposition: 'WRITE_EMPTY',
        destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders' },
      },
    },
  });
  assert.equal(status, 409);
  const errBody = body as unknown as { error?: { errors?: Array<{ reason: string }> } };
  assert.equal(errBody.error?.errors?.[0]?.reason, 'duplicate');
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('Unsupported sourceFormat returns 400 unsupportedFeature', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      configuration: {
        load: {
          sourceUris: ['gs://bq-load/orders.csv'],
          sourceFormat: 'AVRO',
          destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'avro_target' },
        },
      },
    }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: { errors?: Array<{ reason: string }> } };
  assert.equal(body.error?.errors?.[0]?.reason, 'unsupportedFeature');
});

test('Missing sourceUris returns 400', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      configuration: {
        load: {
          sourceUris: [],
          sourceFormat: 'CSV',
          destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 't' },
        },
      },
    }),
  });
  assert.equal(res.status, 400);
});

test('No schema, no autodetect, destination missing → 400', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      configuration: {
        load: {
          sourceUris: ['gs://bq-load/orders.csv'],
          sourceFormat: 'CSV',
          destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'no_schema' },
        },
      },
    }),
  });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// Job persistence
// ---------------------------------------------------------------------------

test('Successful load job is persisted and visible via GET /jobs/{j}', async () => {
  const { body } = await postLoad({
    configuration: {
      load: {
        sourceUris: ['gs://bq-load/strings-only.csv'],
        sourceFormat: 'CSV',
        autodetect: true,
        destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'persisted' },
      },
    },
    jobReference: { jobId: 'load-job-1' },
  });
  assert.equal(body.jobReference?.jobId, 'load-job-1');
  const lookup = await fetch(`${server.url}/projects/${PROJECT}/jobs/load-job-1`);
  assert.equal(lookup.status, 200);
  const lookupBody = (await lookup.json()) as JobResponse;
  assert.equal(lookupBody.status.state, 'DONE');
});

// ---------------------------------------------------------------------------
// Branch-coverage edges
// ---------------------------------------------------------------------------

test('CSV load with skipLeadingRows=2 skips the first data row after the header', async () => {
  OBJECTS.set('bq-load::skip.csv', {
    bytes: Buffer.from('id,note\n1,first\n2,second\n3,third\n', 'utf-8'),
    contentType: 'text/csv',
  });
  const { status, body } = await postLoad({
    configuration: {
      load: {
        sourceUris: ['gs://bq-load/skip.csv'],
        sourceFormat: 'CSV',
        autodetect: true,
        skipLeadingRows: 2,
        destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'skipped' },
      },
    },
  });
  assert.equal(status, 200);
  // skipLeadingRows=2 means "skip header + 1 data row"; 3 - 1 = 2 rows loaded.
  assert.equal(body.statistics?.load?.outputRows, '2');
});

test('NDJSON with a non-object line returns 400 invalid', async () => {
  OBJECTS.set('bq-load::bad-shape.ndjson', {
    bytes: Buffer.from('{"id":1}\n[1,2,3]\n', 'utf-8'),
    contentType: 'application/x-ndjson',
  });
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      configuration: {
        load: {
          sourceUris: ['gs://bq-load/bad-shape.ndjson'],
          sourceFormat: 'NEWLINE_DELIMITED_JSON',
          autodetect: true,
          destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'bad_shape' },
        },
      },
    }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: { errors?: Array<{ message: string }> } };
  assert.match(body.error?.errors?.[0]?.message ?? '', /not a JSON object/);
});

test('NDJSON with malformed JSON returns 400 invalid', async () => {
  OBJECTS.set('bq-load::malformed.ndjson', {
    bytes: Buffer.from('{"id":1}\n{not json\n', 'utf-8'),
    contentType: 'application/x-ndjson',
  });
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      configuration: {
        load: {
          sourceUris: ['gs://bq-load/malformed.ndjson'],
          sourceFormat: 'NEWLINE_DELIMITED_JSON',
          autodetect: true,
          destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'malformed' },
        },
      },
    }),
  });
  assert.equal(res.status, 400);
});

test('NDJSON autodetect on an empty source returns 400 invalid', async () => {
  OBJECTS.set('bq-load::empty.ndjson', {
    bytes: Buffer.from('\n', 'utf-8'),
    contentType: 'application/x-ndjson',
  });
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      configuration: {
        load: {
          sourceUris: ['gs://bq-load/empty.ndjson'],
          sourceFormat: 'NEWLINE_DELIMITED_JSON',
          autodetect: true,
          destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'empty_src' },
        },
      },
    }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: { errors?: Array<{ message: string }> } };
  assert.match(body.error?.errors?.[0]?.message ?? '', /empty source/i);
});

test('Multi-source CSV load concatenates rows from each URI', async () => {
  OBJECTS.set('bq-load::part-a.csv', {
    bytes: Buffer.from('id,note\n1,a\n2,b\n', 'utf-8'),
    contentType: 'text/csv',
  });
  OBJECTS.set('bq-load::part-b.csv', {
    bytes: Buffer.from('id,note\n3,c\n4,d\n', 'utf-8'),
    contentType: 'text/csv',
  });
  const { status, body } = await postLoad({
    configuration: {
      load: {
        sourceUris: ['gs://bq-load/part-a.csv', 'gs://bq-load/part-b.csv'],
        sourceFormat: 'CSV',
        autodetect: true,
        destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'multi_src' },
      },
    },
  });
  assert.equal(status, 200);
  assert.equal(body.statistics?.load?.outputRows, '4');
});

test('Load with explicit schema into existing destination reuses storage', async () => {
  // Pre-create the destination with a schema.
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'preexisting' },
      schema: {
        fields: [
          { name: 'id', type: 'INT64' },
          { name: 'note', type: 'STRING' },
        ],
      },
    }),
  });
  // Load with no schema + no autodetect — should infer from existing destination's schema.
  OBJECTS.set('bq-load::reuse.csv', {
    bytes: Buffer.from('id,note\n10,x\n', 'utf-8'),
    contentType: 'text/csv',
  });
  const { status, body } = await postLoad({
    configuration: {
      load: {
        sourceUris: ['gs://bq-load/reuse.csv'],
        sourceFormat: 'CSV',
        destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'preexisting' },
      },
    },
  });
  assert.equal(status, 200);
  assert.equal(body.statistics?.load?.outputRows, '1');
});

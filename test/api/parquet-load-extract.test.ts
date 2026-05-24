/**
 * BL-085 + BL-094 — Parquet load + Extract jobs (CSV / NDJSON / Parquet).
 *
 * Test infra: a tiny in-process GCS stub that supports both GET (for
 * loads — `?alt=media`) and POST (for extracts —
 * `/upload/storage/v1/b/{bucket}/o?uploadType=media&name=...`). Objects
 * live in an in-memory Map so we can both seed (load fixtures) and
 * observe (extract outputs).
 *
 * Parquet fixture: we generate a real Parquet file at startup by writing
 * a DuckDB COPY ... TO 'tmp.parquet' (FORMAT PARQUET) statement against
 * an inline VALUES table. That way the test doesn't depend on a
 * checked-in binary asset.
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const PROJECT = 'parquet-test';
const DATASET = 'ds';

interface StoredObject {
  bytes: Buffer;
  contentType: string;
}

const OBJECTS: Map<string, StoredObject> = new Map();

let db: Db;
let server: Server;
let gcs: HttpServer;
let gcsUrl: string;
let prevEmulatorHost: string | undefined;
let tmpDir: string;

before(async () => {
  // GCS stub — supports GET .../o/{name}?alt={json,media} AND
  // POST /upload/.../o?uploadType=media&name=...
  gcs = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const downloadMatch = url.pathname.match(/^\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/);
    const uploadMatch = url.pathname.match(/^\/upload\/storage\/v1\/b\/([^/]+)\/o$/);

    if (req.method === 'GET' && downloadMatch !== null) {
      const bucket = downloadMatch[1] as string;
      const obj = decodeURIComponent(downloadMatch[2] as string);
      const stored = OBJECTS.get(`${bucket}::${obj}`);
      if (stored === undefined) {
        res.statusCode = 404;
        res.end();
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
      } else {
        res.statusCode = 200;
        res.setHeader('content-type', stored.contentType);
        res.end(stored.bytes);
      }
      return;
    }

    if (req.method === 'POST' && uploadMatch !== null) {
      const bucket = uploadMatch[1] as string;
      const name = url.searchParams.get('name');
      if (name === null) {
        res.statusCode = 400;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const bytes = Buffer.concat(chunks);
        OBJECTS.set(`${bucket}::${name}`, {
          bytes,
          contentType:
            (req.headers['content-type'] as string | undefined) ?? 'application/octet-stream',
        });
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ name, bucket, size: String(bytes.length) }));
      });
      return;
    }

    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => gcs.listen(0, '127.0.0.1', resolve));
  const addr = gcs.address();
  if (addr === null || typeof addr === 'string') throw new Error('stub failed to listen');
  gcsUrl = `http://127.0.0.1:${addr.port}`;
  prevEmulatorHost = process.env['STORAGE_EMULATOR_HOST'];
  process.env['STORAGE_EMULATOR_HOST'] = gcsUrl;

  db = await createDb();
  await ensureMetaSchema(db);

  // Generate a parquet fixture via DuckDB COPY against an inline VALUES
  // table. Drop the bytes into the GCS stub at gs://bq-load/orders.parquet.
  tmpDir = await mkdtemp(join(tmpdir(), 'bq-parquet-fixture-'));
  const fixturePath = join(tmpDir, 'orders.parquet');
  await db.exec(
    `COPY (SELECT * FROM (VALUES
        (1::BIGINT, 'Alice', 9.99::DOUBLE, TRUE),
        (2::BIGINT, 'Bob', 12.50::DOUBLE, FALSE),
        (3::BIGINT, 'Charlie', 7.00::DOUBLE, TRUE))
        AS t(order_id, customer, amount, delivered))
     TO '${fixturePath}' (FORMAT PARQUET)`,
  );
  const parquetBytes = await readFile(fixturePath);
  OBJECTS.set('bq-load::orders.parquet', {
    bytes: parquetBytes,
    contentType: 'application/octet-stream',
  });

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
  await rm(tmpDir, { recursive: true, force: true });
});

interface JobResponse {
  status: { state: string };
  statistics?: {
    load?: { outputRows?: string };
    extract?: { destinationUriFileCounts?: string[]; inputBytes?: string };
  };
}

async function postJob(body: unknown): Promise<{ status: number; body: JobResponse }> {
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
  const data = (await res.json()) as { rows?: Array<{ f: Array<{ v: string | null }> }> };
  return (data.rows ?? []).map((row) => row.f.map((f) => f.v));
}

// ---------------------------------------------------------------------------
// Parquet load (BL-085)
// ---------------------------------------------------------------------------

test('Parquet load with autodetect creates the table from inferred Parquet schema', async () => {
  const { status, body } = await postJob({
    configuration: {
      load: {
        sourceUris: ['gs://bq-load/orders.parquet'],
        sourceFormat: 'PARQUET',
        autodetect: true,
        destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders_parquet' },
      },
    },
  });
  assert.equal(status, 200);
  assert.equal(body.status.state, 'DONE');
  assert.equal(body.statistics?.load?.outputRows, '3');

  const rows = await rowsOf('orders_parquet');
  assert.deepEqual(rows, [
    ['1', 'Alice', '9.99', 'true'],
    ['2', 'Bob', '12.5', 'false'],
    ['3', 'Charlie', '7.0', 'true'],
  ]);
});

test('Parquet load with explicit schema bypasses DESCRIBE', async () => {
  const { status, body } = await postJob({
    configuration: {
      load: {
        sourceUris: ['gs://bq-load/orders.parquet'],
        sourceFormat: 'PARQUET',
        schema: {
          fields: [
            { name: 'order_id', type: 'INT64' },
            { name: 'customer', type: 'STRING' },
            { name: 'amount', type: 'FLOAT64' },
            { name: 'delivered', type: 'BOOL' },
          ],
        },
        destinationTable: {
          projectId: PROJECT,
          datasetId: DATASET,
          tableId: 'orders_parquet_explicit',
        },
      },
    },
  });
  assert.equal(status, 200);
  assert.equal(body.statistics?.load?.outputRows, '3');
});

// ---------------------------------------------------------------------------
// Extract — CSV (BL-094)
// ---------------------------------------------------------------------------

test('Extract to CSV writes header + rows to GCS', async () => {
  // Use the orders_parquet table loaded above as the source.
  const { status, body } = await postJob({
    configuration: {
      extract: {
        sourceTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders_parquet' },
        destinationUris: ['gs://bq-extract/orders.csv'],
        destinationFormat: 'CSV',
      },
    },
  });
  assert.equal(status, 200);
  assert.equal(body.status.state, 'DONE');
  assert.equal(body.statistics?.extract?.destinationUriFileCounts?.[0], '1');

  const stored = OBJECTS.get('bq-extract::orders.csv');
  assert.ok(stored !== undefined, 'object was uploaded');
  const csv = stored.bytes.toString('utf-8');
  // Header row + 3 data rows + trailing newline.
  const lines = csv.split('\n');
  assert.equal(lines[0], 'order_id,customer,amount,delivered');
  assert.equal(lines[1]?.startsWith('1,Alice,9.99,true'), true);
  assert.equal(lines.length, 5); // 4 lines + empty trailing
});

test('Extract to CSV with printHeader=false omits the header', async () => {
  await postJob({
    configuration: {
      extract: {
        sourceTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders_parquet' },
        destinationUris: ['gs://bq-extract/no-header.csv'],
        destinationFormat: 'CSV',
        printHeader: false,
      },
    },
  });
  const csv = OBJECTS.get('bq-extract::no-header.csv')?.bytes.toString('utf-8');
  assert.ok(csv !== undefined);
  assert.equal(csv?.startsWith('1,Alice'), true);
});

// ---------------------------------------------------------------------------
// Extract — NDJSON
// ---------------------------------------------------------------------------

test('Extract to NEWLINE_DELIMITED_JSON writes one JSON object per line', async () => {
  await postJob({
    configuration: {
      extract: {
        sourceTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders_parquet' },
        destinationUris: ['gs://bq-extract/orders.ndjson'],
        destinationFormat: 'NEWLINE_DELIMITED_JSON',
      },
    },
  });
  const stored = OBJECTS.get('bq-extract::orders.ndjson');
  assert.ok(stored !== undefined);
  const lines = stored.bytes
    .toString('utf-8')
    .split('\n')
    .filter((line) => line.length > 0);
  assert.equal(lines.length, 3);
  const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(first['order_id'], '1');
  assert.equal(first['customer'], 'Alice');
});

// ---------------------------------------------------------------------------
// Extract — Parquet round-trip
// ---------------------------------------------------------------------------

test('Extract to PARQUET writes a binary file that round-trips via load', async () => {
  // Extract.
  await postJob({
    configuration: {
      extract: {
        sourceTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders_parquet' },
        destinationUris: ['gs://bq-extract/orders.out.parquet'],
        destinationFormat: 'PARQUET',
      },
    },
  });
  const stored = OBJECTS.get('bq-extract::orders.out.parquet');
  assert.ok(stored !== undefined);
  // Parquet starts with "PAR1" magic bytes.
  assert.equal(stored.bytes.subarray(0, 4).toString('latin1'), 'PAR1');

  // Load it back into a fresh table — proves the extracted file is
  // well-formed Parquet that the load path accepts.
  const { status } = await postJob({
    configuration: {
      load: {
        sourceUris: ['gs://bq-extract/orders.out.parquet'],
        sourceFormat: 'PARQUET',
        autodetect: true,
        destinationTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders_roundtrip' },
      },
    },
  });
  assert.equal(status, 200);
  const rows = await rowsOf('orders_roundtrip');
  assert.equal(rows.length, 3);
});

// ---------------------------------------------------------------------------
// Extract validation
// ---------------------------------------------------------------------------

test('Extract with wildcard destinationUri returns unsupportedFeature', async () => {
  const { status, body } = await postJob({
    configuration: {
      extract: {
        sourceTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders_parquet' },
        destinationUris: ['gs://bq-extract/sharded-*.csv'],
        destinationFormat: 'CSV',
      },
    },
  });
  assert.equal(status, 400);
  const err = body as unknown as { error?: { errors?: Array<{ reason: string }> } };
  assert.equal(err.error?.errors?.[0]?.reason, 'unsupportedFeature');
});

test('Extract from a missing table returns 404', async () => {
  const { status } = await postJob({
    configuration: {
      extract: {
        sourceTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'no_such_table' },
        destinationUris: ['gs://bq-extract/whatever.csv'],
        destinationFormat: 'CSV',
      },
    },
  });
  assert.equal(status, 404);
});

test('Extract with unsupported format returns 400 unsupportedFeature', async () => {
  const { status, body } = await postJob({
    configuration: {
      extract: {
        sourceTable: { projectId: PROJECT, datasetId: DATASET, tableId: 'orders_parquet' },
        destinationUris: ['gs://bq-extract/whatever.avro'],
        destinationFormat: 'AVRO',
      },
    },
  });
  assert.equal(status, 400);
  const err = body as unknown as { error?: { errors?: Array<{ reason: string }> } };
  assert.equal(err.error?.errors?.[0]?.reason, 'unsupportedFeature');
});

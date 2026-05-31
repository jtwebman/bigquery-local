/**
 * BL-093 — GCS read client.
 *
 * Spins up a tiny in-process node:http server that mimics the subset of
 * fake-gcs-server / real GCS the client uses (`/storage/v1/b/{bucket}/o/{object}`
 * with `?alt=json` or `?alt=media` and optional Range), then exercises
 * the client against it via `STORAGE_EMULATOR_HOST`.
 */

import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import {
  gcsApiHost,
  getGcsObjectMetadata,
  parseGcsUri,
  readGcsObject,
  readGcsObjectText,
} from '../../src/storage/gcs.ts';

interface StoredObject {
  readonly bytes: Buffer;
  readonly contentType: string;
}

const OBJECTS: Map<string, StoredObject> = new Map();
let server: Server;
let url: string;
let prevEmulatorHost: string | undefined;

function objectKey(bucket: string, object: string): string {
  return `${bucket}::${object}`;
}

before(async () => {
  // Seed objects keyed by `bucket::object`.
  OBJECTS.set(objectKey('bq-load', 'orders.csv'), {
    bytes: Buffer.from('id,total\n1,9.99\n2,12.00\n', 'utf-8'),
    contentType: 'text/csv',
  });
  OBJECTS.set(objectKey('bq-load', 'logs.ndjson'), {
    bytes: Buffer.from('{"line":1}\n{"line":2}\n', 'utf-8'),
    contentType: 'application/x-ndjson',
  });

  server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.end();
      return;
    }
    const reqUrl = new URL(req.url ?? '/', 'http://localhost');
    // Path shape: /storage/v1/b/{bucket}/o/{encodedObject}
    const match = reqUrl.pathname.match(/^\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/);
    if (match === null) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const bucket = match[1] as string;
    const object = decodeURIComponent(match[2] as string);
    const stored = OBJECTS.get(objectKey(bucket, object));
    if (stored === undefined) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 404, message: 'Not Found' } }));
      return;
    }
    const alt = reqUrl.searchParams.get('alt') ?? 'json';
    if (alt === 'json') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          name: object,
          bucket,
          size: String(stored.bytes.length),
          contentType: stored.contentType,
          updated: '2026-05-24T12:00:00.000Z',
        }),
      );
      return;
    }
    // alt=media — serve raw bytes, honoring Range.
    const rangeHeader = req.headers['range'];
    if (typeof rangeHeader === 'string') {
      const m = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
      if (m !== null) {
        const start = Number(m[1]);
        const endRaw = m[2];
        const end = endRaw === '' ? stored.bytes.length - 1 : Number(endRaw);
        const slice = stored.bytes.subarray(start, end + 1);
        res.statusCode = 206;
        res.setHeader('content-type', stored.contentType);
        res.setHeader('content-range', `bytes ${start}-${end}/${stored.bytes.length}`);
        res.end(slice);
        return;
      }
    }
    res.statusCode = 200;
    res.setHeader('content-type', stored.contentType);
    res.end(stored.bytes);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('listen failed');
  url = `http://127.0.0.1:${addr.port}`;
  prevEmulatorHost = process.env['STORAGE_EMULATOR_HOST'];
  process.env['STORAGE_EMULATOR_HOST'] = url;
});

after(async () => {
  if (prevEmulatorHost === undefined) {
    delete process.env['STORAGE_EMULATOR_HOST'];
  } else {
    process.env['STORAGE_EMULATOR_HOST'] = prevEmulatorHost;
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err === undefined ? resolve() : reject(err))),
  );
});

// ---------------------------------------------------------------------------
// URI parsing
// ---------------------------------------------------------------------------

test('parseGcsUri splits bucket and object', () => {
  assert.deepEqual(parseGcsUri('gs://my-bucket/path/to/file.csv'), {
    bucket: 'my-bucket',
    object: 'path/to/file.csv',
  });
});

test('parseGcsUri throws on a malformed URI', () => {
  assert.throws(() => parseGcsUri('https://example.com/bad'));
  assert.throws(() => parseGcsUri('gs://only-bucket'));
});

// ---------------------------------------------------------------------------
// Host resolution
// ---------------------------------------------------------------------------

test('gcsApiHost honors STORAGE_EMULATOR_HOST', () => {
  // The before() hook set it to our test server.
  assert.equal(gcsApiHost(), url);
});

test('gcsApiHost falls back to real GCS when env unset', () => {
  const saved = process.env['STORAGE_EMULATOR_HOST'];
  delete process.env['STORAGE_EMULATOR_HOST'];
  try {
    assert.equal(gcsApiHost(), 'https://storage.googleapis.com');
  } finally {
    process.env['STORAGE_EMULATOR_HOST'] = saved;
  }
});

test('gcsApiHost strips trailing slash from env host', () => {
  const saved = process.env['STORAGE_EMULATOR_HOST'];
  process.env['STORAGE_EMULATOR_HOST'] = 'http://gcs.local:4443/';
  try {
    assert.equal(gcsApiHost(), 'http://gcs.local:4443');
  } finally {
    if (saved === undefined) {
      delete process.env['STORAGE_EMULATOR_HOST'];
    } else {
      process.env['STORAGE_EMULATOR_HOST'] = saved;
    }
  }
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test('readGcsObject buffers the full body', async () => {
  const bytes = await readGcsObject('gs://bq-load/orders.csv');
  assert.equal(new TextDecoder().decode(bytes), 'id,total\n1,9.99\n2,12.00\n');
});

test('readGcsObjectText decodes UTF-8', async () => {
  const text = await readGcsObjectText('gs://bq-load/logs.ndjson');
  assert.equal(text, '{"line":1}\n{"line":2}\n');
});

test('readGcsObject honors a byte range', async () => {
  // 'id,total\n' is 9 bytes — start=9 skips the header.
  const bytes = await readGcsObject('gs://bq-load/orders.csv', { range: { start: 9 } });
  assert.equal(new TextDecoder().decode(bytes), '1,9.99\n2,12.00\n');
});

test('readGcsObject byte range with explicit end', async () => {
  // 'id,total\n1,9.99\n' = 16 bytes; bytes 9-14 = '1,9.99'.
  const bytes = await readGcsObject('gs://bq-load/orders.csv', {
    range: { start: 9, end: 14 },
  });
  assert.equal(new TextDecoder().decode(bytes), '1,9.99');
});

test('readGcsObject surfaces 404 as an error', async () => {
  await assert.rejects(() => readGcsObject('gs://bq-load/missing.csv'), /GCS download failed/);
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

test('getGcsObjectMetadata returns size + contentType + updated', async () => {
  const meta = await getGcsObjectMetadata('gs://bq-load/orders.csv');
  assert.equal(meta.size, 24); // 'id,total\n1,9.99\n2,12.00\n' = 9 + 7 + 8 bytes
  assert.equal(meta.contentType, 'text/csv');
  assert.equal(meta.updated, '2026-05-24T12:00:00.000Z');
});

test('getGcsObjectMetadata surfaces 404 as an error', async () => {
  await assert.rejects(
    () => getGcsObjectMetadata('gs://bq-load/missing.csv'),
    /GCS metadata fetch failed/,
  );
});

// ---------------------------------------------------------------------------
// Uploads — only the failure path is exercised here because the test server
// rejects all non-GET methods with 405. The success path is covered by the
// load/extract integration tests, which use a fuller GCS stub.
// ---------------------------------------------------------------------------

test('writeGcsObject surfaces an upstream non-OK response as an error', async () => {
  const { writeGcsObject } = await import('../../src/storage/gcs.ts');
  await assert.rejects(
    () =>
      writeGcsObject(
        'gs://bq-load/cant-upload-here.csv',
        new TextEncoder().encode('hello'),
        'text/csv',
      ),
    /GCS upload failed/,
  );
});

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { discoveryRoutes } from '../../src/routes/discovery.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

interface DatasetResource {
  kind: string;
  etag: string;
  id: string;
  datasetReference: { datasetId: string; projectId: string };
  friendlyName?: string;
  description?: string;
  location?: string;
  labels?: Record<string, string>;
  defaultTableExpirationMs?: string;
  creationTime: string;
  lastModifiedTime: string;
}

interface GoogleErrorBody {
  error: { code: number; errors: Array<{ reason: string; message: string }>; message: string };
}

let db: Db;
let server: Server;

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [...discoveryRoutes, ...createDatasetRoutes(db)],
  });
  await server.listen(0);
});

after(async () => {
  await server.close();
  await db.close();
});

async function freshProject(): Promise<string> {
  const id = `proj-${Math.random().toString(36).slice(2, 10)}`;
  return id;
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

test('POST creates a dataset and returns the wire shape with etag header', async () => {
  const project = await freshProject();
  const res = await fetch(`${server.url}/projects/${project}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      datasetReference: { datasetId: 'ds1' },
      location: 'US',
      friendlyName: 'Friendly',
      description: 'a description',
      labels: { env: 'dev' },
      defaultTableExpirationMs: '86400000',
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as DatasetResource;
  assert.equal(body.kind, 'bigquery#dataset');
  assert.equal(body.id, `${project}:ds1`);
  assert.equal(body.datasetReference.datasetId, 'ds1');
  assert.equal(body.datasetReference.projectId, project);
  assert.equal(body.location, 'US');
  assert.equal(body.friendlyName, 'Friendly');
  assert.equal(body.description, 'a description');
  assert.deepEqual(body.labels, { env: 'dev' });
  assert.equal(body.defaultTableExpirationMs, '86400000');
  assert.equal(body.etag.length, 16);
  assert.equal(body.creationTime, body.lastModifiedTime);
  assert.equal(res.headers.get('etag'), body.etag);
});

test('POST returns 409 duplicate when the dataset already exists', async () => {
  const project = await freshProject();
  const url = `${server.url}/projects/${project}/datasets`;
  const body = JSON.stringify({ datasetReference: { datasetId: 'dup' } });
  const first = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(first.status, 200);
  const second = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(second.status, 409);
  const err = (await second.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'duplicate');
});

test('POST returns 400 invalid when datasetReference.datasetId is missing', async () => {
  const project = await freshProject();
  const res = await fetch(`${server.url}/projects/${project}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
});

test('POST returns 400 invalid on a malformed labels field', async () => {
  const project = await freshProject();
  const res = await fetch(`${server.url}/projects/${project}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      datasetReference: { datasetId: 'bad' },
      labels: { ok: 'yes', notOk: 42 },
    }),
  });
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
  assert.match(err.error.errors[0]?.message ?? '', /labels\.notOk/);
});

test('POST returns 400 invalid when body is a JSON array (not an object)', async () => {
  const project = await freshProject();
  const res = await fetch(`${server.url}/projects/${project}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([1, 2, 3]),
  });
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
});

test('POST returns 400 invalid when friendlyName is not a string', async () => {
  const project = await freshProject();
  const res = await fetch(`${server.url}/projects/${project}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      datasetReference: { datasetId: 'fn' },
      friendlyName: 123,
    }),
  });
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
  assert.match(err.error.errors[0]?.message ?? '', /friendlyName/);
});

test('POST returns 400 invalid when defaultTableExpirationMs is non-numeric', async () => {
  const project = await freshProject();
  const res = await fetch(`${server.url}/projects/${project}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      datasetReference: { datasetId: 'dte' },
      defaultTableExpirationMs: 'forever',
    }),
  });
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
});

test('POST returns 400 invalid when labels is an array', async () => {
  const project = await freshProject();
  const res = await fetch(`${server.url}/projects/${project}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      datasetReference: { datasetId: 'la' },
      labels: ['not', 'allowed'],
    }),
  });
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

test('GET returns the dataset wire shape', async () => {
  const project = await freshProject();
  await fetch(`${server.url}/projects/${project}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: 'g1' }, location: 'EU' }),
  });
  const res = await fetch(`${server.url}/projects/${project}/datasets/g1`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as DatasetResource;
  assert.equal(body.datasetReference.datasetId, 'g1');
  assert.equal(body.location, 'EU');
});

test('GET returns 404 notFound when the dataset does not exist', async () => {
  const project = await freshProject();
  const res = await fetch(`${server.url}/projects/${project}/datasets/missing`);
  assert.equal(res.status, 404);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'notFound');
});

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

test('PATCH replaces only the fields present in the body', async () => {
  const project = await freshProject();
  await fetch(`${server.url}/projects/${project}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      datasetReference: { datasetId: 'p1' },
      description: 'original',
      location: 'US',
      labels: { team: 'data' },
    }),
  });
  const res = await fetch(`${server.url}/projects/${project}/datasets/p1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'patched', labels: { team: 'platform' } }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as DatasetResource;
  assert.equal(body.description, 'patched');
  assert.equal(body.location, 'US'); // preserved
  assert.deepEqual(body.labels, { team: 'platform' }); // replaced
});

test('PATCH returns 404 notFound for a missing dataset', async () => {
  const project = await freshProject();
  const res = await fetch(`${server.url}/projects/${project}/datasets/none`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'x' }),
  });
  assert.equal(res.status, 404);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'notFound');
});

test('PATCH with matching If-Match succeeds', async () => {
  const project = await freshProject();
  const post = await fetch(`${server.url}/projects/${project}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: 'im1' } }),
  });
  const created = (await post.json()) as DatasetResource;
  const res = await fetch(`${server.url}/projects/${project}/datasets/im1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'if-match': created.etag },
    body: JSON.stringify({ description: 'ok' }),
  });
  assert.equal(res.status, 200);
});

test('PATCH with stale If-Match returns 412 conditionNotMet', async () => {
  const project = await freshProject();
  await fetch(`${server.url}/projects/${project}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: 'im2' } }),
  });
  const res = await fetch(`${server.url}/projects/${project}/datasets/im2`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'if-match': 'stale-etag' },
    body: JSON.stringify({ description: 'fail' }),
  });
  assert.equal(res.status, 412);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'conditionNotMet');
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

test('DELETE removes the dataset and returns 204', async () => {
  const project = await freshProject();
  await fetch(`${server.url}/projects/${project}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: 'd1' } }),
  });
  const del = await fetch(`${server.url}/projects/${project}/datasets/d1`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  const get = await fetch(`${server.url}/projects/${project}/datasets/d1`);
  assert.equal(get.status, 404);
});

test('DELETE returns 404 notFound for a missing dataset', async () => {
  const project = await freshProject();
  const res = await fetch(`${server.url}/projects/${project}/datasets/never`, {
    method: 'DELETE',
  });
  assert.equal(res.status, 404);
});

test('DELETE with stale If-Match returns 412 conditionNotMet', async () => {
  const project = await freshProject();
  await fetch(`${server.url}/projects/${project}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: 'imd' } }),
  });
  const res = await fetch(`${server.url}/projects/${project}/datasets/imd`, {
    method: 'DELETE',
    headers: { 'if-match': 'stale' },
  });
  assert.equal(res.status, 412);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'conditionNotMet');
});

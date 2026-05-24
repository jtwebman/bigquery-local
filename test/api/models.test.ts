/**
 * BL-072 — Models REST CRUD (metadata only, no training).
 *
 * Models can be inserted into storage via `upsertModel`, then read /
 * patched / deleted via REST. The POST endpoint is intentionally omitted
 * (real BigQuery creates models via SQL DDL — CREATE MODEL, BL-140 —
 * not via REST POST). To test the REST surface end-to-end we seed the
 * storage layer directly.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createModelRoutes } from '../../src/routes/models.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema, upsertModel } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

let db: Db;
let server: Server;
const PROJECT = 'models-test';
const DATASET = 'ds';
const BASE = (): string => `${server.url}/projects/${PROJECT}/datasets/${DATASET}/models`;

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [...createDatasetRoutes(db), ...createModelRoutes(db)],
  });
  await server.listen(0);
  await fetch(`${server.url}/projects/${PROJECT}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: DATASET } }),
  });
  // Seed a model via the storage layer directly — REST POST is not exposed.
  await upsertModel(db, {
    project: PROJECT,
    datasetId: DATASET,
    modelId: 'churn',
    modelType: 'LOGISTIC_REGRESSION',
    description: 'Churn predictor',
    labels: { team: 'analytics' },
    featureColumns: [{ name: 'tenure', type: { typeKind: 'INT64' } }],
    labelColumns: [{ name: 'churned', type: { typeKind: 'BOOL' } }],
  });
});
after(async () => {
  await server.close();
  await db.close();
});

interface ModelWire {
  modelReference: { projectId: string; datasetId: string; modelId: string };
  modelType: string;
  etag: string;
  description?: string;
  labels?: Record<string, string>;
  featureColumns?: unknown;
  labelColumns?: unknown;
  friendlyName?: string;
}

test('GET returns the seeded model with full shape', async () => {
  const res = await fetch(`${BASE()}/churn`);
  assert.equal(res.status, 200);
  const model = (await res.json()) as ModelWire;
  assert.equal(model.modelReference.modelId, 'churn');
  assert.equal(model.modelType, 'LOGISTIC_REGRESSION');
  assert.equal(model.description, 'Churn predictor');
  assert.deepEqual(model.labels, { team: 'analytics' });
  assert.ok(Array.isArray(model.featureColumns));
});

test('GET unknown model returns 404', async () => {
  const res = await fetch(`${BASE()}/nonexistent`);
  assert.equal(res.status, 404);
});

test('PATCH updates description and bumps etag', async () => {
  const before = (await (await fetch(`${BASE()}/churn`)).json()) as ModelWire;
  const patch = await fetch(`${BASE()}/churn`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'Updated churn model', friendlyName: 'Churn v2' }),
  });
  assert.equal(patch.status, 200);
  const after = (await patch.json()) as ModelWire;
  assert.equal(after.description, 'Updated churn model');
  assert.equal(after.friendlyName, 'Churn v2');
  // Labels preserved from seed (PATCH semantics).
  assert.deepEqual(after.labels, { team: 'analytics' });
  assert.notEqual(after.etag, before.etag);
});

test('PATCH with stale If-Match returns 412', async () => {
  const res = await fetch(`${BASE()}/churn`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'if-match': 'stale-etag' },
    body: JSON.stringify({ description: 'Should fail' }),
  });
  assert.equal(res.status, 412);
});

test('LIST returns the seeded model', async () => {
  // Add a second model so list-shape is exercised.
  await upsertModel(db, {
    project: PROJECT,
    datasetId: DATASET,
    modelId: 'forecast',
    modelType: 'ARIMA_PLUS',
  });
  const list = (await (await fetch(BASE())).json()) as {
    models: Array<{ modelReference: { modelId: string } }>;
  };
  const ids = list.models.map((m) => m.modelReference.modelId).sort();
  assert.deepEqual(ids, ['churn', 'forecast']);
});

test('DELETE removes the model and 404s on subsequent GET', async () => {
  const del = await fetch(`${BASE()}/forecast`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  const read = await fetch(`${BASE()}/forecast`);
  assert.equal(read.status, 404);
});

test('Models under a missing dataset return 404 on list', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/no_such/models`);
  assert.equal(res.status, 404);
});

test('PATCH with non-object body returns 400', async () => {
  const res = await fetch(`${BASE()}/churn`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify('not an object'),
  });
  assert.equal(res.status, 400);
});

test('PATCH validation rejects bad field types', async () => {
  // Non-string description → 400.
  let res = await fetch(`${BASE()}/churn`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: 12345 }),
  });
  assert.equal(res.status, 400);

  // Non-object labels → 400.
  res = await fetch(`${BASE()}/churn`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ labels: 'not-an-object' }),
  });
  assert.equal(res.status, 400);

  // Labels with non-string value → 400.
  res = await fetch(`${BASE()}/churn`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ labels: { team: 42 } }),
  });
  assert.equal(res.status, 400);

  // Bogus expirationTime → 400.
  res = await fetch(`${BASE()}/churn`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expirationTime: 'not-a-number' }),
  });
  assert.equal(res.status, 400);

  // Numeric-string expirationTime accepted.
  res = await fetch(`${BASE()}/churn`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expirationTime: '9999999999999' }),
  });
  assert.equal(res.status, 200);
});

test('LIST validation: bad pageToken and maxResults each return 400', async () => {
  let res = await fetch(`${BASE()}?pageToken=-1`);
  assert.equal(res.status, 400);
  res = await fetch(`${BASE()}?maxResults=0`);
  assert.equal(res.status, 400);
});

test('DELETE with stale If-Match returns 412', async () => {
  const res = await fetch(`${BASE()}/churn`, {
    method: 'DELETE',
    headers: { 'if-match': 'stale-etag' },
  });
  assert.equal(res.status, 412);
});

test('DELETE missing model returns 404', async () => {
  const res = await fetch(`${BASE()}/nope-not-here`, { method: 'DELETE' });
  assert.equal(res.status, 404);
});

test('PATCH with valid labels replaces the labels map', async () => {
  const res = await fetch(`${BASE()}/churn`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ labels: { team: 'ml', owner: 'jt' } }),
  });
  assert.equal(res.status, 200);
  const model = (await res.json()) as ModelWire;
  assert.deepEqual(model.labels, { team: 'ml', owner: 'jt' });
});

test('PATCH with location and featureColumns updates both', async () => {
  const res = await fetch(`${BASE()}/churn`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      location: 'US',
      featureColumns: [{ name: 'updated', type: { typeKind: 'STRING' } }],
      labelColumns: [{ name: 'y', type: { typeKind: 'BOOL' } }],
    }),
  });
  assert.equal(res.status, 200);
  const model = (await res.json()) as ModelWire;
  assert.ok(Array.isArray(model.featureColumns));
});

test('PATCH on missing model returns 404', async () => {
  const res = await fetch(`${BASE()}/nope-not-here`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'whatever' }),
  });
  assert.equal(res.status, 404);
});

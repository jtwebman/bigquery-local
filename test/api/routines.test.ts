/**
 * BL-071 — Routines REST CRUD.
 *
 * Exercises the GET / POST / GET / PATCH / DELETE / LIST lifecycle on
 * /projects/{p}/datasets/{d}/routines. The persisted shape is the same
 * one CREATE FUNCTION populates via SQL; this route just exposes it via
 * REST so clients (dbt, BI tools) can introspect routines without
 * running a query.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createRoutineRoutes } from '../../src/routes/routines.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

let db: Db;
let server: Server;
const PROJECT = 'routines-test';
const DATASET = 'ds';
const BASE = (): string => `${server.url}/projects/${PROJECT}/datasets/${DATASET}/routines`;

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [...createDatasetRoutes(db), ...createRoutineRoutes(db)],
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
});

interface RoutineWire {
  routineReference: { projectId: string; datasetId: string; routineId: string };
  routineType: string;
  language: string;
  definitionBody: string;
  etag: string;
  arguments?: Array<{ name: string; dataType: { typeKind: string } }>;
  returnType?: { typeKind: string };
}

test('POST creates a SQL UDF and GET returns the same shape', async () => {
  const create = await fetch(BASE(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      routineReference: { routineId: 'add_one' },
      routineType: 'SCALAR_FUNCTION',
      language: 'SQL',
      arguments: [{ name: 'x', dataType: { typeKind: 'INT64' } }],
      returnType: { typeKind: 'INT64' },
      definitionBody: 'x + 1',
    }),
  });
  assert.equal(create.status, 200);
  const created = (await create.json()) as RoutineWire;
  assert.equal(created.routineReference.routineId, 'add_one');
  assert.equal(created.routineType, 'SCALAR_FUNCTION');
  assert.equal(created.definitionBody, 'x + 1');
  assert.ok(created.etag.length > 0);

  const read = await fetch(`${BASE()}/add_one`);
  assert.equal(read.status, 200);
  const fetched = (await read.json()) as RoutineWire;
  assert.equal(fetched.etag, created.etag);
  assert.equal(fetched.returnType?.typeKind, 'INT64');
  assert.equal(fetched.arguments?.[0]?.name, 'x');
});

test('POST duplicate returns 409', async () => {
  const res = await fetch(BASE(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      routineReference: { routineId: 'add_one' },
      routineType: 'SCALAR_FUNCTION',
      definitionBody: 'x + 1',
    }),
  });
  assert.equal(res.status, 409);
});

test('PATCH updates definitionBody and bumps etag', async () => {
  const before = (await (await fetch(`${BASE()}/add_one`)).json()) as RoutineWire;
  const patch = await fetch(`${BASE()}/add_one`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ definitionBody: 'x + 2' }),
  });
  assert.equal(patch.status, 200);
  const after = (await patch.json()) as RoutineWire;
  assert.equal(after.definitionBody, 'x + 2');
  assert.notEqual(after.etag, before.etag);
});

test('GET unknown routine returns 404', async () => {
  const res = await fetch(`${BASE()}/nonexistent`);
  assert.equal(res.status, 404);
});

test('LIST returns routines paginated', async () => {
  // Create a second routine to verify list shape.
  await fetch(BASE(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      routineReference: { routineId: 'concat3' },
      routineType: 'SCALAR_FUNCTION',
      language: 'SQL',
      definitionBody: "CONCAT(a, '.', b)",
    }),
  });
  const list = (await (await fetch(BASE())).json()) as {
    routines: Array<{ routineReference: { routineId: string } }>;
    nextPageToken?: string;
  };
  const ids = list.routines.map((r) => r.routineReference.routineId).sort();
  assert.deepEqual(ids, ['add_one', 'concat3']);
});

test('DELETE removes the routine and 404s on subsequent GET', async () => {
  const del = await fetch(`${BASE()}/add_one`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  const read = await fetch(`${BASE()}/add_one`);
  assert.equal(read.status, 404);
});

test('Routines under a missing dataset return 404 on list', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/no_such/routines`);
  assert.equal(res.status, 404);
});

test('POST with missing routineType returns 400', async () => {
  const res = await fetch(BASE(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      routineReference: { routineId: 'bad' },
      definitionBody: 'x',
    }),
  });
  assert.equal(res.status, 400);
});

test('POST with bogus routineType returns 400', async () => {
  const res = await fetch(BASE(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      routineReference: { routineId: 'bad' },
      routineType: 'NOT_A_REAL_TYPE',
      definitionBody: 'x',
    }),
  });
  assert.equal(res.status, 400);
});

test('POST validation rejects bad inputs', async () => {
  // Non-object body → 400.
  let res = await fetch(BASE(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify('not an object'),
  });
  assert.equal(res.status, 400);

  // Missing routineReference.routineId → 400.
  res = await fetch(BASE(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      routineType: 'SCALAR_FUNCTION',
      definitionBody: 'x',
    }),
  });
  assert.equal(res.status, 400);

  // Missing definitionBody → 400.
  res = await fetch(BASE(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      routineReference: { routineId: 'bad' },
      routineType: 'SCALAR_FUNCTION',
    }),
  });
  assert.equal(res.status, 400);

  // Non-string definitionBody → 400.
  res = await fetch(BASE(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      routineReference: { routineId: 'bad' },
      routineType: 'SCALAR_FUNCTION',
      definitionBody: 123,
    }),
  });
  assert.equal(res.status, 400);

  // Bogus language → 400.
  res = await fetch(BASE(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      routineReference: { routineId: 'bad' },
      routineType: 'SCALAR_FUNCTION',
      language: 'COBOL',
      definitionBody: 'x',
    }),
  });
  assert.equal(res.status, 400);
});

test('PATCH on missing routine returns 404', async () => {
  const res = await fetch(`${BASE()}/never-existed`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ definitionBody: 'x + 9' }),
  });
  assert.equal(res.status, 404);
});

test('DELETE on missing routine returns 404', async () => {
  const res = await fetch(`${BASE()}/never-existed`, { method: 'DELETE' });
  assert.equal(res.status, 404);
});

test('PATCH preserves arguments + returnType when not in the patch body', async () => {
  // Create a routine with both.
  await fetch(BASE(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      routineReference: { routineId: 'sq' },
      routineType: 'SCALAR_FUNCTION',
      arguments: [{ name: 'x', dataType: { typeKind: 'INT64' } }],
      returnType: { typeKind: 'INT64' },
      definitionBody: 'x * x',
    }),
  });
  // Patch only the body — arguments + returnType should be preserved.
  const res = await fetch(`${BASE()}/sq`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ definitionBody: 'x * x * x' }),
  });
  assert.equal(res.status, 200);
  const patched = (await res.json()) as RoutineWire;
  assert.equal(patched.definitionBody, 'x * x * x');
  assert.equal(patched.arguments?.[0]?.name, 'x');
  assert.equal(patched.returnType?.typeKind, 'INT64');
});

test('LIST validation: bad pageToken and bad maxResults each return 400', async () => {
  let res = await fetch(`${BASE()}?pageToken=-1`);
  assert.equal(res.status, 400);
  res = await fetch(`${BASE()}?maxResults=-5`);
  assert.equal(res.status, 400);
  // maxResults gets clamped to 1000 — passing more is silently capped, not an error.
  res = await fetch(`${BASE()}?maxResults=99999`);
  assert.equal(res.status, 200);
});

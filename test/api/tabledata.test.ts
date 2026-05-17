import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createTabledataRoutes } from '../../src/routes/tabledata.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

interface InsertAllResponse {
  kind: string;
  insertErrors?: Array<{
    index: number;
    errors: Array<{ reason: string; message: string; location?: string }>;
  }>;
}

interface GoogleErrorBody {
  error: { code: number; errors: Array<{ reason: string; message: string }>; message: string };
}

let db: Db;
let server: Server;

const PROJECT = 'tabledata-test-project';
const DATASET = 'ds';

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [...createDatasetRoutes(db), ...createTableRoutes(db), ...createTabledataRoutes(db)],
  });
  await server.listen(0);
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: DATASET } }),
  });
  assert.equal(res.status, 200);
});

after(async () => {
  await server.close();
  await db.close();
});

let nextTableSerial = 0;
async function freshTable(
  fields: ReadonlyArray<{ name: string; type: string; mode?: string }>,
): Promise<string> {
  nextTableSerial += 1;
  const tableId = `t${nextTableSerial}`;
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId },
      schema: { fields },
    }),
  });
  assert.equal(res.status, 200);
  return tableId;
}

async function insertAll(
  tableId: string,
  body: object,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}/insertAll`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, json: await res.json() };
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

test('insertAll persists rows visible via SELECT *', async () => {
  const tableId = await freshTable([
    { name: 'id', type: 'INT64', mode: 'REQUIRED' },
    { name: 'name', type: 'STRING' },
  ]);
  const { status, json } = await insertAll(tableId, {
    rows: [{ json: { id: '1', name: 'alice' } }, { json: { id: '2', name: 'bob' } }],
  });
  assert.equal(status, 200);
  assert.deepEqual(json, { kind: 'bigquery#tableDataInsertAllResponse' });
  const rows = await db.query<{ id: bigint; name: string }>(
    `SELECT id, name FROM "${PROJECT}__${DATASET}"."${tableId}" ORDER BY id`,
  );
  assert.deepEqual(rows, [
    { id: 1n, name: 'alice' },
    { id: 2n, name: 'bob' },
  ]);
});

test('insertAll with empty rows array succeeds with no inserts', async () => {
  const tableId = await freshTable([{ name: 'a', type: 'STRING' }]);
  const { status, json } = await insertAll(tableId, { rows: [] });
  assert.equal(status, 200);
  assert.deepEqual(json, { kind: 'bigquery#tableDataInsertAllResponse' });
  const rows = await db.query(`SELECT * FROM "${PROJECT}__${DATASET}"."${tableId}"`);
  assert.equal(rows.length, 0);
});

test('insertAll round-trips all v0 types together', async () => {
  const tableId = await freshTable([
    { name: 's', type: 'STRING' },
    { name: 'i', type: 'INT64' },
    { name: 'f', type: 'FLOAT64' },
    { name: 'b', type: 'BOOL' },
    { name: 'd', type: 'DATE' },
    { name: 't', type: 'TIMESTAMP' },
    { name: 'tags', type: 'STRING', mode: 'REPEATED' },
  ]);
  const { status, json } = await insertAll(tableId, {
    rows: [
      {
        json: {
          s: 'hello',
          i: '42',
          f: 1.5,
          b: true,
          d: '2026-05-16',
          t: '2026-05-16T10:11:12.000Z',
          tags: ['a', 'b'],
        },
      },
    ],
  });
  assert.equal(status, 200);
  assert.deepEqual(json, { kind: 'bigquery#tableDataInsertAllResponse' });
  const rows = await db.query<Record<string, unknown>>(
    `SELECT s, i, f, b, d::VARCHAR AS d, t, tags FROM "${PROJECT}__${DATASET}"."${tableId}"`,
  );
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row?.['s'], 'hello');
  assert.equal(row?.['i'], 42n);
  assert.equal(row?.['f'], 1.5);
  assert.equal(row?.['b'], true);
  assert.equal(row?.['d'], '2026-05-16');
  assert.deepEqual(row?.['tags'], ['a', 'b']);
});

// ---------------------------------------------------------------------------
// 404 / 400 paths
// ---------------------------------------------------------------------------

test('insertAll returns 404 when the table does not exist', async () => {
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/no-such-table/insertAll`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows: [] }),
    },
  );
  assert.equal(res.status, 404);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'notFound');
});

test('insertAll returns 400 when rows is not an array', async () => {
  const tableId = await freshTable([{ name: 'a', type: 'STRING' }]);
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}/insertAll`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows: 'not-array' }),
    },
  );
  assert.equal(res.status, 400);
});

test('insertAll returns 400 when a row is missing the json field', async () => {
  const tableId = await freshTable([{ name: 'a', type: 'STRING' }]);
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}/insertAll`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows: [{}] }),
    },
  );
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// Partial failure — encode time (unknown field)
// ---------------------------------------------------------------------------

test('insertAll with an unknown field and ignoreUnknownValues=false reports invalid', async () => {
  const tableId = await freshTable([{ name: 'a', type: 'STRING' }]);
  const { status, json } = await insertAll(tableId, {
    rows: [{ json: { a: 'ok' } }, { json: { a: 'also ok', extra: 'oops' } }],
  });
  assert.equal(status, 200);
  const body = json as InsertAllResponse;
  assert.equal(body.insertErrors?.length, 1);
  assert.equal(body.insertErrors?.[0]?.index, 1);
  assert.equal(body.insertErrors?.[0]?.errors[0]?.reason, 'invalid');
  assert.equal(body.insertErrors?.[0]?.errors[0]?.location, 'extra');
  // With skipInvalidRows=false (default), the entire batch is rolled back.
  const rows = await db.query(`SELECT * FROM "${PROJECT}__${DATASET}"."${tableId}"`);
  assert.equal(rows.length, 0);
});

test('insertAll with ignoreUnknownValues=true silently drops unknown fields', async () => {
  const tableId = await freshTable([{ name: 'a', type: 'STRING' }]);
  const { status, json } = await insertAll(tableId, {
    ignoreUnknownValues: true,
    rows: [{ json: { a: 'ok', extra: 'gone' } }],
  });
  assert.equal(status, 200);
  const body = json as InsertAllResponse;
  assert.equal(body.insertErrors, undefined);
  const rows = await db.query<{ a: string }>(`SELECT a FROM "${PROJECT}__${DATASET}"."${tableId}"`);
  assert.deepEqual(
    rows.map((r) => r.a),
    ['ok'],
  );
});

// ---------------------------------------------------------------------------
// skipInvalidRows behavior
// ---------------------------------------------------------------------------

test('skipInvalidRows=true keeps valid rows and reports failures per-row', async () => {
  const tableId = await freshTable([
    { name: 'id', type: 'INT64', mode: 'REQUIRED' },
    { name: 'name', type: 'STRING' },
  ]);
  const { status, json } = await insertAll(tableId, {
    skipInvalidRows: true,
    rows: [
      { json: { id: '1', name: 'good-1' } },
      { json: { id: '2', name: 'good-2', extra: 'unknown' } }, // unknown field
      { json: { id: '3', name: 'good-3' } },
    ],
  });
  assert.equal(status, 200);
  const body = json as InsertAllResponse;
  assert.equal(body.insertErrors?.length, 1);
  assert.equal(body.insertErrors?.[0]?.index, 1);
  const rows = await db.query<{ id: bigint; name: string }>(
    `SELECT id, name FROM "${PROJECT}__${DATASET}"."${tableId}" ORDER BY id`,
  );
  assert.deepEqual(rows, [
    { id: 1n, name: 'good-1' },
    { id: 3n, name: 'good-3' },
  ]);
});

test('skipInvalidRows=false rolls back the entire batch on any failure', async () => {
  const tableId = await freshTable([
    { name: 'id', type: 'INT64', mode: 'REQUIRED' },
    { name: 'name', type: 'STRING' },
  ]);
  const { status, json } = await insertAll(tableId, {
    skipInvalidRows: false,
    rows: [
      { json: { id: '1', name: 'good-1' } },
      { json: { id: '2', name: 'good-2', extra: 'unknown' } },
    ],
  });
  assert.equal(status, 200);
  const body = json as InsertAllResponse;
  assert.equal(body.insertErrors?.length, 1);
  const rows = await db.query(`SELECT * FROM "${PROJECT}__${DATASET}"."${tableId}"`);
  assert.equal(rows.length, 0);
});

test('missing REQUIRED field causes a runtime error on insert', async () => {
  const tableId = await freshTable([
    { name: 'id', type: 'INT64', mode: 'REQUIRED' },
    { name: 'name', type: 'STRING' },
  ]);
  const { status, json } = await insertAll(tableId, {
    skipInvalidRows: true,
    rows: [
      { json: { id: '1', name: 'ok' } },
      { json: { name: 'no-id-given' } }, // missing REQUIRED id
    ],
  });
  assert.equal(status, 200);
  const body = json as InsertAllResponse;
  assert.equal(body.insertErrors?.length, 1);
  assert.equal(body.insertErrors?.[0]?.index, 1);
  // Valid row still inserted.
  const rows = await db.query<{ id: bigint }>(
    `SELECT id FROM "${PROJECT}__${DATASET}"."${tableId}"`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, 1n);
});

test('all-rows-invalid transactional path: zero inserted, full error report', async () => {
  const tableId = await freshTable([{ name: 'a', type: 'STRING' }]);
  const { status, json } = await insertAll(tableId, {
    rows: [{ json: { wrong: 'x' } }, { json: { also_wrong: 'y' } }],
  });
  assert.equal(status, 200);
  const body = json as InsertAllResponse;
  assert.equal(body.insertErrors?.length, 2);
  const rows = await db.query(`SELECT * FROM "${PROJECT}__${DATASET}"."${tableId}"`);
  assert.equal(rows.length, 0);
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

test('insertAll accepts insertId on rows (no dedup yet, but valid input)', async () => {
  const tableId = await freshTable([{ name: 'a', type: 'STRING' }]);
  const { status } = await insertAll(tableId, {
    rows: [
      { insertId: 'abc-1', json: { a: 'one' } },
      { insertId: 'abc-2', json: { a: 'two' } },
    ],
  });
  assert.equal(status, 200);
  const rows = await db.query<{ a: string }>(
    `SELECT a FROM "${PROJECT}__${DATASET}"."${tableId}" ORDER BY a`,
  );
  assert.deepEqual(
    rows.map((r) => r.a),
    ['one', 'two'],
  );
});

test('insertAll rejects a non-string insertId with 400', async () => {
  const tableId = await freshTable([{ name: 'a', type: 'STRING' }]);
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}/insertAll`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows: [{ insertId: 42, json: { a: 'x' } }] }),
    },
  );
  assert.equal(res.status, 400);
});

test('insertAll rejects a non-boolean skipInvalidRows with 400', async () => {
  const tableId = await freshTable([{ name: 'a', type: 'STRING' }]);
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}/insertAll`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skipInvalidRows: 'yes', rows: [] }),
    },
  );
  assert.equal(res.status, 400);
});

test('insertAll rejects a request body that is not a JSON object', async () => {
  const tableId = await freshTable([{ name: 'a', type: 'STRING' }]);
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}/insertAll`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(['not', 'an', 'object']),
    },
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as GoogleErrorBody;
  assert.equal(body.error.errors[0]?.reason, 'invalid');
});

test('insertAll per-row encoding error: INT64 column receives a non-numeric value', async () => {
  // Pre-validation encoding failure: `bqValueToDuck(\"not-a-number\", INT64)` throws
  // synchronously (BigInt parse error). skipInvalidRows=true keeps the good row.
  const tableId = await freshTable([
    { name: 'n', type: 'INT64' },
    { name: 'name', type: 'STRING' },
  ]);
  const { status, json } = await insertAll(tableId, {
    skipInvalidRows: true,
    rows: [{ json: { n: '1', name: 'ok' } }, { json: { n: 'not-a-number', name: 'bad' } }],
  });
  assert.equal(status, 200);
  const body = json as InsertAllResponse;
  assert.equal(body.insertErrors?.length, 1);
  assert.equal(body.insertErrors?.[0]?.index, 1);
  const rows = await db.query<{ n: bigint }>(`SELECT n FROM "${PROJECT}__${DATASET}"."${tableId}"`);
  assert.equal(rows.length, 1);
});

test('insertAll skipInvalidRows=false rollback on a *runtime* DB error (NOT NULL)', async () => {
  // Pre-validation passes — null in JSON encodes to NULL at the SQL layer.
  // The INSERT itself fails on the NOT NULL constraint (REQUIRED), triggering
  // the transactional rollback path that releases earlier successful inserts.
  const tableId = await freshTable([
    { name: 'id', type: 'INT64', mode: 'REQUIRED' },
    { name: 'name', type: 'STRING' },
  ]);
  const { status, json } = await insertAll(tableId, {
    skipInvalidRows: false,
    rows: [
      { json: { id: '1', name: 'good-1' } },
      { json: { id: null, name: 'bad-required-null' } }, // NULL into NOT NULL column
      { json: { id: '3', name: 'never-reached' } },
    ],
  });
  assert.equal(status, 200);
  const body = json as InsertAllResponse;
  // Row at index 1 is the offender; index 0 was rolled back, index 2 never ran.
  assert.equal(body.insertErrors?.length, 1);
  assert.equal(body.insertErrors?.[0]?.index, 1);
  const rows = await db.query(`SELECT * FROM "${PROJECT}__${DATASET}"."${tableId}"`);
  assert.equal(rows.length, 0, 'all rows rolled back, including the earlier successful one');
});

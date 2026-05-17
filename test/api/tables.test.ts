import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

interface FieldWire {
  name: string;
  type: string;
  mode?: 'NULLABLE' | 'REQUIRED' | 'REPEATED';
  description?: string;
  fields?: FieldWire[];
}

interface TableResource {
  kind: string;
  etag: string;
  id: string;
  tableReference: { projectId: string; datasetId: string; tableId: string };
  type: string;
  schema: { fields: FieldWire[] };
  creationTime: string;
  lastModifiedTime: string;
  expirationTime?: string;
  description?: string;
  numRows?: string;
}

interface GoogleErrorBody {
  error: { code: number; errors: Array<{ reason: string; message: string }>; message: string };
}

let db: Db;
let server: Server;

const PROJECT = 'tables-test-project';
const DATASET = 'ds1';

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [...createDatasetRoutes(db), ...createTableRoutes(db)],
  });
  await server.listen(0);
  // Bootstrap the parent dataset for everything below.
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
function freshTableId(): string {
  nextTableSerial += 1;
  return `t${nextTableSerial}`;
}

async function createTable(tableId: string, body: Record<string, unknown>): Promise<TableResource> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...body,
      tableReference: { tableId, ...((body['tableReference'] as object | undefined) ?? {}) },
    }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as TableResource;
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

test('POST creates a table and persists the schema', async () => {
  const tableId = freshTableId();
  const body = await createTable(tableId, {
    schema: {
      fields: [
        { name: 'id', type: 'INTEGER', mode: 'REQUIRED' },
        { name: 'name', type: 'STRING', mode: 'NULLABLE' },
      ],
    },
    description: 'first table',
  });
  assert.equal(body.kind, 'bigquery#table');
  assert.equal(body.id, `${PROJECT}:${DATASET}.${tableId}`);
  assert.equal(body.tableReference.tableId, tableId);
  assert.equal(body.type, 'TABLE');
  assert.deepEqual(body.schema.fields, [
    { name: 'id', type: 'INT64', mode: 'REQUIRED' },
    { name: 'name', type: 'STRING', mode: 'NULLABLE' },
  ]);
  assert.equal(body.description, 'first table');
  assert.equal(body.etag.length, 16);
});

test('POST normalizes type aliases (INTEGER → INT64, FLOAT → FLOAT64)', async () => {
  const body = await createTable(freshTableId(), {
    schema: {
      fields: [
        { name: 'a', type: 'INTEGER' },
        { name: 'b', type: 'FLOAT' },
        { name: 'c', type: 'BOOLEAN' },
        { name: 'd', type: 'RECORD', fields: [{ name: 'inner', type: 'STRING' }] },
      ],
    },
  });
  assert.equal(body.schema.fields[0]?.type, 'INT64');
  assert.equal(body.schema.fields[1]?.type, 'FLOAT64');
  assert.equal(body.schema.fields[2]?.type, 'BOOL');
  assert.equal(body.schema.fields[3]?.type, 'STRUCT');
});

test('POST creates a real DuckDB table that accepts INSERT', async () => {
  const tableId = freshTableId();
  await createTable(tableId, {
    schema: {
      fields: [
        { name: 'id', type: 'INT64' },
        { name: 'name', type: 'STRING' },
      ],
    },
  });
  // Sanity-check the underlying DuckDB table by inserting + querying directly.
  await db.exec(`INSERT INTO "${DATASET}"."${tableId}" VALUES ($1::BIGINT, $2)`, [1n, 'alice']);
  const rows = await db.query<{ id: bigint; name: string }>(
    `SELECT id, name FROM "${DATASET}"."${tableId}"`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.name, 'alice');
});

test('POST returns 409 when the table already exists', async () => {
  const tableId = freshTableId();
  await createTable(tableId, { schema: { fields: [{ name: 'x', type: 'STRING' }] } });
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId },
      schema: { fields: [{ name: 'x', type: 'STRING' }] },
    }),
  });
  assert.equal(res.status, 409);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'duplicate');
});

test('POST returns 404 when the parent dataset does not exist', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/no-such-ds/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'x' },
      schema: { fields: [{ name: 'a', type: 'STRING' }] },
    }),
  });
  assert.equal(res.status, 404);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'notFound');
});

test('POST returns 400 when tableReference.tableId is missing', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schema: { fields: [] } }),
  });
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
  assert.match(err.error.errors[0]?.message ?? '', /tableReference\.tableId/);
});

test('POST returns 400 on a malformed schema field (unknown type)', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'bad' },
      schema: { fields: [{ name: 'a', type: 'WIDGET' }] },
    }),
  });
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
});

test('POST returns 400 on STRUCT with no fields', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'bad' },
      schema: { fields: [{ name: 's', type: 'STRUCT' }] },
    }),
  });
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

test('GET returns the table wire shape with normalized field types', async () => {
  const tableId = freshTableId();
  await createTable(tableId, {
    schema: { fields: [{ name: 'a', type: 'INTEGER' }] },
    description: 'a description',
  });
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as TableResource;
  assert.equal(body.tableReference.tableId, tableId);
  assert.equal(body.schema.fields[0]?.type, 'INT64');
  assert.equal(body.description, 'a description');
});

test('GET returns 404 when the table is missing', async () => {
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/never-existed`,
  );
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// PATCH — the headline schema-evolution flow
// ---------------------------------------------------------------------------

test('PATCH adds new columns and reflects them in the underlying DuckDB table', async () => {
  const tableId = freshTableId();
  await createTable(tableId, {
    schema: {
      fields: [{ name: 'id', type: 'INT64', mode: 'REQUIRED' }],
    },
  });
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: {
          fields: [
            { name: 'id', type: 'INT64', mode: 'REQUIRED' },
            { name: 'name', type: 'STRING' },
            { name: 'tags', type: 'STRING', mode: 'REPEATED' },
          ],
        },
      }),
    },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as TableResource;
  assert.equal(body.schema.fields.length, 3);
  assert.equal(body.schema.fields[1]?.name, 'name');
  assert.equal(body.schema.fields[2]?.name, 'tags');
  assert.equal(body.schema.fields[2]?.mode, 'REPEATED');

  // The DuckDB table actually has the new columns — INSERT into all three
  // succeeds.
  await db.exec(
    `INSERT INTO "${DATASET}"."${tableId}" (id, name, tags) VALUES (1::BIGINT, 'alice', '["a","b"]'::JSON::VARCHAR[])`,
  );
  const rows = await db.query<{ tags: string[] }>(`SELECT tags FROM "${DATASET}"."${tableId}"`);
  assert.deepEqual(rows[0]?.tags, ['a', 'b']);
});

test('PATCH widening REQUIRED → NULLABLE succeeds with no DDL', async () => {
  const tableId = freshTableId();
  await createTable(tableId, {
    schema: { fields: [{ name: 'a', type: 'STRING', mode: 'REQUIRED' }] },
  });
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: { fields: [{ name: 'a', type: 'STRING', mode: 'NULLABLE' }] },
      }),
    },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as TableResource;
  assert.equal(body.schema.fields[0]?.mode, 'NULLABLE');
});

test('PATCH rejects narrowing NULLABLE → REQUIRED', async () => {
  const tableId = freshTableId();
  await createTable(tableId, {
    schema: { fields: [{ name: 'a', type: 'STRING', mode: 'NULLABLE' }] },
  });
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: { fields: [{ name: 'a', type: 'STRING', mode: 'REQUIRED' }] },
      }),
    },
  );
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
  assert.match(err.error.errors[0]?.message ?? '', /mode/);
});

test('PATCH rejects removing a column', async () => {
  const tableId = freshTableId();
  await createTable(tableId, {
    schema: {
      fields: [
        { name: 'keep', type: 'STRING' },
        { name: 'gone', type: 'INT64' },
      ],
    },
  });
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: { fields: [{ name: 'keep', type: 'STRING' }] } }),
    },
  );
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.match(err.error.errors[0]?.message ?? '', /Cannot remove/);
});

test('PATCH rejects changing a column type', async () => {
  const tableId = freshTableId();
  await createTable(tableId, {
    schema: { fields: [{ name: 'a', type: 'STRING' }] },
  });
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: { fields: [{ name: 'a', type: 'INT64' }] } }),
    },
  );
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.match(err.error.errors[0]?.message ?? '', /Cannot change type/);
});

test('PATCH with If-Match success and 412 mismatch', async () => {
  const tableId = freshTableId();
  const created = await createTable(tableId, {
    schema: { fields: [{ name: 'a', type: 'STRING' }] },
  });
  const ok = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': created.etag },
      body: JSON.stringify({ description: 'patched' }),
    },
  );
  assert.equal(ok.status, 200);

  const stale = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': 'stale' },
      body: JSON.stringify({ description: 'fail' }),
    },
  );
  assert.equal(stale.status, 412);
  const err = (await stale.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'conditionNotMet');
});

test('PATCH returns 404 for a missing table', async () => {
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/no-such-table`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'x' }),
    },
  );
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

test('DELETE removes the table from metadata and DuckDB', async () => {
  const tableId = freshTableId();
  await createTable(tableId, {
    schema: { fields: [{ name: 'a', type: 'STRING' }] },
  });
  const del = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`,
    { method: 'DELETE' },
  );
  assert.equal(del.status, 204);
  const get = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`,
  );
  assert.equal(get.status, 404);
  // The underlying DuckDB table is gone too.
  await assert.rejects(
    () => db.query(`SELECT * FROM "${DATASET}"."${tableId}"`),
    /does not exist|not found|catalog/i,
  );
});

test('DELETE returns 404 for a missing table', async () => {
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/never-here`,
    { method: 'DELETE' },
  );
  assert.equal(res.status, 404);
});

test('DELETE with stale If-Match returns 412', async () => {
  const tableId = freshTableId();
  await createTable(tableId, {
    schema: { fields: [{ name: 'a', type: 'STRING' }] },
  });
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`,
    { method: 'DELETE', headers: { 'if-match': 'stale-etag' } },
  );
  assert.equal(res.status, 412);
});

// ---------------------------------------------------------------------------
// Extra rejection coverage
// ---------------------------------------------------------------------------

test('POST returns 400 when a field name is empty', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'empty-name' },
      schema: { fields: [{ name: '', type: 'STRING' }] },
    }),
  });
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.match(err.error.errors[0]?.message ?? '', /non-empty/);
});

test('POST returns 400 when schema.fields is not an array', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'bad-fields' },
      schema: { fields: 'not-an-array' },
    }),
  });
  assert.equal(res.status, 400);
});

test('POST returns 400 when an unknown mode is supplied', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'bad-mode' },
      schema: { fields: [{ name: 'a', type: 'STRING', mode: 'WAT' }] },
    }),
  });
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.match(err.error.errors[0]?.message ?? '', /NULLABLE.*REQUIRED.*REPEATED/);
});

test('POST returns 400 when expirationTime is non-numeric', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'bad-exp' },
      schema: { fields: [{ name: 'a', type: 'STRING' }] },
      expirationTime: 'forever',
    }),
  });
  assert.equal(res.status, 400);
});

test('POST accepts and round-trips expirationTime', async () => {
  const tableId = freshTableId();
  const body = await createTable(tableId, {
    schema: { fields: [{ name: 'a', type: 'STRING' }] },
    expirationTime: '1894000000000',
  });
  assert.equal(body.expirationTime, '1894000000000');
});

test('PATCH rejects modifying STRUCT inner fields', async () => {
  const tableId = freshTableId();
  await createTable(tableId, {
    schema: {
      fields: [
        {
          name: 's',
          type: 'STRUCT',
          fields: [
            { name: 'a', type: 'INT64' },
            { name: 'b', type: 'STRING' },
          ],
        },
      ],
    },
  });
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: {
          fields: [
            {
              name: 's',
              type: 'STRUCT',
              fields: [
                { name: 'a', type: 'INT64' },
                { name: 'b', type: 'STRING' },
                { name: 'c', type: 'BOOL' },
              ],
            },
          ],
        },
      }),
    },
  );
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.match(err.error.errors[0]?.message ?? '', /STRUCT/);
});

test('PATCH rejects toggling REPEATED on existing column', async () => {
  const tableId = freshTableId();
  await createTable(tableId, {
    schema: { fields: [{ name: 'tags', type: 'STRING', mode: 'REPEATED' }] },
  });
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: { fields: [{ name: 'tags', type: 'STRING', mode: 'NULLABLE' }] },
      }),
    },
  );
  assert.equal(res.status, 400);
});

test('PATCH that only updates description is a no-op DDL-wise', async () => {
  const tableId = freshTableId();
  const created = await createTable(tableId, {
    schema: { fields: [{ name: 'a', type: 'STRING' }] },
  });
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'updated text' }),
    },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as TableResource;
  assert.equal(body.description, 'updated text');
  // Schema fields unchanged.
  assert.deepEqual(
    body.schema.fields.map((f) => f.name),
    created.schema.fields.map((f) => f.name),
  );
});

// ---------------------------------------------------------------------------
// Body / field validation
// ---------------------------------------------------------------------------

test('POST .../tables rejects a body that is not a JSON object', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify('not-an-object'),
  });
  assert.equal(res.status, 400);
});

test('POST .../tables rejects a field whose name is not a string', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'tx-bad-name' },
      schema: { fields: [{ name: 99, type: 'STRING' }] },
    }),
  });
  assert.equal(res.status, 400);
});

test('POST .../tables rejects a field whose description is not a string', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'tx-bad-desc' },
      schema: { fields: [{ name: 'a', type: 'STRING', description: 42 }] },
    }),
  });
  assert.equal(res.status, 400);
});

test('PATCH with an unchanged STRUCT schema recurses through inner fields without error', async () => {
  // Hits `fieldsStructurallyEqual`'s inner-field loop (equal arrays return true).
  const tableId = freshTableId();
  await createTable(tableId, {
    schema: {
      fields: [
        {
          name: 's',
          type: 'STRUCT',
          fields: [
            { name: 'a', type: 'INT64' },
            { name: 'b', type: 'STRING' },
          ],
        },
      ],
    },
  });
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        description: 'patched description',
        schema: {
          fields: [
            {
              name: 's',
              type: 'STRUCT',
              fields: [
                { name: 'a', type: 'INT64' },
                { name: 'b', type: 'STRING' },
              ],
            },
          ],
        },
      }),
    },
  );
  assert.equal(res.status, 200);
});

test('PATCH rejects STRUCT inner field rename (same length, different name)', async () => {
  // Same length, hits the per-element comparison branch in fieldsStructurallyEqual.
  const tableId = freshTableId();
  await createTable(tableId, {
    schema: {
      fields: [
        {
          name: 's',
          type: 'STRUCT',
          fields: [
            { name: 'a', type: 'INT64' },
            { name: 'b', type: 'STRING' },
          ],
        },
      ],
    },
  });
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: {
          fields: [
            {
              name: 's',
              type: 'STRUCT',
              fields: [
                { name: 'a', type: 'INT64' },
                { name: 'renamed', type: 'STRING' }, // ← rename
              ],
            },
          ],
        },
      }),
    },
  );
  assert.equal(res.status, 400);
});

/**
 * tabledata.list — GET /projects/{p}/datasets/{d}/tables/{t}/data
 *
 * Paginated reads of a table's rows in BQ wire format ({ f: [{ v }] }).
 * Supports `selectedFields` (comma-separated) projection.
 */

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

interface TableDataListWire {
  kind: string;
  etag: string;
  totalRows: string;
  rows: Array<{ f: Array<{ v: unknown }> }>;
  pageToken?: string;
}

interface GoogleErrorBody {
  error: { code: number; errors: Array<{ reason: string; message: string }>; message: string };
}

let db: Db;
let server: Server;

const PROJECT = 'tabledata-list-tests';
const DATASET = 'ds';

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [...createDatasetRoutes(db), ...createTableRoutes(db), ...createTabledataRoutes(db)],
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

async function freshTable(
  tableId: string,
  fields: ReadonlyArray<{ name: string; type: string; mode?: string }>,
): Promise<void> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tableReference: { tableId }, schema: { fields } }),
  });
  assert.equal(res.status, 200);
}

async function seedRows(
  tableId: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}/insertAll`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows: rows.map((r) => ({ json: r })) }),
    },
  );
  assert.equal(res.status, 200);
}

async function getList(
  tableId: string,
  qs = '',
): Promise<{ status: number; body: TableDataListWire }> {
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}/data${qs}`,
  );
  return { status: res.status, body: (await res.json()) as TableDataListWire };
}

// ---------------------------------------------------------------------------
// 404 + empty
// ---------------------------------------------------------------------------

test('GET /tables/{t}/data returns 404 for an unknown table', async () => {
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/no-such/data`,
  );
  assert.equal(res.status, 404);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'notFound');
});

test('GET /tables/{t}/data returns an empty list for a freshly created table', async () => {
  await freshTable('t_empty', [{ name: 'id', type: 'STRING' }]);
  const { status, body } = await getList('t_empty');
  assert.equal(status, 200);
  assert.equal(body.kind, 'bigquery#tableDataList');
  assert.equal(body.totalRows, '0');
  assert.deepEqual(body.rows, []);
  assert.equal(body.pageToken, undefined);
});

// ---------------------------------------------------------------------------
// Happy paths + pagination
// ---------------------------------------------------------------------------

test('GET /tables/{t}/data returns all rows when total <= page size', async () => {
  await freshTable('t_small', [
    { name: 'id', type: 'STRING' },
    { name: 'n', type: 'INT64' },
  ]);
  await seedRows('t_small', [
    { id: 'a', n: '1' },
    { id: 'b', n: '2' },
    { id: 'c', n: '3' },
  ]);
  const { body } = await getList('t_small');
  assert.equal(body.totalRows, '3');
  assert.equal(body.rows.length, 3);
  assert.equal(body.pageToken, undefined);
  // Wire shape: f[0].v is `id`, f[1].v is `n` (as decimal string per INT64).
  assert.deepEqual(
    body.rows.map((r) => r.f[0]?.v),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    body.rows.map((r) => r.f[1]?.v),
    ['1', '2', '3'],
  );
});

test('GET /tables/{t}/data paginates with maxResults + pageToken', async () => {
  await freshTable('t_page', [{ name: 'id', type: 'STRING' }]);
  await seedRows(
    't_page',
    Array.from({ length: 5 }, (_, i) => ({ id: `r${i}` })),
  );
  const p1 = await getList('t_page', '?maxResults=2');
  assert.equal(p1.body.rows.length, 2);
  assert.equal(p1.body.totalRows, '5');
  assert.equal(p1.body.pageToken, '2');
  assert.deepEqual(
    p1.body.rows.map((r) => r.f[0]?.v),
    ['r0', 'r1'],
  );

  const p2 = await getList('t_page', '?maxResults=2&pageToken=2');
  assert.deepEqual(
    p2.body.rows.map((r) => r.f[0]?.v),
    ['r2', 'r3'],
  );
  assert.equal(p2.body.pageToken, '4');

  const p3 = await getList('t_page', '?maxResults=2&pageToken=4');
  assert.equal(p3.body.rows.length, 1);
  assert.equal(p3.body.pageToken, undefined);
});

// ---------------------------------------------------------------------------
// selectedFields
// ---------------------------------------------------------------------------

test('GET /tables/{t}/data?selectedFields projects only the named columns', async () => {
  await freshTable('t_proj', [
    { name: 'id', type: 'STRING' },
    { name: 'name', type: 'STRING' },
    { name: 'score', type: 'INT64' },
  ]);
  await seedRows('t_proj', [
    { id: 'a', name: 'Alice', score: '10' },
    { id: 'b', name: 'Bob', score: '20' },
  ]);
  const { body } = await getList('t_proj', '?selectedFields=id,score');
  assert.equal(body.rows.length, 2);
  // f has 2 cells per row in column order (id, score).
  assert.equal(body.rows[0]?.f.length, 2);
  assert.deepEqual(
    body.rows.map((r) => r.f.map((c) => c.v)),
    [
      ['a', '10'],
      ['b', '20'],
    ],
  );
});

test('GET /tables/{t}/data preserves table column order even with reordered selectedFields', async () => {
  // selectedFields=score,id should still return f in (id, score) order — the
  // BQ docs are explicit that table-column order is preserved, not the param order.
  const { body } = await getList('t_proj', '?selectedFields=score,id');
  assert.deepEqual(
    body.rows.map((r) => r.f.map((c) => c.v)),
    [
      ['a', '10'],
      ['b', '20'],
    ],
  );
});

test('GET /tables/{t}/data rejects selectedFields with an unknown column', async () => {
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/t_proj/data?selectedFields=id,nope`,
  );
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
  assert.match(err.error.errors[0]?.message ?? '', /selectedFields.*"nope"/);
});

// ---------------------------------------------------------------------------
// Malformed query params
// ---------------------------------------------------------------------------

test('GET /tables/{t}/data rejects a non-positive maxResults', async () => {
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/t_small/data?maxResults=0`,
  );
  assert.equal(res.status, 400);
});

test('GET /tables/{t}/data rejects a negative pageToken', async () => {
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/t_small/data?pageToken=-1`,
  );
  assert.equal(res.status, 400);
});

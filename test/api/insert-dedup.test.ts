/**
 * insertAll insertId-based dedup (BL-032).
 *
 * Within a 60-second window, the same `insertId` to the same table is
 * silently dropped from the insert path — no `insertErrors` entry, no row
 * written. Matches real BigQuery's "1-minute dedup window" behavior.
 *
 * Per-table: same insertId in another table inserts fresh. Within a single
 * batch: dedups too (first wins).
 *
 * For TTL expiry, the dedup cache itself is unit-tested directly with a
 * mock clock; the route-level tests can't easily wait 60s and shouldn't.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { InsertIdDedup, createTabledataRoutes } from '../../src/routes/tabledata.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

interface InsertAllResponse {
  kind: string;
  insertErrors?: Array<{ index: number }>;
}

let db: Db;
let server: Server;

const PROJECT = 'dedup-tests';
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

let nextTable = 0;
async function freshTable(): Promise<string> {
  nextTable += 1;
  const id = `t${nextTable}`;
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: id },
      schema: { fields: [{ name: 'v', type: 'STRING' }] },
    }),
  });
  return id;
}

async function insertAll(
  tableId: string,
  rows: ReadonlyArray<{ insertId?: string; json: Record<string, unknown> }>,
): Promise<InsertAllResponse> {
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}/insertAll`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows }),
    },
  );
  assert.equal(res.status, 200);
  return (await res.json()) as InsertAllResponse;
}

async function countRows(tableId: string): Promise<number> {
  const rows = await db.query<{ n: bigint }>(
    `SELECT COUNT(*)::BIGINT AS n FROM "${DATASET}"."${tableId}"`,
  );
  return Number(rows[0]?.n ?? 0n);
}

// ---------------------------------------------------------------------------
// HTTP-level (real route + real DuckDB) tests
// ---------------------------------------------------------------------------

test('same insertId across two requests: second is a silent no-op', async () => {
  const t = await freshTable();
  const r1 = await insertAll(t, [{ insertId: 'id-1', json: { v: 'first' } }]);
  assert.equal(r1.insertErrors, undefined);
  assert.equal(await countRows(t), 1);
  const r2 = await insertAll(t, [{ insertId: 'id-1', json: { v: 'retry' } }]);
  // No insertErrors entry — looks successful from the client's POV.
  assert.equal(r2.insertErrors, undefined);
  // ...but no second row was written.
  assert.equal(await countRows(t), 1);
});

test('same insertId within one batch: only the first inserts', async () => {
  const t = await freshTable();
  const r = await insertAll(t, [
    { insertId: 'same', json: { v: 'a' } },
    { insertId: 'same', json: { v: 'b' } },
    { insertId: 'same', json: { v: 'c' } },
  ]);
  assert.equal(r.insertErrors, undefined);
  assert.equal(await countRows(t), 1);
  const stored = await db.query<{ v: string }>(`SELECT v FROM "${DATASET}"."${t}"`);
  assert.equal(stored[0]?.v, 'a');
});

test('different insertIds: every row inserts', async () => {
  const t = await freshTable();
  const r = await insertAll(t, [
    { insertId: 'x1', json: { v: 'one' } },
    { insertId: 'x2', json: { v: 'two' } },
    { insertId: 'x3', json: { v: 'three' } },
  ]);
  assert.equal(r.insertErrors, undefined);
  assert.equal(await countRows(t), 3);
});

test('rows without insertId always insert (no dedup state to consult)', async () => {
  const t = await freshTable();
  await insertAll(t, [{ json: { v: 'a' } }, { json: { v: 'b' } }]);
  await insertAll(t, [{ json: { v: 'a' } }, { json: { v: 'b' } }]);
  assert.equal(await countRows(t), 4);
});

test('same insertId in two different tables: both insert (dedup is per-table)', async () => {
  const tA = await freshTable();
  const tB = await freshTable();
  await insertAll(tA, [{ insertId: 'shared', json: { v: 'in-A' } }]);
  await insertAll(tB, [{ insertId: 'shared', json: { v: 'in-B' } }]);
  assert.equal(await countRows(tA), 1);
  assert.equal(await countRows(tB), 1);
});

test('dedup mark persists even when the original insert errored', async () => {
  // The unknown-column row will fail encoding (default skipInvalidRows=false
  // rolls back the batch). We still record the insertId, so the retry with
  // the same insertId is a no-op — matching real BQ, which dedups by
  // submit-time, not commit-time.
  const t = await freshTable();
  const r1 = await insertAll(t, [{ insertId: 'bad', json: { v: 'ok', extra: 'unknown-column' } }]);
  // The original failed (skipInvalidRows=false → rollback, no rows written).
  assert.equal(r1.insertErrors?.length, 1);
  assert.equal(await countRows(t), 0);
  // Retry with the same insertId — silently dropped.
  const r2 = await insertAll(t, [{ insertId: 'bad', json: { v: 'now-valid' } }]);
  assert.equal(r2.insertErrors, undefined);
  assert.equal(await countRows(t), 0);
});

test('mixed batch: deduped rows are dropped, others insert normally', async () => {
  const t = await freshTable();
  await insertAll(t, [{ insertId: 'seen', json: { v: 'first' } }]);
  assert.equal(await countRows(t), 1);
  const r = await insertAll(t, [
    { insertId: 'seen', json: { v: 'should-be-dropped' } }, // dedup
    { insertId: 'new', json: { v: 'should-stay' } }, // first time → insert
    { json: { v: 'no-id' } }, // no insertId → insert
  ]);
  assert.equal(r.insertErrors, undefined);
  assert.equal(await countRows(t), 3);
  const all = await db.query<{ v: string }>(`SELECT v FROM "${DATASET}"."${t}" ORDER BY v`);
  assert.deepEqual(
    all.map((r) => r.v),
    ['first', 'no-id', 'should-stay'],
  );
});

// ---------------------------------------------------------------------------
// Pure unit tests of the dedup cache
// ---------------------------------------------------------------------------

test('InsertIdDedup: same insertId before window expires returns true (dedup)', () => {
  const cache = new InsertIdDedup({ windowMs: 1000 });
  assert.equal(cache.seenOrRecord('t1', 'id-a', 1000), false);
  assert.equal(cache.seenOrRecord('t1', 'id-a', 1500), true);
});

test('InsertIdDedup: same insertId after window expires returns false (allowed again)', () => {
  const cache = new InsertIdDedup({ windowMs: 1000 });
  assert.equal(cache.seenOrRecord('t1', 'id-a', 1000), false);
  // After the window: expiry is windowMs in the future, so > 2000 expires.
  assert.equal(cache.seenOrRecord('t1', 'id-a', 2001), false);
});

test('InsertIdDedup: per-table — same id in another table is fresh', () => {
  const cache = new InsertIdDedup();
  assert.equal(cache.seenOrRecord('t1', 'id', 1000), false);
  assert.equal(cache.seenOrRecord('t2', 'id', 1000), false);
});

test('InsertIdDedup: bucket honors maxPerTable cap by evicting oldest', () => {
  const cache = new InsertIdDedup({ windowMs: 60_000, maxPerTable: 3 });
  cache.seenOrRecord('t1', 'a', 1000);
  cache.seenOrRecord('t1', 'b', 1000);
  cache.seenOrRecord('t1', 'c', 1000);
  // Cap reached; adding `d` evicts oldest (`a`).
  cache.seenOrRecord('t1', 'd', 1000);
  // `a` was evicted → it's not deduped on next see.
  assert.equal(cache.seenOrRecord('t1', 'a', 1000), false);
  // `d` (most recent) is still there → deduped.
  assert.equal(cache.seenOrRecord('t1', 'd', 1000), true);
});

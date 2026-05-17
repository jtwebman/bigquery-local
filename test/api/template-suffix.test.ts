/**
 * insertAll templateSuffix (BL-033) — the Kafka-style streaming-ingest
 * pattern. On first POST to `events` with `templateSuffix: "_20260517"`,
 * BigQuery auto-creates `events_20260517` from the base schema and writes
 * the rows there. Subsequent hits with the same suffix reuse it.
 *
 * Empty / absent suffix → write to base directly (no template behavior).
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createTabledataRoutes } from '../../src/routes/tabledata.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema, getTable } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

interface InsertAllResponse {
  kind: string;
  insertErrors?: Array<{ index: number }>;
}

interface GoogleErrorBody {
  error: { code: number; errors: Array<{ reason: string; message: string }>; message: string };
}

let db: Db;
let server: Server;

const PROJECT = 'template-suffix-tests';
const DATASET = 'ds';
const BASE = 'events';

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
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: BASE },
      schema: {
        fields: [
          { name: 'id', type: 'STRING' },
          { name: 'payload', type: 'STRING' },
        ],
      },
    }),
  });
});

after(async () => {
  await server.close();
  await db.close();
});

async function insertAll(
  baseTableId: string,
  body: object,
): Promise<{ status: number; json: InsertAllResponse }> {
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${baseTableId}/insertAll`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, json: (await res.json()) as InsertAllResponse };
}

async function countRows(tableId: string): Promise<number> {
  const rows = await db.query<{ n: bigint }>(
    `SELECT COUNT(*)::BIGINT AS n FROM "${PROJECT}__${DATASET}"."${tableId}"`,
  );
  return Number(rows[0]?.n ?? 0n);
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('first insertAll with templateSuffix auto-creates the target table', async () => {
  // Target doesn't exist yet.
  assert.equal(await getTable(db, PROJECT, DATASET, 'events_20260517'), null);
  const { status, json } = await insertAll(BASE, {
    templateSuffix: '_20260517',
    rows: [{ json: { id: 'a', payload: 'hello' } }, { json: { id: 'b', payload: 'world' } }],
  });
  assert.equal(status, 200);
  assert.equal(json.insertErrors, undefined);
  // Target now exists with the base schema.
  const created = await getTable(db, PROJECT, DATASET, 'events_20260517');
  assert.ok(created !== null, 'template suffix target should exist');
  assert.deepEqual(
    (created.schema as { fields: Array<{ name: string }> }).fields.map((f) => f.name),
    ['id', 'payload'],
  );
  // Rows landed in target, not in base.
  assert.equal(await countRows('events_20260517'), 2);
  assert.equal(await countRows(BASE), 0, 'base table must stay empty');
});

test('subsequent insertAlls with same templateSuffix reuse the existing target', async () => {
  // Target already exists from the previous test; we should not error and
  // not re-create it.
  const before = await getTable(db, PROJECT, DATASET, 'events_20260517');
  assert.ok(before !== null);
  const { status, json } = await insertAll(BASE, {
    templateSuffix: '_20260517',
    rows: [{ json: { id: 'c', payload: 'more' } }],
  });
  assert.equal(status, 200);
  assert.equal(json.insertErrors, undefined);
  assert.equal(await countRows('events_20260517'), 3);
  // etag of the target shouldn't have changed (no re-upsert of meta).
  const after = await getTable(db, PROJECT, DATASET, 'events_20260517');
  assert.equal(after?.etag, before?.etag);
});

test('different suffixes create different targets from the same base', async () => {
  await insertAll(BASE, {
    templateSuffix: '_20260518',
    rows: [{ json: { id: 'x', payload: 'day-2' } }],
  });
  await insertAll(BASE, {
    templateSuffix: '_20260519',
    rows: [{ json: { id: 'y', payload: 'day-3' } }],
  });
  assert.equal(await countRows('events_20260518'), 1);
  assert.equal(await countRows('events_20260519'), 1);
  // Each target gets the base schema independently.
  const t18 = await getTable(db, PROJECT, DATASET, 'events_20260518');
  const t19 = await getTable(db, PROJECT, DATASET, 'events_20260519');
  assert.ok(t18 !== null && t19 !== null);
});

test('templateSuffix without an underscore concatenates verbatim (client picks the separator)', async () => {
  await insertAll(BASE, {
    templateSuffix: 'NoUnderscore',
    rows: [{ json: { id: 'q', payload: 'unsep' } }],
  });
  // Target is `eventsNoUnderscore`, not `events_NoUnderscore`.
  assert.equal(await countRows('eventsNoUnderscore'), 1);
});

// ---------------------------------------------------------------------------
// No templateSuffix (regression — base path unchanged)
// ---------------------------------------------------------------------------

test('no templateSuffix → writes to base table as before', async () => {
  const baseRowsBefore = await countRows(BASE);
  await insertAll(BASE, { rows: [{ json: { id: 'base-1', payload: 'plain' } }] });
  assert.equal(await countRows(BASE), baseRowsBefore + 1);
});

test('empty-string templateSuffix is treated as absent (writes to base)', async () => {
  const baseRowsBefore = await countRows(BASE);
  await insertAll(BASE, {
    templateSuffix: '',
    rows: [{ json: { id: 'base-2', payload: 'empty-suffix' } }],
  });
  assert.equal(await countRows(BASE), baseRowsBefore + 1);
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test('templateSuffix against an unknown base table → 404', async () => {
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/no_such_base/insertAll`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateSuffix: '_20260517',
        rows: [{ json: { id: 'a' } }],
      }),
    },
  );
  assert.equal(res.status, 404);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'notFound');
});

test('non-string templateSuffix is rejected with 400', async () => {
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${BASE}/insertAll`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateSuffix: 12345, rows: [] }),
    },
  );
  assert.equal(res.status, 400);
});

test('rows that fail row-level schema validation still surface as insertErrors', async () => {
  // The template target inherits the base schema. Unknown fields fail the
  // same way they would on the base table.
  const { status, json } = await insertAll(BASE, {
    templateSuffix: '_with_errors',
    rows: [
      { json: { id: 'ok', payload: 'good' } },
      { json: { id: 'bad', payload: 'good', extra: 'unknown' } },
    ],
    skipInvalidRows: true,
  });
  assert.equal(status, 200);
  assert.equal(json.insertErrors?.length, 1);
  assert.equal(json.insertErrors?.[0]?.index, 1);
  // The target exists either way (the create-target step happens before encoding).
  const target = await getTable(db, PROJECT, DATASET, 'events_with_errors');
  assert.ok(target !== null);
});

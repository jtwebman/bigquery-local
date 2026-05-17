/**
 * BL-060 — Wildcard tables + `_TABLE_SUFFIX`.
 *
 *   FROM `dataset.events_*`
 *
 * resolves to a UNION ALL of every table in the dataset whose id starts
 * with `events_`. Each branch also emits the suffix as a `_TABLE_SUFFIX`
 * pseudo-column so the canonical idiom
 *
 *   WHERE _TABLE_SUFFIX BETWEEN '20240101' AND '20240131'
 *
 * filters at the union-branch level.
 *
 * Resolution happens before SQL translation, by walking the BQ tokens for
 * trailing-`*` backticks and splicing the union subquery back into the
 * source string. The result is still BQ SQL (backticks intact), so the
 * normal translator handles the dataset.table refs afterward.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createQueriesRoutes } from '../../src/routes/queries.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

let db: Db;
let server: Server;
const PROJECT = 'sql-wildcard';
const DATASET = 'ds';

const SUFFIXES = ['20240101', '20240102', '20240103'];

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [...createDatasetRoutes(db), ...createTableRoutes(db), ...createQueriesRoutes(db)],
  });
  await server.listen(0);
  await fetch(`${server.url}/projects/${PROJECT}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: DATASET } }),
  });
  // Three event tables with identical schema; one row each marked by suffix.
  for (const suffix of SUFFIXES) {
    const tableId = `events_${suffix}`;
    await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tableReference: { tableId },
        schema: {
          fields: [
            { name: 'id', type: 'INT64' },
            { name: 'label', type: 'STRING' },
          ],
        },
      }),
    });
    await postQuery(
      `INSERT INTO \`${DATASET}.${tableId}\` VALUES (1, 'a-${suffix}'), (2, 'b-${suffix}')`,
    );
  }
  // One unrelated table that should NOT match the wildcard.
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'sessions' },
      schema: { fields: [{ name: 'id', type: 'INT64' }] },
    }),
  });
});
after(async () => {
  await server.close();
  await db.close();
});

interface QueryResponse {
  rows?: Array<{ f: Array<{ v: string | null }> }>;
}

async function postQuery(query: string): Promise<QueryResponse> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return (await res.json()) as QueryResponse;
}

async function selectRows(query: string): Promise<Array<Array<string | null>>> {
  return ((await postQuery(query)).rows ?? []).map((row) => row.f.map((f) => f.v));
}

// ---------------------------------------------------------------------------
// `_TABLE_SUFFIX` exposes the suffix per branch; UNION ALL covers every match
// ---------------------------------------------------------------------------

test('SELECT _TABLE_SUFFIX FROM `ds.events_*` returns one entry per (suffix × row)', async () => {
  const rows = await selectRows(
    `SELECT _TABLE_SUFFIX, id, label
     FROM \`${DATASET}.events_*\`
     ORDER BY _TABLE_SUFFIX, id`,
  );
  assert.deepEqual(rows, [
    ['20240101', '1', 'a-20240101'],
    ['20240101', '2', 'b-20240101'],
    ['20240102', '1', 'a-20240102'],
    ['20240102', '2', 'b-20240102'],
    ['20240103', '1', 'a-20240103'],
    ['20240103', '2', 'b-20240103'],
  ]);
});

// ---------------------------------------------------------------------------
// WHERE _TABLE_SUFFIX BETWEEN narrows the scan
// ---------------------------------------------------------------------------

test('WHERE _TABLE_SUFFIX BETWEEN limits to the matching union branches', async () => {
  const rows = await selectRows(
    `SELECT _TABLE_SUFFIX, COUNT(*) AS n
     FROM \`${DATASET}.events_*\`
     WHERE _TABLE_SUFFIX BETWEEN '20240101' AND '20240102'
     GROUP BY _TABLE_SUFFIX
     ORDER BY _TABLE_SUFFIX`,
  );
  assert.deepEqual(rows, [
    ['20240101', '2'],
    ['20240102', '2'],
  ]);
});

// ---------------------------------------------------------------------------
// Wildcard does NOT match the unrelated 'sessions' table
// ---------------------------------------------------------------------------

test('wildcard only matches tables whose id starts with the prefix', async () => {
  const rows = await selectRows(
    `SELECT DISTINCT _TABLE_SUFFIX FROM \`${DATASET}.events_*\` ORDER BY _TABLE_SUFFIX`,
  );
  assert.deepEqual(rows, [['20240101'], ['20240102'], ['20240103']]);
});

// ---------------------------------------------------------------------------
// No matching tables → notFound
// ---------------------------------------------------------------------------

test('wildcard with no matches returns 404 notFound', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `SELECT * FROM \`${DATASET}.nothing_*\`` }),
  });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// project.dataset.prefix_* explicit-project form
// ---------------------------------------------------------------------------

test('explicit `project.dataset.prefix_*` form resolves the same way', async () => {
  const rows = await selectRows(`SELECT COUNT(*) AS n FROM \`${PROJECT}.${DATASET}.events_*\``);
  assert.equal(rows[0]?.[0], '6');
});

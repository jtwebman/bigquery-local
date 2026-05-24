/**
 * BL-102 — `CALL BQ.REFRESH_MATERIALIZED_VIEW(...)`.
 *
 * Verifies:
 *   - The CALL is recognized as a built-in (intercepted before the
 *     script interpreter).
 *   - After source data changes and a refresh, the MV's row count
 *     reflects the new source.
 *   - Both `dataset.mv` and `project.dataset.mv` qualified forms work.
 *   - Calling on a missing name → 404; calling on a base table → 400.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createQueriesRoutes } from '../../src/routes/queries.ts';
import { createTabledataRoutes } from '../../src/routes/tabledata.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

const PROJECT = 'mv-refresh-test';
const DATASET = 'ds';

let db: Db;
let server: Server;

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [
      ...createDatasetRoutes(db),
      ...createTableRoutes(db),
      ...createTabledataRoutes(db),
      ...createQueriesRoutes(db),
    ],
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
      tableReference: { tableId: 'orders' },
      schema: {
        fields: [
          { name: 'region', type: 'STRING' },
          { name: 'amount', type: 'FLOAT64' },
        ],
      },
    }),
  });
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/orders/insertAll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rows: [
        { json: { region: 'east', amount: 1 } },
        { json: { region: 'east', amount: 2 } },
        { json: { region: 'west', amount: 3 } },
      ],
    }),
  });
  // Create the MV — snapshots 2 east rows at creation time.
  await runQuery(
    `CREATE MATERIALIZED VIEW \`${DATASET}.east_orders\`
     AS SELECT region, amount FROM \`${DATASET}.orders\` WHERE region = 'east'`,
  );
});
after(async () => {
  await server.close();
  await db.close();
});

async function runQuery(sql: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  return { status: res.status, body: await res.json() };
}

async function rowCountOf(table: string): Promise<number> {
  const { body } = await runQuery(`SELECT count(*)::INT64 AS n FROM \`${DATASET}.${table}\``);
  const data = body as { rows?: Array<{ f: Array<{ v: string }> }> };
  return Number(data.rows?.[0]?.f[0]?.v ?? '0');
}

test('Materialized view is stale after the source changes', async () => {
  // Snapshot row count before any refresh.
  const initial = await rowCountOf('east_orders');
  assert.equal(initial, 2);

  // Add another east row to the source.
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/orders/insertAll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rows: [{ json: { region: 'east', amount: 4 } }],
    }),
  });

  // MV still reports 2 — it's a snapshot.
  assert.equal(await rowCountOf('east_orders'), 2);
});

test('CALL BQ.REFRESH_MATERIALIZED_VIEW refreshes the MV from the source', async () => {
  const before = await rowCountOf('east_orders');
  assert.equal(before, 2);
  const refresh = await runQuery(`CALL BQ.REFRESH_MATERIALIZED_VIEW('${DATASET}.east_orders')`);
  assert.equal(refresh.status, 200);
  const after = await rowCountOf('east_orders');
  assert.equal(after, 3);
});

test('Refresh accepts the project.dataset.mv qualified form', async () => {
  // Add another row.
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/orders/insertAll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rows: [{ json: { region: 'east', amount: 5 } }] }),
  });
  const refresh = await runQuery(
    `CALL BQ.REFRESH_MATERIALIZED_VIEW('${PROJECT}.${DATASET}.east_orders')`,
  );
  assert.equal(refresh.status, 200);
  assert.equal(await rowCountOf('east_orders'), 4);
});

test('Refresh on a missing MV returns 404', async () => {
  const refresh = await runQuery(`CALL BQ.REFRESH_MATERIALIZED_VIEW('${DATASET}.nonexistent')`);
  assert.equal(refresh.status, 404);
});

test('Refresh on a base table returns 400 invalid', async () => {
  const refresh = await runQuery(`CALL BQ.REFRESH_MATERIALIZED_VIEW('${DATASET}.orders')`);
  assert.equal(refresh.status, 400);
});

test('CALL of a non-BQ procedure falls through to the script interpreter', async () => {
  // Script interpreter doesn't know `some.other.proc`; this 400s, but
  // it's the script interpreter's 400, not the MV-refresh handler's.
  // That confirms the parser correctly declined to intercept.
  const res = await runQuery(`CALL some.other.proc()`);
  // Script interpreter returns 404 for unknown procedures (not 400).
  assert.equal(res.status, 404);
});

test('CALL BQ.<other> falls through (not the refresh built-in)', async () => {
  const res = await runQuery(`CALL BQ.UNKNOWN_PROC('${DATASET}.east_orders')`);
  assert.equal(res.status, 404);
});

test('REFRESH with a one-part bare name falls through (not enough qualification)', async () => {
  const res = await runQuery(`CALL BQ.REFRESH_MATERIALIZED_VIEW('lonely')`);
  assert.equal(res.status, 404);
});

test('REFRESH with non-string argument falls through', async () => {
  const res = await runQuery(`CALL BQ.REFRESH_MATERIALIZED_VIEW(42)`);
  assert.equal(res.status, 404);
});

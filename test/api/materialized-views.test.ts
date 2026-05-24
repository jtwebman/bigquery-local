/**
 * BL-101 — CREATE MATERIALIZED VIEW + DROP MATERIALIZED VIEW.
 *
 * Verifies:
 *   - CREATE MATERIALIZED VIEW materializes rows at creation time;
 *     row count matches the source query.
 *   - The MV shows up in `INFORMATION_SCHEMA.MATERIALIZED_VIEWS`
 *     (wired in BL-076).
 *   - It does NOT show up in `INFORMATION_SCHEMA.VIEWS` (logical only).
 *   - It DOES show up in `INFORMATION_SCHEMA.TABLES` with
 *     `table_type='MATERIALIZED VIEW'`.
 *   - Duplicate creation 409s.
 *   - DROP MATERIALIZED VIEW removes the MV and frees the name.
 *   - DROP on a non-MV (e.g. a base table) errors.
 *
 * MV refresh (BL-102) lands separately — for now the MV is a snapshot
 * fixed at CREATE time.
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

const PROJECT = 'mv-test';
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
        { json: { region: 'east', amount: 9.99 } },
        { json: { region: 'east', amount: 12.5 } },
        { json: { region: 'west', amount: 5.0 } },
      ],
    }),
  });
});
after(async () => {
  await server.close();
  await db.close();
});

interface QueryResponse {
  status?: number;
  rows?: Array<{ f: Array<{ v: string | null }> }>;
}

async function runQuery(sql: string): Promise<{ status: number; body: QueryResponse }> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  return { status: res.status, body: (await res.json()) as QueryResponse };
}

async function rows(sql: string): Promise<Array<Array<string | null>>> {
  const { body } = await runQuery(sql);
  return (body.rows ?? []).map((row) => row.f.map((f) => f.v));
}

test('CREATE MATERIALIZED VIEW materializes rows from the source query', async () => {
  const { status } = await runQuery(
    `CREATE MATERIALIZED VIEW \`${DATASET}.east_orders\`
     AS SELECT region, amount FROM \`${DATASET}.orders\` WHERE region = 'east'`,
  );
  assert.equal(status, 200);

  // SELECT against the MV returns the materialized rows.
  const result = await rows(
    `SELECT region, amount FROM \`${DATASET}.east_orders\` ORDER BY amount`,
  );
  assert.deepEqual(result, [
    ['east', '9.99'],
    ['east', '12.5'],
  ]);
});

test('MV shows up in INFORMATION_SCHEMA.MATERIALIZED_VIEWS', async () => {
  const result = await rows(
    `SELECT table_name FROM \`region-us\`.INFORMATION_SCHEMA.MATERIALIZED_VIEWS`,
  );
  assert.deepEqual(result, [['east_orders']]);
});

test('MV does NOT show up in INFORMATION_SCHEMA.VIEWS', async () => {
  const result = await rows(`SELECT table_name FROM \`region-us\`.INFORMATION_SCHEMA.VIEWS`);
  assert.deepEqual(result, []);
});

test("MV appears in INFORMATION_SCHEMA.TABLES with table_type='MATERIALIZED VIEW'", async () => {
  const result = await rows(
    `SELECT table_name, table_type FROM \`region-us\`.INFORMATION_SCHEMA.TABLES
     WHERE table_name = 'east_orders'`,
  );
  assert.deepEqual(result, [['east_orders', 'MATERIALIZED VIEW']]);
});

test('CREATE MATERIALIZED VIEW on an existing name returns 409', async () => {
  const { status } = await runQuery(
    `CREATE MATERIALIZED VIEW \`${DATASET}.east_orders\`
     AS SELECT region FROM \`${DATASET}.orders\``,
  );
  assert.equal(status, 409);
});

test('DROP MATERIALIZED VIEW removes the MV and frees the name', async () => {
  const drop = await runQuery(`DROP MATERIALIZED VIEW \`${DATASET}.east_orders\``);
  assert.equal(drop.status, 200);
  // Re-creating with the same name should now succeed.
  const recreate = await runQuery(
    `CREATE MATERIALIZED VIEW \`${DATASET}.east_orders\`
     AS SELECT region FROM \`${DATASET}.orders\``,
  );
  assert.equal(recreate.status, 200);
});

test('DROP MATERIALIZED VIEW on a missing name returns 404', async () => {
  const drop = await runQuery(`DROP MATERIALIZED VIEW \`${DATASET}.nonexistent\``);
  assert.equal(drop.status, 404);
});

test('DROP MATERIALIZED VIEW on a base table returns 400 invalid', async () => {
  const drop = await runQuery(`DROP MATERIALIZED VIEW \`${DATASET}.orders\``);
  assert.equal(drop.status, 400);
});

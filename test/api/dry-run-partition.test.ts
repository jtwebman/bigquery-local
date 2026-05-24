/**
 * BL-099 — Partition pruning in the dry-run totalBytesProcessed estimate.
 *
 * The dry-run estimator returns
 *   `(output rows) × (estimated bytes/row from schema)`
 * so any WHERE that narrows the count — including `_PARTITIONTIME`
 * and partition-column filters — naturally produces a smaller estimate
 * than the same query without the filter. That's what the acceptance
 * test exercises end-to-end.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createJobsRoutes } from '../../src/routes/jobs.ts';
import { createQueriesRoutes } from '../../src/routes/queries.ts';
import { createTabledataRoutes } from '../../src/routes/tabledata.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

const PROJECT = 'dryrun-test';
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
      ...createJobsRoutes(db),
    ],
  });
  await server.listen(0);
  await fetch(`${server.url}/projects/${PROJECT}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: DATASET } }),
  });
  // Column-partitioned table with a known number of rows per partition.
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'orders' },
      schema: {
        fields: [
          { name: 'id', type: 'INT64' },
          { name: 'order_date', type: 'DATE' },
          { name: 'customer', type: 'STRING' },
        ],
      },
      timePartitioning: { type: 'DAY', field: 'order_date' },
    }),
  });
  const rows: Array<{ json: { id: number; order_date: string; customer: string } }> = [];
  // 30 rows on 2026-05-20, 5 rows on 2026-05-21 — so the partition
  // filter should drop the estimate by ~6x.
  for (let i = 0; i < 30; i += 1) {
    rows.push({ json: { id: i, order_date: '2026-05-20', customer: `c${i}` } });
  }
  for (let i = 30; i < 35; i += 1) {
    rows.push({ json: { id: i, order_date: '2026-05-21', customer: `c${i}` } });
  }
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/orders/insertAll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
});
after(async () => {
  await server.close();
  await db.close();
});

interface JobResponse {
  statistics?: { totalBytesProcessed?: string };
}

async function dryRunBytes(query: string): Promise<number> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ configuration: { query: { query }, dryRun: true } }),
  });
  const body = (await res.json()) as JobResponse;
  return Number(body.statistics?.totalBytesProcessed ?? '0');
}

test('A full SELECT * dry-run reports a positive bytes estimate', async () => {
  const bytes = await dryRunBytes(`SELECT * FROM \`${DATASET}.orders\``);
  assert.ok(bytes > 0, `expected > 0 bytes, got ${bytes}`);
});

test('Partition-column filter cuts the estimate vs. the un-filtered query', async () => {
  const all = await dryRunBytes(`SELECT * FROM \`${DATASET}.orders\``);
  const filtered = await dryRunBytes(
    `SELECT * FROM \`${DATASET}.orders\` WHERE order_date = DATE '2026-05-21'`,
  );
  assert.ok(filtered > 0, `filtered > 0, got ${filtered}`);
  assert.ok(filtered < all, `partition filter should cut bytes: filtered=${filtered}, all=${all}`);
  // The filter narrows from 35 rows to 5 — estimate ratio should be ~5/35.
  // Allow generous tolerance since the per-row estimate is a constant.
  assert.ok(filtered * 5 <= all, `expected ≥5x cut, got filtered=${filtered}, all=${all}`);
});

test('DML dry-run reports 0 bytes (no scan)', async () => {
  const bytes = await dryRunBytes(`DELETE FROM \`${DATASET}.orders\` WHERE id = 999`);
  assert.equal(bytes, 0);
});

test('_PARTITIONTIME filter on an ingestion-partitioned table also cuts the estimate', async () => {
  // Create an ingestion-partitioned table.
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'events' },
      schema: { fields: [{ name: 'kind', type: 'STRING' }] },
      timePartitioning: { type: 'DAY' },
    }),
  });
  const rows = Array.from({ length: 20 }, (_, i) => ({ json: { kind: `k${i}` } }));
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/events/insertAll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
  // All rows fall in today's partition, so a 1999 filter should produce 0 bytes.
  const all = await dryRunBytes(`SELECT * FROM \`${DATASET}.events\``);
  const past = await dryRunBytes(
    `SELECT * FROM \`${DATASET}.events\` WHERE _PARTITIONDATE = DATE '1999-01-01'`,
  );
  assert.ok(all > 0);
  assert.equal(past, 0);
});

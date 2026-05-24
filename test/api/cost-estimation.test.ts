/**
 * BL-152 — Cost estimation on the execute path.
 *
 * jobMetaToResource reports totalBytesProcessed and totalSlotMs based
 * on stored job metadata (resultTotalRows, resultSchema, startedMs,
 * endedMs). The math mirrors the dry-run estimator (BL-099) so a
 * dry-run followed by an execute reports comparable numbers.
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

const PROJECT = 'cost-test';
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
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'orders' },
      schema: {
        fields: [
          { name: 'id', type: 'INT64' },
          { name: 'customer', type: 'STRING' },
        ],
      },
    }),
  });
  const rows = Array.from({ length: 25 }, (_, i) => ({
    json: { id: i, customer: `c${i}` },
  }));
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

interface JobBody {
  status: { state: string };
  statistics?: {
    totalBytesProcessed?: string;
    query?: { totalSlotMs?: string };
  };
}

async function postJob(query: string): Promise<{ status: number; body: JobBody }> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ configuration: { query: { query } } }),
  });
  return { status: res.status, body: (await res.json()) as JobBody };
}

async function dryRunBytes(query: string): Promise<number> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ configuration: { query: { query }, dryRun: true } }),
  });
  const body = (await res.json()) as JobBody;
  return Number(body.statistics?.totalBytesProcessed ?? '0');
}

test('totalBytesProcessed > 0 for a non-empty SELECT', async () => {
  const { body } = await postJob(`SELECT * FROM \`${DATASET}.orders\``);
  assert.equal(body.status.state, 'DONE');
  assert.ok(
    Number(body.statistics?.totalBytesProcessed) > 0,
    `expected > 0, got ${body.statistics?.totalBytesProcessed}`,
  );
});

test('Dry-run and execute report comparable totalBytesProcessed', async () => {
  const sql = `SELECT * FROM \`${DATASET}.orders\``;
  const dry = await dryRunBytes(sql);
  const { body } = await postJob(sql);
  const exec = Number(body.statistics?.totalBytesProcessed ?? '0');
  // Identical schemas + identical row counts → identical estimates.
  assert.equal(exec, dry);
});

test('Partition / WHERE filter reduces totalBytesProcessed on execute', async () => {
  // 25 rows total, ~2 customers match.
  const all = await postJob(`SELECT * FROM \`${DATASET}.orders\``);
  const filtered = await postJob(
    `SELECT * FROM \`${DATASET}.orders\` WHERE customer IN ('c1', 'c2')`,
  );
  const allBytes = Number(all.body.statistics?.totalBytesProcessed);
  const filteredBytes = Number(filtered.body.statistics?.totalBytesProcessed);
  assert.ok(filteredBytes < allBytes);
});

test('totalSlotMs is non-negative for a completed job', async () => {
  const { body } = await postJob(`SELECT * FROM \`${DATASET}.orders\``);
  const slotMs = Number(body.statistics?.query?.totalSlotMs ?? '0');
  assert.ok(slotMs >= 0, `expected >= 0, got ${slotMs}`);
});

test('DML returns 0 bytes (no result schema)', async () => {
  const { body } = await postJob(`DELETE FROM \`${DATASET}.orders\` WHERE id = 999`);
  assert.equal(body.statistics?.totalBytesProcessed, '0');
});

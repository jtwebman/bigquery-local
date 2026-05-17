/**
 * BL-059 — TABLESAMPLE SYSTEM (n PERCENT).
 *
 * BQ's `TABLESAMPLE SYSTEM (n PERCENT)` and DuckDB's match in syntax but
 * not in resolution — DuckDB's SYSTEM is per-storage-block, which for
 * small in-memory tables rounds to all-or-nothing. BERNOULLI is row-level
 * uniform sampling and produces the ~N% result users expect.
 *
 * The translator rewrites `TABLESAMPLE SYSTEM` → `TABLESAMPLE BERNOULLI`;
 * `TABLESAMPLE BERNOULLI` is passed through unchanged.
 *
 * Acceptance: sample size within ±20% of expected on a 10k-row table.
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
const PROJECT = 'sql-tablesample';
const DATASET = 'ds';

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
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 't' },
      schema: { fields: [{ name: 'id', type: 'INT64' }] },
    }),
  });
  // 10,000 rows so a 10% sample (~1000 rows) is statistically stable.
  // We bulk-insert via DuckDB directly to keep the test fast.
  await db.exec(`INSERT INTO "${PROJECT}__${DATASET}"."t" SELECT i FROM range(10000) AS r(i)`);
});
after(async () => {
  await server.close();
  await db.close();
});

interface QueryResponse {
  rows?: Array<{ f: Array<{ v: string }> }>;
}

async function postQuery(query: string): Promise<QueryResponse> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return (await res.json()) as QueryResponse;
}

async function sampledCount(query: string): Promise<number> {
  const r = await postQuery(query);
  return Number((r.rows ?? [])[0]?.f[0]?.v ?? 0);
}

// ---------------------------------------------------------------------------
// SYSTEM sample → translated to BERNOULLI, row-uniform
// ---------------------------------------------------------------------------

test('TABLESAMPLE SYSTEM (10 PERCENT) on 10k rows lands within ±20% of 1000', async () => {
  const n = await sampledCount(
    `SELECT COUNT(*) AS n FROM \`${DATASET}.t\` TABLESAMPLE SYSTEM (10 PERCENT)`,
  );
  assert.ok(n >= 800 && n <= 1200, `Expected 800..1200, got ${n}`);
});

test('TABLESAMPLE SYSTEM (50 PERCENT) on 10k rows lands within ±20% of 5000', async () => {
  const n = await sampledCount(
    `SELECT COUNT(*) AS n FROM \`${DATASET}.t\` TABLESAMPLE SYSTEM (50 PERCENT)`,
  );
  assert.ok(n >= 4000 && n <= 6000, `Expected 4000..6000, got ${n}`);
});

// ---------------------------------------------------------------------------
// BERNOULLI sample → passed through unchanged
// ---------------------------------------------------------------------------

test('TABLESAMPLE BERNOULLI (10 PERCENT) lands within ±20% of 1000', async () => {
  const n = await sampledCount(
    `SELECT COUNT(*) AS n FROM \`${DATASET}.t\` TABLESAMPLE BERNOULLI (10 PERCENT)`,
  );
  assert.ok(n >= 800 && n <= 1200, `Expected 800..1200, got ${n}`);
});

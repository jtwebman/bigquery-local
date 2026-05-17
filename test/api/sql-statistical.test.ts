/**
 * BL-046 — BQ statistical aggregates: CORR, COVAR_POP, COVAR_SAMP,
 * STDDEV_POP, STDDEV_SAMP, VAR_POP, VAR_SAMP. All pass through to DuckDB.
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
const PROJECT = 'sql-stats';

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [...createDatasetRoutes(db), ...createTableRoutes(db), ...createQueriesRoutes(db)],
  });
  await server.listen(0);
});
after(async () => {
  await server.close();
  await db.close();
});

async function scalar(query: string): Promise<unknown> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { rows: Array<{ f: Array<{ v: unknown }> }> };
  return body.rows[0]?.f[0]?.v;
}

const TOL = 1e-9;
function nearly(actual: unknown, expected: number): void {
  const got = Number(actual);
  assert.ok(Math.abs(got - expected) < TOL, `got ${got}, expected ~${expected}`);
}

// Pairs (1,2), (2,4), (3,6), (4,8) — perfectly linear, y = 2x.
const PAIRS = `(VALUES (1.0, 2.0), (2.0, 4.0), (3.0, 6.0), (4.0, 8.0)) AS t(x, y)`;
const XS = `(VALUES (1.0), (2.0), (3.0), (4.0)) AS t(x)`;

test('CORR computes Pearson correlation', async () => {
  nearly(await scalar(`SELECT CORR(x, y) AS r FROM ${PAIRS}`), 1);
});

test('COVAR_POP computes population covariance', async () => {
  nearly(await scalar(`SELECT COVAR_POP(x, y) AS r FROM ${PAIRS}`), 2.5);
});

test('COVAR_SAMP computes sample covariance', async () => {
  nearly(await scalar(`SELECT COVAR_SAMP(x, y) AS r FROM ${PAIRS}`), 10 / 3);
});

test('STDDEV_POP computes population standard deviation', async () => {
  nearly(await scalar(`SELECT STDDEV_POP(x) AS r FROM ${XS}`), Math.sqrt(1.25));
});

test('STDDEV_SAMP computes sample standard deviation', async () => {
  nearly(await scalar(`SELECT STDDEV_SAMP(x) AS r FROM ${XS}`), Math.sqrt(5 / 3));
});

test('VAR_POP computes population variance', async () => {
  nearly(await scalar(`SELECT VAR_POP(x) AS r FROM ${XS}`), 1.25);
});

test('VAR_SAMP computes sample variance', async () => {
  nearly(await scalar(`SELECT VAR_SAMP(x) AS r FROM ${XS}`), 5 / 3);
});

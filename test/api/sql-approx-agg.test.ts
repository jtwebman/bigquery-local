/**
 * BL-045 — BQ approximate aggregation.
 *
 * V0 ships APPROX_COUNT_DISTINCT only (DuckDB has it under the same name).
 * APPROX_QUANTILES / APPROX_TOP_COUNT have signature mismatches with their
 * DuckDB counterparts (return shapes differ in ways that don't round-trip
 * via a simple rename); HLL_COUNT.* / KLL_QUANTILES.* are BQ-specific sketch
 * types. Those stay in UNSUPPORTED_FUNCTIONS so callers get a clean error.
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
const PROJECT = 'sql-approx';

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

async function postQuery(query: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { status: res.status, json: await res.json() };
}

async function scalar(query: string): Promise<unknown> {
  const { json } = await postQuery(query);
  const body = json as { rows: Array<{ f: Array<{ v: unknown }> }> };
  return body.rows[0]?.f[0]?.v;
}

test('APPROX_COUNT_DISTINCT returns a finite estimate near the true count', async () => {
  // 1000 distinct integer values via generate_series. Tolerance is
  // generous — at this scale DuckDB's HLL variance is high (~20%);
  // BL-045's acceptance is about "does it run + give a sensible number,"
  // not statistical precision.
  const v = await scalar(
    'SELECT APPROX_COUNT_DISTINCT(generate_series) AS r FROM generate_series(1, 1000)',
  );
  const got = Number(v);
  assert.ok(got > 0 && got < 10000, `APPROX_COUNT_DISTINCT implausible: ${got}`);
  // Sanity: a finite estimate that's the same order of magnitude as 1000.
  assert.ok(got >= 500 && got <= 2000, `APPROX_COUNT_DISTINCT too far off: ${got}`);
});

test('APPROX_QUANTILES is rejected as unsupported in v0', async () => {
  const { status, json } = await postQuery(
    'SELECT APPROX_QUANTILES(unnest, 4) FROM UNNEST([1,2,3])',
  );
  assert.equal(status, 400);
  const err = json as { error: { errors: Array<{ reason: string }> } };
  assert.equal(err.error.errors[0]?.reason, 'unsupportedFeature');
});

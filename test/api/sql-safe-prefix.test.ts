/**
 * BL-051 — BQ's `SAFE.<FN>(...)` prefix. Wraps any scalar function so
 * errors return NULL instead of failing the query. We emit
 * `try(<FN>(args))`, which DuckDB supports natively.
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
import { unwrapV } from '../helpers/wire.ts';

let db: Db;
let server: Server;
const PROJECT = 'sql-safe';

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
  return unwrapV(body.rows[0]?.f[0]?.v);
}

test('SAFE.DIVIDE(1, 0) IS NULL — the canonical SAFE-prefix acceptance', async () => {
  // Wrap a divide-by-zero call. With explicit INT casts, DuckDB throws
  // on integer divide-by-zero; `try(...)` catches that and returns NULL.
  const v = await scalar('SELECT SAFE.DIVIDE(CAST(1 AS INTEGER), CAST(0 AS INTEGER)) IS NULL AS x');
  assert.equal(v, 'true');
});

test('SAFE.CAST does not throw on bad input — returns NULL', async () => {
  assert.equal(await scalar("SELECT SAFE.CAST('not-a-number' AS INTEGER) AS x"), null);
});

test('SAFE.<FN> with a valid arg behaves like the bare function', async () => {
  // SAFE wrapping is transparent on success. DuckDB's divide on integers
  // returns INT (truncated), wired as decimal string.
  assert.equal(await scalar('SELECT SAFE.DIVIDE(10, 5) AS x'), '2');
});

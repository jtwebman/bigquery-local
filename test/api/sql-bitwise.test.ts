/**
 * BL-048 — BQ bitwise operators and BIT_COUNT.
 *
 * `<<`, `>>`, `&`, `|`, `~`, and BIT_COUNT all pass through. The `^`
 * operator is NOT yet supported: in BQ it's XOR, in DuckDB it's
 * exponentiation. Rewriting at the operator level is out of scope here;
 * use `xor(a, b)` directly if you need bitwise XOR.
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
const PROJECT = 'sql-bitwise';

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

test('BIT_COUNT counts set bits', async () => {
  assert.equal(await scalar('SELECT BIT_COUNT(5) AS x'), '2');
});
test('Left shift << shifts low-order bits', async () => {
  assert.equal(await scalar('SELECT 1 << 3 AS x'), '8');
});
test('Right shift >> shifts high-order bits', async () => {
  assert.equal(await scalar('SELECT 16 >> 2 AS x'), '4');
});
test('Bitwise AND', async () => {
  assert.equal(await scalar('SELECT 12 & 10 AS x'), '8');
});
test('Bitwise OR', async () => {
  assert.equal(await scalar('SELECT 12 | 10 AS x'), '14');
});
test('Bitwise NOT (~) inverts the bits', async () => {
  assert.equal(await scalar('SELECT ~5 AS x'), '-6');
});

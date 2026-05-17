/**
 * BL-050 — BQ Net library: NET.IP_FROM_STRING, NET.IP_TO_STRING,
 * NET.IPV4_FROM_INT64, NET.IPV4_TO_INT64, NET.HOST, NET.PUBLIC_SUFFIX,
 * NET.REG_DOMAIN.
 *
 * DuckDB has no native equivalents and implementing these (especially
 * URL parsing with public-suffix-list lookups) is significant work. For
 * v0 they're surfaced as a clean unsupportedFeature with the specific
 * function name in the error, so clients see a precise rejection rather
 * than DuckDB's generic "function does not exist".
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
const PROJECT = 'sql-net';

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

const NET_FNS = [
  'IP_FROM_STRING',
  'IP_TO_STRING',
  'IPV4_FROM_INT64',
  'IPV4_TO_INT64',
  'HOST',
  'PUBLIC_SUFFIX',
  'REG_DOMAIN',
];

for (const fn of NET_FNS) {
  test(`NET.${fn} is rejected with a precise unsupportedFeature error`, async () => {
    const { status, json } = await postQuery(`SELECT NET.${fn}('x')`);
    assert.equal(status, 400);
    const err = json as { error: { errors: Array<{ reason: string; message: string }> } };
    assert.equal(err.error.errors[0]?.reason, 'unsupportedFeature');
    assert.match(err.error.errors[0]?.message ?? '', new RegExp(`NET\\.${fn}`));
  });
}

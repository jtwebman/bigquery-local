/**
 * BL-047 — BQ hash & fingerprint functions.
 *
 * MD5 / SHA1 / SHA256 pass through to DuckDB (note: DuckDB returns hex
 * strings; BQ returns BYTES that would normally be TO_HEX'd to display).
 * SHA512 and FARM_FINGERPRINT stay in UNSUPPORTED_FUNCTIONS (DuckDB lacks
 * SHA512; FARM_FINGERPRINT specifically requires FarmHash, which DuckDB's
 * generic hash() doesn't match).
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
const PROJECT = 'sql-hash';

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
  return (json as { rows: Array<{ f: Array<{ v: unknown }> }> }).rows[0]?.f[0]?.v;
}

// BQ hash functions return BYTES (raw digest), so the hex vector comes
// out via TO_HEX. `MD5('abc')` alone is the base64 of those bytes.
test("MD5('abc') matches the known vector", async () => {
  assert.equal(await scalar("SELECT TO_HEX(MD5('abc')) AS x"), '900150983cd24fb0d6963f7d28e17f72');
});

test("SHA1('abc') matches the known vector", async () => {
  assert.equal(
    await scalar("SELECT TO_HEX(SHA1('abc')) AS x"),
    'a9993e364706816aba3e25717850c26c9cd0d89d',
  );
});

test("SHA256('abc') matches the known vector", async () => {
  assert.equal(
    await scalar("SELECT TO_HEX(SHA256('abc')) AS x"),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('MD5 returns BYTES (base64 on the wire), matching BQ', async () => {
  // 900150983cd24fb0d6963f7d28e17f72 as 16 raw bytes, base64-encoded.
  assert.equal(await scalar("SELECT MD5('abc') AS x"), 'kAFQmDzST7DWlj99KOF/cg==');
});

test("SHA512('abc') matches the known vector (Node-backed UDF)", async () => {
  assert.equal(
    await scalar("SELECT TO_HEX(SHA512('abc')) AS x"),
    'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
  );
});

test('SHA512(NULL) is NULL', async () => {
  assert.equal(await scalar('SELECT SHA512(CAST(NULL AS STRING)) AS x'), null);
});

test('FARM_FINGERPRINT is rejected (FarmHash-specific; DuckDB hash() differs)', async () => {
  const { status, json } = await postQuery("SELECT FARM_FINGERPRINT('abc')");
  assert.equal(status, 400);
  assert.equal(
    (json as { error: { errors: Array<{ reason: string }> } }).error.errors[0]?.reason,
    'unsupportedFeature',
  );
});

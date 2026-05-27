/**
 * SQL function coverage map. SUPPORTED entries must return 200; UNSUPPORTED
 * must return 400 with reason `unsupportedFeature`. When you add support for
 * one, move it to SUPPORTED and this test enforces the flip. (Checks that a
 * function runs or is cleanly rejected — value fidelity is the conformance
 * suite's job.)
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
const PROJECT = 'sql-coverage';

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

async function run(query: string): Promise<{ status: number; reason: string | undefined }> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const json = (await res.json()) as { error?: { errors?: Array<{ reason?: string }> } };
  return { status: res.status, reason: json.error?.errors?.[0]?.reason };
}

const SUPPORTED: readonly string[] = [
  "SELECT EDIT_DISTANCE('kitten', 'sitting')",
  'SELECT (RAND() BETWEEN 0 AND 1)',
  'SELECT ARRAY_FIRST([10, 20, 30])',
  'SELECT ARRAY_LAST([10, 20, 30])',
  "SELECT PARSE_NUMERIC('1.5')",
  "SELECT PARSE_BIGNUMERIC('1.5')",
  'SELECT DATE(2020, 1, 1)',
  'SELECT TIME(1, 2, 3)',
  'SELECT DATETIME(2020, 1, 1, 3, 4, 5)',
  "SELECT TIMESTAMP('2020-01-01T00:00:00Z')",
  'SELECT TIMESTAMP_SECONDS(1)',
  'SELECT TIMESTAMP_MILLIS(1000)',
  'SELECT TIMESTAMP_MICROS(1000000)',
  'SELECT CURRENT_DATETIME()',
  'SELECT CURRENT_TIME()',
  'SELECT CURRENT_DATE()',
  "SELECT DATETIME_ADD(DATETIME '2020-01-01', INTERVAL 1 HOUR)",
  "SELECT DATETIME_SUB(DATETIME '2020-01-01', INTERVAL 1 HOUR)",
  "SELECT DATETIME_DIFF(DATETIME '2020-01-02', DATETIME '2020-01-01', HOUR)",
  "SELECT CONCAT('a', 'b')",
  "SELECT DATE_ADD(DATE '2020-01-01', INTERVAL 1 DAY)",
  'SELECT GREATEST(1, 2, 3)',
  "SELECT JSON_VALUE('{\"a\":1}', '$.a')",
  'SELECT SUM(x) FROM UNNEST([1, 2, 3]) AS x',
  'SELECT ROW_NUMBER() OVER (ORDER BY x) FROM UNNEST([1, 2, 3]) AS x',
  "SELECT SHA512('abc')",
  'SELECT GENERATE_UUID()',
];

const UNSUPPORTED: readonly string[] = [
  "SELECT INITCAP('a b')",
  "SELECT REGEXP_INSTR('abc', 'b')",
  "SELECT CONTAINS_SUBSTR('abc', 'b')",
  'SELECT CODE_POINTS_TO_STRING([65])',
  "SELECT TO_CODE_POINTS('abc')",
  "SELECT SAFE_CONVERT_BYTES_TO_STRING(b'abc')",
  "SELECT SOUNDEX('Robert')",
  'SELECT RANGE_BUCKET(2, [1, 3])',
  "SELECT LAX_INT64(JSON '1')",
  "SELECT JSON_EXTRACT_ARRAY('[1]')",
  "SELECT JSON_REMOVE(JSON '{\"a\":1}', '$.a')",
  "SELECT TO_BASE32(b'abc')",
  'SELECT APPROX_TOP_COUNT(1, 2)',
  'SELECT HLL_COUNT.INIT(1)',
  "SELECT FARM_FINGERPRINT('abc')",
];

for (const sql of SUPPORTED) {
  test(`supported: ${sql}`, async () => {
    const { status } = await run(sql);
    assert.equal(status, 200, `expected 200 for: ${sql}`);
  });
}

for (const sql of UNSUPPORTED) {
  test(`unsupported: ${sql}`, async () => {
    const { status, reason } = await run(sql);
    assert.equal(status, 400, `expected 400 for: ${sql}`);
    assert.equal(reason, 'unsupportedFeature', `expected unsupportedFeature for: ${sql}`);
  });
}

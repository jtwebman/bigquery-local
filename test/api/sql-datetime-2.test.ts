/**
 * BL-040 — BQ date/time functions (2): GENERATE_DATE_ARRAY,
 * GENERATE_TIMESTAMP_ARRAY, LAST_DAY, DATE_FROM_UNIX_DATE, UNIX_DATE,
 * UNIX_SECONDS / MILLIS / MICROS.
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
const PROJECT = 'sql-datetime-2';

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

test('GENERATE_DATE_ARRAY produces an inclusive list of DATEs', async () => {
  const out = await scalar(
    "SELECT GENERATE_DATE_ARRAY(DATE '2026-05-01', DATE '2026-05-03', INTERVAL 1 DAY) AS x",
  );
  assert.deepEqual(out, ['2026-05-01', '2026-05-02', '2026-05-03']);
});

test('GENERATE_TIMESTAMP_ARRAY produces an inclusive list of TIMESTAMPs', async () => {
  // Elements are TIMESTAMP-typed, so the wire format is microseconds-since-
  // epoch as decimal strings (Int64Value form).
  const out = (await scalar(
    "SELECT GENERATE_TIMESTAMP_ARRAY(TIMESTAMP '2026-05-17 00:00:00', TIMESTAMP '2026-05-17 02:00:00', INTERVAL 1 HOUR) AS x",
  )) as string[];
  assert.equal(out.length, 3);
  const expectedFirstUs = String(BigInt(Date.UTC(2026, 4, 17, 0, 0, 0)) * 1000n);
  assert.equal(out[0], expectedFirstUs);
});

test('LAST_DAY returns the last day of the month for a DATE', async () => {
  const out = await scalar("SELECT LAST_DAY(DATE '2026-05-17') AS x");
  assert.equal(out, '2026-05-31');
});

test('DATE_FROM_UNIX_DATE turns days-since-epoch into a DATE', async () => {
  assert.equal(await scalar('SELECT DATE_FROM_UNIX_DATE(19500) AS x'), '2023-05-23');
});

test('UNIX_DATE returns days since the unix epoch', async () => {
  assert.equal(await scalar("SELECT UNIX_DATE(DATE '2026-05-17') AS x"), '20590');
});

test('UNIX_SECONDS converts a TIMESTAMP to seconds since epoch', async () => {
  assert.equal(
    await scalar("SELECT UNIX_SECONDS(TIMESTAMP '2026-05-17 12:00:00') AS x"),
    '1779019200',
  );
});

test('UNIX_MILLIS converts a TIMESTAMP to milliseconds since epoch', async () => {
  assert.equal(
    await scalar("SELECT UNIX_MILLIS(TIMESTAMP '2026-05-17 12:00:00') AS x"),
    '1779019200000',
  );
});

test('UNIX_MICROS converts a TIMESTAMP to microseconds since epoch', async () => {
  assert.equal(
    await scalar("SELECT UNIX_MICROS(TIMESTAMP '2026-05-17 12:00:00') AS x"),
    '1779019200000000',
  );
});

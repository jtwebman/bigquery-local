/**
 * BL-039 — BQ date/time functions (1): DATE_TRUNC family, FORMAT family,
 * PARSE family, EXTRACT, DATE_DIFF / TIMESTAMP_DIFF / DATETIME_DIFF.
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
const PROJECT = 'sql-datetime-1';

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

test('DATE_TRUNC(date, MONTH) snaps to first of month', async () => {
  assert.equal(await scalar("SELECT DATE_TRUNC(DATE '2026-05-17', MONTH) AS x"), '2026-05-01');
});

test('TIMESTAMP_TRUNC(ts, DAY) snaps to midnight', async () => {
  const v = await scalar("SELECT TIMESTAMP_TRUNC(TIMESTAMP '2026-05-17 10:30:00', DAY) AS x");
  assert.match(String(v), /^2026-05-17T00:00:00/);
});

test('DATETIME_TRUNC(ts, HOUR) snaps to top of hour', async () => {
  const v = await scalar("SELECT DATETIME_TRUNC(DATETIME '2026-05-17 10:30:45', HOUR) AS x");
  assert.match(String(v), /^2026-05-17T10:00:00/);
});

test('FORMAT_TIMESTAMP renders to a string per spec', async () => {
  assert.equal(
    await scalar("SELECT FORMAT_TIMESTAMP('%Y-%m-%d', TIMESTAMP '2026-05-17 10:30:00') AS x"),
    '2026-05-17',
  );
});

test('FORMAT_DATE renders a date per spec', async () => {
  assert.equal(
    await scalar("SELECT FORMAT_DATE('%Y/%m/%d', DATE '2026-05-17') AS x"),
    '2026/05/17',
  );
});

test('PARSE_TIMESTAMP parses per spec', async () => {
  const v = await scalar("SELECT PARSE_TIMESTAMP('%Y-%m-%d', '2026-05-17') AS x");
  assert.match(String(v), /^2026-05-17T00:00:00/);
});

test('PARSE_DATE parses per spec', async () => {
  assert.equal(await scalar("SELECT PARSE_DATE('%Y-%m-%d', '2026-05-17') AS x"), '2026-05-17');
});

test('EXTRACT(YEAR FROM ts) returns the year', async () => {
  // INT64 → decimal-string wire format.
  assert.equal(
    await scalar("SELECT EXTRACT(YEAR FROM TIMESTAMP '2026-05-17 10:30:00') AS x"),
    '2026',
  );
});

test('EXTRACT(MONTH FROM date) returns the month', async () => {
  assert.equal(await scalar("SELECT EXTRACT(MONTH FROM DATE '2026-05-17') AS x"), '5');
});

test('DATE_DIFF(a, b, DAY) returns a - b in days', async () => {
  // 17 - 1 = 16
  assert.equal(
    await scalar("SELECT DATE_DIFF(DATE '2026-05-17', DATE '2026-05-01', DAY) AS x"),
    '16',
  );
});

test('TIMESTAMP_DIFF(a, b, SECOND) returns a - b in seconds', async () => {
  assert.equal(
    await scalar(
      "SELECT TIMESTAMP_DIFF(TIMESTAMP '2026-05-17 10:00:30', TIMESTAMP '2026-05-17 10:00:00', SECOND) AS x",
    ),
    '30',
  );
});

test('DATETIME_DIFF(a, b, HOUR) returns a - b in hours', async () => {
  assert.equal(
    await scalar(
      "SELECT DATETIME_DIFF(DATETIME '2026-05-17 12:00:00', DATETIME '2026-05-17 10:00:00', HOUR) AS x",
    ),
    '2',
  );
});

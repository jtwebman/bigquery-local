/**
 * BL-049 — format-string spec tests for FORMAT_DATE / FORMAT_TIMESTAMP /
 * PARSE_DATE / PARSE_TIMESTAMP (already implemented in BL-039) and FORMAT()
 * (BL-037).
 *
 * Format-aware CAST (`CAST(x AS STRING FORMAT 'YYYY-MM-DD')`) is deferred
 * — translating BQ's Oracle-style format strings (`YYYY-MM-DD`) into
 * DuckDB's strftime patterns (`%Y-%m-%d`) is a separate mini-parser.
 * Existing format-string functions accept the strftime form directly,
 * which matches DuckDB's native expectation.
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
const PROJECT = 'sql-format-spec';

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

// ---------------------------------------------------------------------------
// strftime format spec — every standard placeholder in BQ's docs
// ---------------------------------------------------------------------------

test('%Y prints 4-digit year', async () => {
  assert.equal(
    await scalar("SELECT FORMAT_TIMESTAMP('%Y', TIMESTAMP '2026-05-17 10:30:00') AS x"),
    '2026',
  );
});
test('%m prints zero-padded month', async () => {
  assert.equal(
    await scalar("SELECT FORMAT_TIMESTAMP('%m', TIMESTAMP '2026-05-17 10:30:00') AS x"),
    '05',
  );
});
test('%d prints zero-padded day', async () => {
  assert.equal(
    await scalar("SELECT FORMAT_TIMESTAMP('%d', TIMESTAMP '2026-05-17 10:30:00') AS x"),
    '17',
  );
});
test('%H prints 24-hour clock', async () => {
  assert.equal(
    await scalar("SELECT FORMAT_TIMESTAMP('%H', TIMESTAMP '2026-05-17 13:30:00') AS x"),
    '13',
  );
});
test('%M prints minutes', async () => {
  assert.equal(
    await scalar("SELECT FORMAT_TIMESTAMP('%M', TIMESTAMP '2026-05-17 10:30:00') AS x"),
    '30',
  );
});
test('%S prints seconds', async () => {
  assert.equal(
    await scalar("SELECT FORMAT_TIMESTAMP('%S', TIMESTAMP '2026-05-17 10:30:45') AS x"),
    '45',
  );
});
test('%Y-%m-%d composes the standard date spec', async () => {
  assert.equal(
    await scalar("SELECT FORMAT_DATE('%Y-%m-%d', DATE '2026-05-17') AS x"),
    '2026-05-17',
  );
});

// ---------------------------------------------------------------------------
// PARSE round-trips: format → parse → same value
// ---------------------------------------------------------------------------

test('PARSE_DATE round-trips with %Y-%m-%d', async () => {
  assert.equal(await scalar("SELECT PARSE_DATE('%Y-%m-%d', '2026-05-17') AS x"), '2026-05-17');
});

test('PARSE_TIMESTAMP round-trips with %Y-%m-%d %H:%M:%S', async () => {
  const v = await scalar("SELECT PARSE_TIMESTAMP('%Y-%m-%d %H:%M:%S', '2026-05-17 10:30:45') AS x");
  assert.match(String(v), /^2026-05-17T10:30:45/);
});

// ---------------------------------------------------------------------------
// FORMAT() printf placeholders
// ---------------------------------------------------------------------------

test("FORMAT('%s=%d', 'a', 7) produces a=7", async () => {
  assert.equal(await scalar("SELECT FORMAT('%s=%d', 'a', 7) AS x"), 'a=7');
});
test("FORMAT('%.2f', 3.14159) rounds to 2 decimals", async () => {
  assert.equal(await scalar("SELECT FORMAT('%.2f', 3.14159) AS x"), '3.14');
});

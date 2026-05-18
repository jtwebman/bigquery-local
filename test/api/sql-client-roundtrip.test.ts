/**
 * Round-trip tests using the **official `@google-cloud/bigquery` client**.
 *
 * If the wire format is right and the auth bypass works, the client
 * library parses our responses into the expected JS values without any
 * hand-massaging. This file is the practical fidelity gate — if a real
 * BQ user pointed their code at the emulator, this is what they'd see.
 *
 * Auth-bypass recipe: pass `emulatorGoogleAuth()` (from `src/client.ts`)
 * as the `authClient` so the client doesn't try to call Google.
 *
 * Routing: the BQ client sends requests to `${apiEndpoint}/bigquery/v2/...`;
 * our server strips the `/bigquery/v2` prefix in `server.ts` so the
 * existing `/projects/{p}/...` route table matches.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { BigQuery } from '@google-cloud/bigquery';

import { emulatorGoogleAuth } from '../../src/client.ts';
import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createJobsRoutes } from '../../src/routes/jobs.ts';
import { createQueriesRoutes } from '../../src/routes/queries.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

let db: Db;
let server: Server;
let bq: BigQuery;
const PROJECT = 'client-rt';

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [
      ...createDatasetRoutes(db),
      ...createTableRoutes(db),
      ...createQueriesRoutes(db),
      ...createJobsRoutes(db),
    ],
  });
  await server.listen(0);
  bq = new BigQuery({
    projectId: PROJECT,
    apiEndpoint: server.url,
    authClient: emulatorGoogleAuth(),
  });
});
after(async () => {
  await server.close();
  await db.close();
});

async function row(query: string): Promise<Record<string, unknown>> {
  const [rows] = await bq.query({ query, useLegacySql: false });
  return (rows[0] ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Scalars — client parses our wire format back to expected JS types
// ---------------------------------------------------------------------------

test('client: STRING column returns a JS string', async () => {
  const r = await row(`SELECT 'hello' AS s`);
  assert.equal(r['s'], 'hello');
});

test('client: BOOL column returns a JS boolean', async () => {
  const r = await row('SELECT TRUE AS t, FALSE AS f');
  assert.equal(r['t'], true);
  assert.equal(r['f'], false);
});

test('client: INT64 column returns a JS number for small ints', async () => {
  const r = await row('SELECT 42 AS n');
  // The client wraps INT64 — small enough to be a plain number.
  assert.equal(Number(r['n']), 42);
});

test('client: DATE column returns a BigQueryDate', async () => {
  const r = await row(`SELECT DATE '2026-05-17' AS d`);
  const d = r['d'] as { value: string };
  assert.equal(d.value, '2026-05-17');
});

test('client: TIMESTAMP column round-trips to a parseable Date', async () => {
  const r = await row(`SELECT TIMESTAMP '2026-05-17 10:30:00 UTC' AS t`);
  const t = r['t'] as { value: string } | Date;
  const date = t instanceof Date ? t : new Date((t as { value: string }).value);
  assert.equal(date.toISOString(), '2026-05-17T10:30:00.000Z');
});

// ---------------------------------------------------------------------------
// Repeated and struct — client unwraps the f/v envelope back to native arrays
// ---------------------------------------------------------------------------

test('client: ARRAY<INT64> column returns a JS array', async () => {
  const r = await row(`SELECT [10, 20, 30] AS arr`);
  const arr = r['arr'] as Array<unknown>;
  assert.ok(Array.isArray(arr));
  assert.equal(arr.length, 3);
});

// STRUCT column via the client — gated on a translator gap. BQ's
// `STRUCT(1 AS id, 'hi' AS msg)` literal isn't translated to DuckDB's
// `struct_pack(...)` yet, so we can't construct a STRUCT here through
// SELECT. The wire encoding is covered by unit tests in
// test/unit/types.test.ts (`duckValueToBq: STRUCT wraps as ...`).

// ---------------------------------------------------------------------------
// Smoke test — error responses from the emulator surface as client errors
// ---------------------------------------------------------------------------

test('client: invalid query surfaces as a thrown error', async () => {
  await assert.rejects(() =>
    bq.query({ query: 'SELECT garbage_column_nope', useLegacySql: false }),
  );
});

// ---------------------------------------------------------------------------
// Smoke test — getDatasets via the client returns whatever we have
// ---------------------------------------------------------------------------

test('client: getDatasets returns the project datasets', async () => {
  // Seed one dataset via raw HTTP.
  await fetch(`${server.url}/projects/${PROJECT}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: 'demo' } }),
  });
  const [datasets] = await bq.getDatasets();
  const ids = datasets.map((d) => d.id);
  assert.ok(ids.includes('demo'), `expected 'demo' in ${JSON.stringify(ids)}`);
});

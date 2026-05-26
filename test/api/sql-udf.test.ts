/**
 * BL-063 — SQL UDFs (`CREATE FUNCTION` / `DROP FUNCTION`).
 *
 *   CREATE [OR REPLACE] [TEMP|TEMPORARY] FUNCTION [IF NOT EXISTS]
 *     [`project.dataset.`]name(arg_name arg_type, …)
 *     [RETURNS data_type]
 *     AS (expr) | AS """expr"""
 *
 *   DROP FUNCTION [IF EXISTS] [`project.dataset.`]name
 *
 * Translation: BQ FUNCTION → DuckDB MACRO. Argument types are dropped
 * (DuckDB macros don't enforce them); RETURNS is honored by wrapping
 * the body in `CAST(… AS <duckType>)` so the returned value lands in
 * the declared BQ type.
 *
 * TEMP routines lean on DuckDB's connection-scoped TEMP MACRO — the
 * closest analogue we have until BQ-style sessions land in BL-074.
 * Persistent routines go in `_bq.routines`.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

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
const PROJECT = 'sql-udf';
const DATASET = 'ds';

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
  await fetch(`${server.url}/projects/${PROJECT}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: DATASET } }),
  });
});
after(async () => {
  await server.close();
  await db.close();
});

interface QueryResponse {
  jobReference: { jobId: string };
  schema?: { fields: Array<{ name: string; type: string }> };
  rows?: Array<{ f: Array<{ v: string }> }>;
  numDmlAffectedRows?: string;
}

async function postQuery(query: string): Promise<{ status: number; json: QueryResponse }> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { status: res.status, json: (await res.json()) as QueryResponse };
}

async function scalar(query: string): Promise<string | null | undefined> {
  const r = await postQuery(query);
  return (r.json.rows ?? [])[0]?.f[0]?.v;
}

// ---------------------------------------------------------------------------
// CREATE FUNCTION + call
// ---------------------------------------------------------------------------

test('persistent UDF: CREATE FUNCTION + call returns the declared return type', async () => {
  const create = await postQuery(
    `CREATE FUNCTION \`${DATASET}.add1\`(x INT64) RETURNS INT64 AS (x + 1)`,
  );
  assert.equal(create.status, 200);
  assert.equal(create.json.schema, undefined);
  assert.equal(create.json.rows, undefined);

  const call = await postQuery(`SELECT \`${DATASET}.add1\`(41) AS r`);
  assert.equal(call.json.rows?.[0]?.f[0]?.v, '42');
  assert.equal(call.json.schema?.fields[0]?.type, 'INTEGER');
});

test('UDF body can reference multiple args and call built-ins', async () => {
  await postQuery(
    `CREATE FUNCTION \`${DATASET}.greet\`(name STRING, n INT64) RETURNS STRING AS (CONCAT(name, ' x', CAST(n AS STRING)))`,
  );
  assert.equal(await scalar(`SELECT \`${DATASET}.greet\`('hi', 3) AS r`), 'hi x3');
});

// ---------------------------------------------------------------------------
// Body forms
// ---------------------------------------------------------------------------

test('triple-quoted body `AS """…"""` works the same as `AS (…)`', async () => {
  const create = await postQuery(
    `CREATE FUNCTION \`${DATASET}.tripled\`(x INT64) RETURNS INT64 AS """x * 3"""`,
  );
  assert.equal(create.status, 200);
  assert.equal(await scalar(`SELECT \`${DATASET}.tripled\`(4) AS r`), '12');
});

// ---------------------------------------------------------------------------
// RETURNS → CAST behaviour
// ---------------------------------------------------------------------------

test('RETURNS coerces the body expression to the declared type', async () => {
  // Body is a DOUBLE; declared INT64 → cast rounds (same as BQ).
  await postQuery(`CREATE FUNCTION \`${DATASET}.to_int\`(x FLOAT64) RETURNS INT64 AS (x)`);
  assert.equal(await scalar(`SELECT \`${DATASET}.to_int\`(3.2) AS r`), '3');
  // And the returned column is INTEGER (=INT64), not FLOAT — proving the CAST took effect.
  const r = await postQuery(`SELECT \`${DATASET}.to_int\`(3.2) AS r`);
  assert.equal(r.json.schema?.fields[0]?.type, 'INTEGER');
});

test('omitting RETURNS lets DuckDB infer the type from the expression', async () => {
  await postQuery(`CREATE FUNCTION \`${DATASET}.no_returns\`(x INT64) AS (x * 10)`);
  // The inferred type follows DuckDB; just check the value is right.
  assert.equal(await scalar(`SELECT \`${DATASET}.no_returns\`(7) AS r`), '70');
});

// ---------------------------------------------------------------------------
// CREATE OR REPLACE / IF NOT EXISTS
// ---------------------------------------------------------------------------

test('CREATE FUNCTION twice on the same name fails without OR REPLACE', async () => {
  await postQuery(`CREATE FUNCTION \`${DATASET}.dup\`(x INT64) RETURNS INT64 AS (x)`);
  const second = await postQuery(
    `CREATE FUNCTION \`${DATASET}.dup\`(x INT64) RETURNS INT64 AS (x + 1)`,
  );
  assert.equal(second.status, 400);
});

test('CREATE OR REPLACE FUNCTION updates the body', async () => {
  await postQuery(`CREATE OR REPLACE FUNCTION \`${DATASET}.repl\`(x INT64) RETURNS INT64 AS (x)`);
  await postQuery(
    `CREATE OR REPLACE FUNCTION \`${DATASET}.repl\`(x INT64) RETURNS INT64 AS (x + 100)`,
  );
  assert.equal(await scalar(`SELECT \`${DATASET}.repl\`(5) AS r`), '105');
});

test('CREATE FUNCTION IF NOT EXISTS is idempotent', async () => {
  const a = await postQuery(
    `CREATE FUNCTION IF NOT EXISTS \`${DATASET}.idem\`(x INT64) RETURNS INT64 AS (x + 1)`,
  );
  const b = await postQuery(
    `CREATE FUNCTION IF NOT EXISTS \`${DATASET}.idem\`(x INT64) RETURNS INT64 AS (x + 999)`,
  );
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  // Second create was a no-op; the original body wins.
  assert.equal(await scalar(`SELECT \`${DATASET}.idem\`(10) AS r`), '11');
});

// ---------------------------------------------------------------------------
// TEMP functions — unqualified name, no dataset
// ---------------------------------------------------------------------------

test('CREATE TEMP FUNCTION: unqualified name, callable unqualified', async () => {
  await postQuery('CREATE TEMP FUNCTION double_it(x INT64) RETURNS INT64 AS (x * 2)');
  assert.equal(await scalar('SELECT double_it(21) AS r'), '42');
});

// ---------------------------------------------------------------------------
// DROP FUNCTION
// ---------------------------------------------------------------------------

test('DROP FUNCTION removes the routine; calls afterward error', async () => {
  await postQuery(`CREATE FUNCTION \`${DATASET}.transient\`(x INT64) RETURNS INT64 AS (x + 1)`);
  const drop = await postQuery(`DROP FUNCTION \`${DATASET}.transient\``);
  assert.equal(drop.status, 200);
  const after = await postQuery(`SELECT \`${DATASET}.transient\`(1) AS r`);
  assert.equal(after.status, 400);
});

test('DROP FUNCTION on missing without IF EXISTS: 404', async () => {
  const r = await postQuery(`DROP FUNCTION \`${DATASET}.never_existed\``);
  assert.equal(r.status, 404);
});

test('DROP FUNCTION IF EXISTS on missing: 200 silently', async () => {
  const r = await postQuery(`DROP FUNCTION IF EXISTS \`${DATASET}.never_existed\``);
  assert.equal(r.status, 200);
});

// ---------------------------------------------------------------------------
// Routine metadata is persisted to _bq.routines (for non-TEMP)
// ---------------------------------------------------------------------------

test('persistent UDF is recorded in _bq.routines with body + return type', async () => {
  await postQuery(`CREATE FUNCTION \`${DATASET}.meta_check\`(x INT64) RETURNS INT64 AS (x * x)`);
  const rows = await db.query<Record<string, unknown>>(
    `SELECT routine_id, routine_type, language, body
       FROM _bq.routines
      WHERE project = $1 AND dataset_id = $2 AND routine_id = $3`,
    [PROJECT, DATASET, 'meta_check'],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.['routine_type'], 'SCALAR_FUNCTION');
  assert.equal(rows[0]?.['language'], 'SQL');
  assert.equal(rows[0]?.['body'], 'x * x');
});

test('TEMP UDF is NOT recorded in _bq.routines (DuckDB owns its lifecycle)', async () => {
  await postQuery('CREATE TEMP FUNCTION temp_only(x INT64) RETURNS INT64 AS (x)');
  const rows = await db.query<Record<string, unknown>>(
    'SELECT * FROM _bq.routines WHERE routine_id = $1',
    ['temp_only'],
  );
  assert.equal(rows.length, 0);
});

// ---------------------------------------------------------------------------
// Persisted job
// ---------------------------------------------------------------------------

test('persisted job has statementType=CREATE_FUNCTION', async () => {
  const r = await postQuery(
    `CREATE FUNCTION \`${DATASET}.job_check\`(x INT64) RETURNS INT64 AS (x)`,
  );
  const jobRes = await fetch(`${server.url}/projects/${PROJECT}/jobs/${r.json.jobReference.jobId}`);
  const job = (await jobRes.json()) as { statistics: { query: { statementType: string } } };
  assert.equal(job.statistics.query.statementType, 'CREATE_FUNCTION');
});

// ---------------------------------------------------------------------------
// Missing dataset for persistent UDF → 404
// ---------------------------------------------------------------------------

test('CREATE FUNCTION into a missing dataset returns 404', async () => {
  const r = await postQuery('CREATE FUNCTION `does_not_exist.fn`(x INT64) RETURNS INT64 AS (x)');
  assert.equal(r.status, 404);
});

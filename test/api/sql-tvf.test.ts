/**
 * BL-064 — Table-valued functions.
 *
 *   CREATE [OR REPLACE] [TEMP|TEMPORARY] TABLE FUNCTION [IF NOT EXISTS]
 *     [`project.dataset.`]name(arg_name arg_type, …)
 *     [RETURNS TABLE<col1 type1, …>]
 *     AS (SELECT …)
 *
 *   DROP TABLE FUNCTION [IF EXISTS] [`project.dataset.`]name
 *
 * DuckDB has `CREATE MACRO … AS TABLE <select>` and `DROP MACRO TABLE …`
 * which line up almost 1:1. The body is translated through the regular
 * BQ → DuckDB pipeline so backtick references inside the SELECT resolve
 * to the right project-qualified DuckDB tables. RETURNS TABLE<…> is
 * captured in `_bq.routines` metadata but not enforced — DuckDB infers
 * the schema from the body.
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
const PROJECT = 'sql-tvf';
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
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'sales' },
      schema: {
        fields: [
          { name: 'region', type: 'STRING' },
          { name: 'amount', type: 'INT64' },
        ],
      },
    }),
  });
  await postQuery(
    `INSERT INTO \`${DATASET}.sales\` VALUES ('east',10),('east',20),('west',30),('west',40)`,
  );
});
after(async () => {
  await server.close();
  await db.close();
});

interface QueryResponse {
  jobReference: { jobId: string };
  schema?: { fields: Array<{ name: string; type: string }> };
  rows?: Array<{ f: Array<{ v: string }> }>;
}

async function postQuery(query: string): Promise<{ status: number; json: QueryResponse }> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { status: res.status, json: (await res.json()) as QueryResponse };
}

async function rowsOf(query: string): Promise<Array<Array<string>>> {
  const r = await postQuery(query);
  return (r.json.rows ?? []).map((row) => row.f.map((f) => f.v));
}

// ---------------------------------------------------------------------------
// CREATE TABLE FUNCTION + call
// ---------------------------------------------------------------------------

test('CREATE TABLE FUNCTION: callable from FROM clause, returns the SELECT shape', async () => {
  const create = await postQuery(
    `CREATE TABLE FUNCTION \`${DATASET}.totals_by_region\`(min_amt INT64) AS (
       SELECT region, SUM(amount) AS total
         FROM \`${DATASET}.sales\`
        WHERE amount >= min_amt
        GROUP BY region
        ORDER BY region
     )`,
  );
  assert.equal(create.status, 200);
  assert.equal(create.json.schema, undefined);

  const callQuery = `SELECT * FROM \`${DATASET}.totals_by_region\`(15) ORDER BY region`;
  const r = await postQuery(callQuery);
  // After filtering amount >= 15: east keeps 20, west keeps both 30+40=70.
  assert.deepEqual(
    (r.json.rows ?? []).map((row) => row.f.map((f) => f.v)),
    [
      ['east', '20'],
      ['west', '70'],
    ],
  );
  // Schema is whatever the SELECT produces (BQ's REST API uses legacy type names).
  assert.deepEqual(
    r.json.schema?.fields.map((f) => [f.name, f.type]),
    [
      ['region', 'STRING'],
      ['total', 'INTEGER'],
    ],
  );
});

// ---------------------------------------------------------------------------
// Triple-quoted body
// ---------------------------------------------------------------------------

test('triple-quoted body works for TVFs', async () => {
  await postQuery(
    `CREATE TABLE FUNCTION \`${DATASET}.east_only\`() AS """
       SELECT * FROM \`${DATASET}.sales\` WHERE region = 'east' ORDER BY amount
     """`,
  );
  assert.deepEqual(await rowsOf(`SELECT * FROM \`${DATASET}.east_only\`()`), [
    ['east', '10'],
    ['east', '20'],
  ]);
});

// ---------------------------------------------------------------------------
// CREATE OR REPLACE updates the body
// ---------------------------------------------------------------------------

test('CREATE OR REPLACE TABLE FUNCTION updates the body', async () => {
  await postQuery(`CREATE TABLE FUNCTION \`${DATASET}.repl_tvf\`() AS (SELECT 1 AS x)`);
  await postQuery(`CREATE OR REPLACE TABLE FUNCTION \`${DATASET}.repl_tvf\`() AS (SELECT 42 AS x)`);
  assert.deepEqual(await rowsOf(`SELECT * FROM \`${DATASET}.repl_tvf\`()`), [['42']]);
});

// ---------------------------------------------------------------------------
// RETURNS TABLE<…> is captured in metadata but doesn't override the body's shape
// ---------------------------------------------------------------------------

test('RETURNS TABLE<…> is recorded in _bq.routines metadata', async () => {
  await postQuery(
    `CREATE TABLE FUNCTION \`${DATASET}.with_returns\`()
       RETURNS TABLE<region STRING, total INT64>
       AS (SELECT region, SUM(amount) AS total FROM \`${DATASET}.sales\` GROUP BY region)`,
  );
  const rows = await db.query<Record<string, unknown>>(
    `SELECT routine_id, routine_type, language, return_type
       FROM _bq.routines
      WHERE project = $1 AND dataset_id = $2 AND routine_id = $3`,
    [PROJECT, DATASET, 'with_returns'],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.['routine_type'], 'TABLE_VALUED_FUNCTION');
  assert.equal(rows[0]?.['language'], 'SQL');
  // The exact JSON shape is the structured returnType we stash; check it's
  // present and contains the verbatim TABLE<…> type text.
  const rt = JSON.parse(rows[0]?.['return_type'] as string) as { typeKind: string };
  assert.match(rt.typeKind, /TABLE\s*<\s*region\s+STRING\s*,/);
});

// ---------------------------------------------------------------------------
// DROP TABLE FUNCTION
// ---------------------------------------------------------------------------

test('DROP TABLE FUNCTION removes it; call afterward errors', async () => {
  await postQuery(`CREATE TABLE FUNCTION \`${DATASET}.transient\`() AS (SELECT 1 AS x)`);
  const drop = await postQuery(`DROP TABLE FUNCTION \`${DATASET}.transient\``);
  assert.equal(drop.status, 200);
  const after = await postQuery(`SELECT * FROM \`${DATASET}.transient\`()`);
  assert.equal(after.status, 400);
});

test('DROP TABLE FUNCTION on missing without IF EXISTS: 404', async () => {
  const r = await postQuery(`DROP TABLE FUNCTION \`${DATASET}.never_existed\``);
  assert.equal(r.status, 404);
});

test('DROP TABLE FUNCTION IF EXISTS on missing: 200 silently', async () => {
  const r = await postQuery(`DROP TABLE FUNCTION IF EXISTS \`${DATASET}.never_existed\``);
  assert.equal(r.status, 200);
});

// ---------------------------------------------------------------------------
// TEMP TABLE FUNCTION: unqualified, connection-scoped
// ---------------------------------------------------------------------------

test('CREATE TEMP TABLE FUNCTION: unqualified, callable unqualified', async () => {
  await postQuery(
    `CREATE TEMP TABLE FUNCTION temp_tvf(n INT64) AS (
       SELECT i FROM (VALUES (1), (2), (3), (4), (5)) AS v(i) WHERE i <= n
     )`,
  );
  assert.deepEqual(await rowsOf('SELECT * FROM temp_tvf(3) ORDER BY i'), [['1'], ['2'], ['3']]);
});

// ---------------------------------------------------------------------------
// Persisted job
// ---------------------------------------------------------------------------

test('persisted job has statementType=CREATE_TABLE_FUNCTION', async () => {
  const r = await postQuery(`CREATE TABLE FUNCTION \`${DATASET}.jobcheck\`() AS (SELECT 1 AS x)`);
  const jobRes = await fetch(`${server.url}/projects/${PROJECT}/jobs/${r.json.jobReference.jobId}`);
  const job = (await jobRes.json()) as { statistics: { query: { statementType: string } } };
  assert.equal(job.statistics.query.statementType, 'CREATE_TABLE_FUNCTION');
});

// ---------------------------------------------------------------------------
// Missing dataset
// ---------------------------------------------------------------------------

test('CREATE TABLE FUNCTION into a missing dataset returns 404', async () => {
  const r = await postQuery('CREATE TABLE FUNCTION `does_not_exist.tvf`() AS (SELECT 1)');
  assert.equal(r.status, 404);
});

// ---------------------------------------------------------------------------
// Scalar UDF body translation regression — make sure the same body-translate
// path that TVFs need doesn't break scalar UDFs that reference tables.
// ---------------------------------------------------------------------------

test('scalar UDF body can reference a table via backticks', async () => {
  await postQuery(
    `CREATE FUNCTION \`${DATASET}.region_count\`() RETURNS INT64 AS ((SELECT COUNT(DISTINCT region) FROM \`${DATASET}.sales\`))`,
  );
  const r = await postQuery(`SELECT \`${DATASET}.region_count\`() AS n`);
  assert.equal(r.json.rows?.[0]?.f[0]?.v, '2');
});

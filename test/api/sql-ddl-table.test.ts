/**
 * CREATE TABLE AS SELECT / DROP TABLE via SQL, plus the BQ-only clauses and
 * query-job destination tables that dbt-bigquery depends on:
 *   - OPTIONS(...) stripped (warn-and-ignore)
 *   - PARTITION BY / CLUSTER BY captured into timePartitioning / clustering
 *   - 3-part `proj`.`ds`.`tbl` names
 *   - CREATE OR REPLACE / IF NOT EXISTS
 *   - the created table registered in metadata (REST GET works)
 *   - query jobs report configuration.query.destinationTable (CTAS = created
 *     table; SELECT = anonymous results table)
 *   - MERGE with unqualified INSERT VALUES (BQ source resolution)
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
const PROJECT = 'ddl-table-test';

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
    body: JSON.stringify({ datasetReference: { datasetId: 'ds' } }),
  });
});
after(async () => {
  await server.close();
  await db.close();
});

interface QueryResult {
  status: number;
  json: {
    rows?: Array<{ f: Array<{ v: string | null }> }>;
    jobReference?: { jobId: string };
  };
}
async function query(sql: string): Promise<QueryResult> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  return { status: res.status, json: (await res.json()) as QueryResult['json'] };
}
function rows(r: QueryResult): Array<Array<string | null>> {
  return (r.json.rows ?? []).map((row) => row.f.map((f) => f.v));
}
interface TableResource {
  schema?: { fields: Array<{ name: string; type: string }> };
  timePartitioning?: { type: string; field?: string };
  clustering?: { fields: string[] };
  numRows?: string;
}
async function getTable(
  tableId: string,
  datasetId = 'ds',
): Promise<{ status: number; json: TableResource }> {
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${datasetId}/tables/${tableId}`,
  );
  return { status: res.status, json: (await res.json()) as TableResource };
}

test('CREATE TABLE AS SELECT registers the table in metadata', async () => {
  const r = await query('CREATE TABLE `ds.t1` AS SELECT 1 AS id, "a" AS name');
  assert.equal(r.status, 200);
  const t = await getTable('t1');
  assert.equal(t.status, 200);
  assert.deepEqual(
    (t.json.schema?.fields ?? []).map((f) => f.name),
    ['id', 'name'],
  );
  assert.deepEqual(rows(await query('SELECT id, name FROM `ds.t1`')), [['1', 'a']]);
});

test('OPTIONS() clause is stripped and the statement still runs', async () => {
  const r = await query('CREATE OR REPLACE TABLE `ds.t_opts` OPTIONS() AS SELECT 1 AS id');
  assert.equal(r.status, 200);
  assert.equal((await getTable('t_opts')).status, 200);
});

test('OPTIONS(description=...) with content is stripped (warn-and-ignore)', async () => {
  const r = await query(
    'CREATE OR REPLACE TABLE `ds.t_desc` OPTIONS(description="hi", labels=[("a","b")]) AS SELECT 1 AS id',
  );
  assert.equal(r.status, 200);
});

test('3-part `proj`.`ds`.`tbl` name resolves to the project-qualified table', async () => {
  const r = await query(`CREATE TABLE \`${PROJECT}\`.\`ds\`.\`t3\` AS SELECT 42 AS n`);
  assert.equal(r.status, 200);
  assert.equal((await getTable('t3')).status, 200);
  // 3-part ref in a FROM clause also resolves.
  assert.deepEqual(rows(await query(`SELECT n FROM \`${PROJECT}\`.\`ds\`.\`t3\``)), [['42']]);
});

test('PARTITION BY / CLUSTER BY are captured into table metadata', async () => {
  const r = await query(
    'CREATE OR REPLACE TABLE `ds.t_part` PARTITION BY DATE(ts) CLUSTER BY id AS ' +
      "SELECT 1 AS id, TIMESTAMP '2026-01-01 00:00:00' AS ts",
  );
  assert.equal(r.status, 200);
  const t = await getTable('t_part');
  assert.deepEqual(t.json.timePartitioning, { type: 'DAY', field: 'ts' });
  assert.deepEqual(t.json.clustering, { fields: ['id'] });
});

test('TIMESTAMP_TRUNC(col, HOUR) partition maps to HOUR', async () => {
  const r = await query(
    'CREATE OR REPLACE TABLE `ds.t_hour` PARTITION BY TIMESTAMP_TRUNC(ts, HOUR) AS ' +
      "SELECT TIMESTAMP '2026-01-01 00:00:00' AS ts",
  );
  assert.equal(r.status, 200);
  assert.deepEqual((await getTable('t_hour')).json.timePartitioning, { type: 'HOUR', field: 'ts' });
});

test('CREATE OR REPLACE TABLE replaces an existing table', async () => {
  await query('CREATE OR REPLACE TABLE `ds.t_rep` AS SELECT 1 AS a');
  const r = await query('CREATE OR REPLACE TABLE `ds.t_rep` AS SELECT 2 AS b, 3 AS c');
  assert.equal(r.status, 200);
  assert.deepEqual(rows(await query('SELECT b, c FROM `ds.t_rep`')), [['2', '3']]);
});

test('CREATE TABLE without OR REPLACE on an existing table: 409 duplicate', async () => {
  await query('CREATE TABLE `ds.t_dup` AS SELECT 1 AS a');
  const r = await query('CREATE TABLE `ds.t_dup` AS SELECT 1 AS a');
  assert.equal(r.status, 409);
});

test('CREATE TABLE IF NOT EXISTS on an existing table is a no-op success', async () => {
  await query('CREATE TABLE `ds.t_ine` AS SELECT 1 AS a');
  const r = await query('CREATE TABLE IF NOT EXISTS `ds.t_ine` AS SELECT 99 AS a');
  assert.equal(r.status, 200);
  // Unchanged — the IF NOT EXISTS create did not overwrite.
  assert.deepEqual(rows(await query('SELECT a FROM `ds.t_ine`')), [['1']]);
});

test('DROP TABLE removes the table and its metadata', async () => {
  await query('CREATE TABLE `ds.t_drop` AS SELECT 1 AS a');
  assert.equal((await getTable('t_drop')).status, 200);
  const r = await query('DROP TABLE `ds.t_drop`');
  assert.equal(r.status, 200);
  assert.equal((await getTable('t_drop')).status, 404);
});

test('DROP TABLE IF EXISTS on a missing table succeeds; without it, 404', async () => {
  assert.equal((await query('DROP TABLE IF EXISTS `ds.nope`')).status, 200);
  assert.equal((await query('DROP TABLE `ds.nope`')).status, 404);
});

test('CTAS job reports configuration.query.destinationTable = created table', async () => {
  const r = await query('CREATE TABLE `ds.t_dest` AS SELECT 1 AS id');
  const jobId = r.json.jobReference?.jobId as string;
  const jobRes = await fetch(`${server.url}/projects/${PROJECT}/jobs/${jobId}`);
  const job = (await jobRes.json()) as {
    configuration: { query: { destinationTable?: { datasetId: string; tableId: string } } };
  };
  assert.deepEqual(job.configuration.query.destinationTable, {
    projectId: PROJECT,
    datasetId: 'ds',
    tableId: 't_dest',
  });
});

test('SELECT job reports an anonymous destination table that GET resolves', async () => {
  const r = await query('SELECT 10 AS a UNION ALL SELECT 20');
  const jobId = r.json.jobReference?.jobId as string;
  const jobRes = await fetch(`${server.url}/projects/${PROJECT}/jobs/${jobId}`);
  const job = (await jobRes.json()) as {
    configuration: { query: { destinationTable?: { datasetId: string; tableId: string } } };
  };
  const dest = job.configuration.query.destinationTable;
  assert.ok(dest, 'expected a destinationTable on the SELECT job');
  assert.equal(dest?.tableId, jobId);
  // get_table(destination) must resolve and report the row count.
  const t = await getTable(jobId, dest?.datasetId);
  assert.equal(t.status, 200);
  assert.equal(t.json.numRows, '2');
});

test('anonymous result table GET for an unknown job is 404', async () => {
  const t = await getTable('00000000-0000-0000-0000-000000000000', '_bqlocal_anon');
  assert.equal(t.status, 404);
});

test('MERGE with unqualified INSERT VALUES resolves them to the source', async () => {
  await query('CREATE OR REPLACE TABLE `ds.m_dst` AS SELECT 1 AS id, "a" AS name');
  const r = await query(
    'MERGE INTO `ds.m_dst` AS D ' +
      'USING (SELECT 2 AS id, "b" AS name) AS S ON (S.id = D.id) ' +
      'WHEN MATCHED THEN UPDATE SET `name` = S.`name` ' +
      'WHEN NOT MATCHED THEN INSERT (`id`, `name`) VALUES (`id`, `name`)',
  );
  assert.equal(r.status, 200);
  assert.deepEqual(rows(await query('SELECT id, name FROM `ds.m_dst` ORDER BY id')), [
    ['1', 'a'],
    ['2', 'b'],
  ]);
});

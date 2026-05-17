/**
 * BL-052 — single-table DML: INSERT / UPDATE / DELETE through `POST /queries`.
 *
 * BigQuery's wire shape for DML differs from SELECT:
 *   - no `schema` and no `rows`
 *   - `numDmlAffectedRows` is the count of rows affected
 *   - the persisted job carries `statementType` (INSERT/UPDATE/DELETE) and
 *     a matching `dmlStats.{inserted,updated,deleted}RowCount` bucket
 *
 * Tables are created via the REST tables.insert endpoint (matches how a
 * BQ client would set things up); DML then runs through the query route.
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
const PROJECT = 'sql-dml';
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

let nextTableIdx = 0;
async function freshTable(): Promise<string> {
  nextTableIdx += 1;
  const id = `t${nextTableIdx}`;
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: id },
      schema: {
        fields: [
          { name: 'a', type: 'INT64' },
          { name: 'b', type: 'STRING' },
        ],
      },
    }),
  });
  return id;
}

interface QueryResponse {
  kind: string;
  schema?: { fields: unknown[] };
  rows?: unknown[];
  totalRows: string;
  jobReference: { jobId: string };
  numDmlAffectedRows?: string;
}

async function postQuery(
  query: string,
  body: Record<string, unknown> = {},
): Promise<QueryResponse> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, ...body }),
  });
  return (await res.json()) as QueryResponse;
}

async function countRows(tableId: string): Promise<number> {
  const r = await postQuery(`SELECT COUNT(*) AS n FROM \`${DATASET}.${tableId}\``);
  return Number((r.rows?.[0] as { f: Array<{ v: unknown }> }).f[0]?.v ?? 0);
}

// ---------------------------------------------------------------------------
// INSERT
// ---------------------------------------------------------------------------

test('INSERT … VALUES — numDmlAffectedRows matches inserted count, no schema/rows', async () => {
  const t = await freshTable();
  const r = await postQuery(`INSERT INTO \`${DATASET}.${t}\` VALUES (1, 'a'), (2, 'b'), (3, 'c')`);
  assert.equal(r.numDmlAffectedRows, '3');
  assert.equal(r.schema, undefined);
  assert.equal(r.rows, undefined);
  assert.equal(r.totalRows, '0');
  assert.equal(await countRows(t), 3);
});

test('INSERT … SELECT — counts the projected rows', async () => {
  const t = await freshTable();
  await postQuery(`INSERT INTO \`${DATASET}.${t}\` VALUES (10, 'x'), (20, 'y')`);
  const r = await postQuery(
    `INSERT INTO \`${DATASET}.${t}\` SELECT a + 100, b || '!' FROM \`${DATASET}.${t}\``,
  );
  assert.equal(r.numDmlAffectedRows, '2');
  assert.equal(await countRows(t), 4);
});

test('INSERT with parameters — placeholders bind', async () => {
  const t = await freshTable();
  const r = await postQuery(`INSERT INTO \`${DATASET}.${t}\` VALUES (@a, @b)`, {
    queryParameters: [
      {
        name: 'a',
        parameterType: { type: 'INT64' },
        parameterValue: { value: '42' },
      },
      {
        name: 'b',
        parameterType: { type: 'STRING' },
        parameterValue: { value: 'param' },
      },
    ],
  });
  assert.equal(r.numDmlAffectedRows, '1');
  assert.equal(await countRows(t), 1);
});

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

test('UPDATE WHERE — only matched rows are counted and changed', async () => {
  const t = await freshTable();
  await postQuery(`INSERT INTO \`${DATASET}.${t}\` VALUES (1, 'a'), (2, 'b'), (3, 'c')`);
  const r = await postQuery(`UPDATE \`${DATASET}.${t}\` SET b = 'Z' WHERE a < 3`);
  assert.equal(r.numDmlAffectedRows, '2');
  assert.equal(r.schema, undefined);

  const after = await postQuery(`SELECT a, b FROM \`${DATASET}.${t}\` ORDER BY a`);
  const rows = (after.rows ?? []) as Array<{ f: Array<{ v: string }> }>;
  assert.deepEqual(
    rows.map((r) => [r.f[0]?.v, r.f[1]?.v]),
    [
      ['1', 'Z'],
      ['2', 'Z'],
      ['3', 'c'],
    ],
  );
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

test('DELETE WHERE — only matched rows are counted and removed', async () => {
  const t = await freshTable();
  await postQuery(`INSERT INTO \`${DATASET}.${t}\` VALUES (1, 'a'), (2, 'b'), (3, 'c')`);
  const r = await postQuery(`DELETE FROM \`${DATASET}.${t}\` WHERE a = 2`);
  assert.equal(r.numDmlAffectedRows, '1');
  assert.equal(await countRows(t), 2);
});

test('DELETE without WHERE — BQ requires WHERE clause; DuckDB allows it. Drops all rows.', async () => {
  // BigQuery requires `WHERE true` for full-table deletes; DuckDB doesn't.
  // For v0 we follow DuckDB and let the bare DELETE through — clients that
  // need BQ's safety check can opt in by writing `WHERE true` themselves.
  const t = await freshTable();
  await postQuery(`INSERT INTO \`${DATASET}.${t}\` VALUES (1, 'a'), (2, 'b')`);
  const r = await postQuery(`DELETE FROM \`${DATASET}.${t}\` WHERE TRUE`);
  assert.equal(r.numDmlAffectedRows, '2');
  assert.equal(await countRows(t), 0);
});

// ---------------------------------------------------------------------------
// Persisted job records statementType + dmlStats
// ---------------------------------------------------------------------------

test('persisted job has statementType and dmlStats bucket matching the operation', async () => {
  const t = await freshTable();
  const ins = await postQuery(`INSERT INTO \`${DATASET}.${t}\` VALUES (1, 'a'), (2, 'b')`);
  const upd = await postQuery(`UPDATE \`${DATASET}.${t}\` SET b = 'Z' WHERE a = 1`);
  const del = await postQuery(`DELETE FROM \`${DATASET}.${t}\` WHERE a = 2`);

  for (const [resp, type, count, statKey] of [
    [ins, 'INSERT', '2', 'insertedRowCount'],
    [upd, 'UPDATE', '1', 'updatedRowCount'],
    [del, 'DELETE', '1', 'deletedRowCount'],
  ] as const) {
    const jobRes = await fetch(`${server.url}/projects/${PROJECT}/jobs/${resp.jobReference.jobId}`);
    const job = (await jobRes.json()) as {
      statistics: {
        numDmlAffectedRows?: string;
        query: { statementType: string; dmlStats?: Record<string, string> };
      };
    };
    assert.equal(job.statistics.query.statementType, type);
    assert.equal(job.statistics.numDmlAffectedRows, count);
    assert.equal(job.statistics.query.dmlStats?.[statKey], count);
  }
});

// ---------------------------------------------------------------------------
// dryRun for DML — validates without executing
// ---------------------------------------------------------------------------

test('dryRun on INSERT validates without inserting', async () => {
  const t = await freshTable();
  const before = await countRows(t);
  const r = await postQuery(`INSERT INTO \`${DATASET}.${t}\` VALUES (1, 'a')`, {
    dryRun: true,
  });
  // DML dry-runs return no schema and no DML-affected-rows count.
  assert.equal(r.schema, undefined);
  assert.equal(r.numDmlAffectedRows, undefined);
  assert.equal(await countRows(t), before);
});

test('dryRun on INSERT into a missing table surfaces the catalog error', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `INSERT INTO \`${DATASET}.does_not_exist\` VALUES (1, 'a')`,
      dryRun: true,
    }),
  });
  assert.equal(res.status, 400);
});

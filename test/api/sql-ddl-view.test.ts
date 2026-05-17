/**
 * BL-054 — DDL: VIEW.
 *
 * `CREATE VIEW` and `DROP VIEW` go through `POST /queries`. Behind the
 * scenes:
 *   - the target is parsed out of the BQ SQL (backtick or dotted form),
 *   - the translator rewrites refs to DuckDB schema-qualified names,
 *   - the view is materialized in DuckDB,
 *   - `_bq.tables` gets an upsert with `type='VIEW'` and the raw view body
 *     so tables.get can return BQ's `view: { query, useLegacySql: false }`.
 *
 * Acceptance: a created view shows up via the tables REST endpoint with
 * `type: 'VIEW'`; SELECT against it returns the underlying data.
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
const PROJECT = 'sql-ddl-view';
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
  // One base table to build views over.
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'base' },
      schema: {
        fields: [
          { name: 'id', type: 'INT64' },
          { name: 'v', type: 'STRING' },
        ],
      },
    }),
  });
  // Seed three rows so view SELECTs have something to return.
  await postQuery(`INSERT INTO \`${DATASET}.base\` VALUES (1, 'a'), (2, 'b'), (3, 'c')`);
});
after(async () => {
  await server.close();
  await db.close();
});

interface QueryResponse {
  jobReference: { jobId: string };
  schema?: { fields: unknown[] };
  rows?: Array<{ f: Array<{ v: string }> }>;
  totalRows: string;
  numDmlAffectedRows?: string;
}

async function postQuery(query: string): Promise<QueryResponse> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return (await res.json()) as QueryResponse;
}

interface TableResource {
  type: string;
  schema: { fields: Array<{ name: string; type: string }> };
  view?: { query: string; useLegacySql: boolean };
}

async function getTable(tableId: string): Promise<{ status: number; json: TableResource }> {
  const res = await fetch(
    `${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`,
  );
  return { status: res.status, json: (await res.json()) as TableResource };
}

// ---------------------------------------------------------------------------
// CREATE VIEW
// ---------------------------------------------------------------------------

test('CREATE VIEW: view is registered with type=VIEW, schema, and the raw query body', async () => {
  const q = `CREATE VIEW \`${DATASET}.v_basic\` AS SELECT id, UPPER(v) AS upper_v FROM \`${DATASET}.base\``;
  const r = await postQuery(q);
  assert.equal(r.schema, undefined);
  assert.equal(r.rows, undefined);
  assert.equal(r.numDmlAffectedRows, undefined);

  const { status, json: t } = await getTable('v_basic');
  assert.equal(status, 200);
  assert.equal(t.type, 'VIEW');
  assert.deepEqual(
    t.schema.fields.map((f) => [f.name, f.type]),
    [
      ['id', 'INT64'],
      ['upper_v', 'STRING'],
    ],
  );
  assert.ok(t.view !== undefined);
  assert.match(t.view.query, /SELECT id, UPPER\(v\) AS upper_v FROM/);
  assert.equal(t.view.useLegacySql, false);
});

test('SELECT against the view returns the rewritten rows', async () => {
  const r = await postQuery(`SELECT id, upper_v FROM \`${DATASET}.v_basic\` ORDER BY id`);
  const rows = (r.rows ?? []) as Array<{ f: Array<{ v: string }> }>;
  assert.deepEqual(
    rows.map((row) => [row.f[0]?.v, row.f[1]?.v]),
    [
      ['1', 'A'],
      ['2', 'B'],
      ['3', 'C'],
    ],
  );
});

// ---------------------------------------------------------------------------
// CREATE OR REPLACE — schema can change between versions
// ---------------------------------------------------------------------------

test('CREATE OR REPLACE VIEW updates the schema and view body', async () => {
  await postQuery(`CREATE VIEW \`${DATASET}.v_replace\` AS SELECT id FROM \`${DATASET}.base\``);
  await postQuery(
    `CREATE OR REPLACE VIEW \`${DATASET}.v_replace\` AS SELECT id, v, v || '!' AS bang FROM \`${DATASET}.base\``,
  );
  const { json: t } = await getTable('v_replace');
  assert.deepEqual(
    t.schema.fields.map((f) => f.name),
    ['id', 'v', 'bang'],
  );
  assert.match(t.view?.query ?? '', /bang/);
});

// ---------------------------------------------------------------------------
// DROP VIEW
// ---------------------------------------------------------------------------

test('DROP VIEW removes the metadata entry and the underlying view', async () => {
  await postQuery(`CREATE VIEW \`${DATASET}.v_temp\` AS SELECT id FROM \`${DATASET}.base\``);
  const before = await getTable('v_temp');
  assert.equal(before.status, 200);

  await postQuery(`DROP VIEW \`${DATASET}.v_temp\``);
  const after = await getTable('v_temp');
  assert.equal(after.status, 404);

  // The view is gone from DuckDB too — a SELECT against it should error.
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `SELECT * FROM \`${DATASET}.v_temp\`` }),
  });
  assert.equal(res.status, 400);
});

test('DROP VIEW IF EXISTS silently no-ops when the view is missing', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `DROP VIEW IF EXISTS \`${DATASET}.never_existed\`` }),
  });
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// Missing dataset → 404 (mirrors REST tables.insert)
// ---------------------------------------------------------------------------

test('CREATE VIEW into a missing dataset returns 404', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `CREATE VIEW \`nope.v_missing\` AS SELECT 1`,
    }),
  });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// Persisted job records statementType=CREATE_VIEW / DROP_VIEW
// ---------------------------------------------------------------------------

test('persisted job has statementType=CREATE_VIEW and no DML stats', async () => {
  const r = await postQuery(
    `CREATE VIEW \`${DATASET}.v_jobcheck\` AS SELECT id FROM \`${DATASET}.base\``,
  );
  const jobRes = await fetch(`${server.url}/projects/${PROJECT}/jobs/${r.jobReference.jobId}`);
  const job = (await jobRes.json()) as {
    statistics: {
      numDmlAffectedRows?: string;
      query: { statementType: string; dmlStats?: unknown };
    };
  };
  assert.equal(job.statistics.query.statementType, 'CREATE_VIEW');
  assert.equal(job.statistics.numDmlAffectedRows, undefined);
  assert.equal(job.statistics.query.dmlStats, undefined);
});

// ---------------------------------------------------------------------------
// dryRun on CREATE VIEW validates without persisting
// ---------------------------------------------------------------------------

test('dryRun on CREATE VIEW validates and does not register the view', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `CREATE VIEW \`${DATASET}.v_dryrun\` AS SELECT id FROM \`${DATASET}.base\``,
      dryRun: true,
    }),
  });
  assert.equal(res.status, 200);
  const after = await getTable('v_dryrun');
  assert.equal(after.status, 404);
});

/**
 * BL-061 — TRUNCATE TABLE.
 *
 * DuckDB supports TRUNCATE natively with the BQ surface, returning the
 * pre-truncation row count in the same `{ Count: BIGINT }` shape as DML.
 * detectStatementType now classifies the leading TRUNCATE keyword as
 * TRUNCATE_TABLE, which falls through to the existing non-SELECT path —
 * the wire response carries `numDmlAffectedRows` (rows that existed
 * before truncation) and no schema/rows.
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
const PROJECT = 'sql-truncate';
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

let nextIdx = 0;
async function freshTable(): Promise<string> {
  nextIdx += 1;
  const id = `t${nextIdx}`;
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
  jobReference: { jobId: string };
  schema?: unknown;
  rows?: unknown;
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

async function countRows(tableId: string): Promise<number> {
  const r = await postQuery(`SELECT COUNT(*) AS n FROM \`${DATASET}.${tableId}\``);
  const rows = (r as unknown as { rows: Array<{ f: Array<{ v: string }> }> }).rows;
  return Number(rows[0]?.f[0]?.v ?? 0);
}

// ---------------------------------------------------------------------------
// TRUNCATE TABLE empties the table; schema is preserved
// ---------------------------------------------------------------------------

test('TRUNCATE TABLE empties the rows; schema is preserved', async () => {
  const t = await freshTable();
  await postQuery(`INSERT INTO \`${DATASET}.${t}\` VALUES (1, 'a'), (2, 'b'), (3, 'c')`);
  assert.equal(await countRows(t), 3);

  const r = await postQuery(`TRUNCATE TABLE \`${DATASET}.${t}\``);
  // DuckDB reports the pre-truncate count as the affected number.
  assert.equal(r.numDmlAffectedRows, '3');
  assert.equal(r.schema, undefined);
  assert.equal(r.rows, undefined);

  assert.equal(await countRows(t), 0);
  // Inserts after truncate must still work — schema intact.
  const ins = await postQuery(`INSERT INTO \`${DATASET}.${t}\` VALUES (10, 'x')`);
  assert.equal(ins.numDmlAffectedRows, '1');
  assert.equal(await countRows(t), 1);
});

// ---------------------------------------------------------------------------
// Bare `TRUNCATE <table>` (no TABLE keyword) also works
// ---------------------------------------------------------------------------

test('bare TRUNCATE (no TABLE keyword) is accepted', async () => {
  const t = await freshTable();
  await postQuery(`INSERT INTO \`${DATASET}.${t}\` VALUES (1, 'a'), (2, 'b')`);
  const r = await postQuery(`TRUNCATE \`${DATASET}.${t}\``);
  assert.equal(r.numDmlAffectedRows, '2');
  assert.equal(await countRows(t), 0);
});

// ---------------------------------------------------------------------------
// Persisted job has statementType=TRUNCATE_TABLE
// ---------------------------------------------------------------------------

test('persisted job has statementType=TRUNCATE_TABLE; no dmlStats bucket', async () => {
  const t = await freshTable();
  await postQuery(`INSERT INTO \`${DATASET}.${t}\` VALUES (1, 'a')`);
  const r = await postQuery(`TRUNCATE TABLE \`${DATASET}.${t}\``);
  const jobRes = await fetch(`${server.url}/projects/${PROJECT}/jobs/${r.jobReference.jobId}`);
  const job = (await jobRes.json()) as {
    statistics: {
      numDmlAffectedRows?: string;
      query: { statementType: string; dmlStats?: unknown };
    };
  };
  assert.equal(job.statistics.query.statementType, 'TRUNCATE_TABLE');
  assert.equal(job.statistics.numDmlAffectedRows, '1');
  // Like MERGE, TRUNCATE doesn't have a per-branch dmlStats bucket.
  assert.equal(job.statistics.query.dmlStats, undefined);
});

/**
 * BL-062 — Multi-statement transactions: BEGIN / COMMIT / ROLLBACK.
 *
 * BQ submits transactional scripts as a single query containing
 * BEGIN [TRANSACTION] / ... / COMMIT|ROLLBACK separated by semicolons.
 * detectStatementType classifies the leading BEGIN as 'SCRIPT'; the
 * dedicated path runs the whole string in one shot through DuckDB
 * (which executes the statements atomically as a transaction) and emits
 * an empty wire response with statementType='SCRIPT'.
 *
 * BQ's scripting model has child jobs per inner statement that we
 * don't represent in v0 — but the canonical rollback acceptance still
 * holds: BEGIN/INSERT/ROLLBACK doesn't change the underlying rows.
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
const PROJECT = 'sql-tx';
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
          { name: 'id', type: 'INT64' },
          { name: 'v', type: 'STRING' },
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
// Canonical rollback acceptance
// ---------------------------------------------------------------------------

test('BEGIN ... INSERT ... ROLLBACK leaves the table unchanged', async () => {
  const t = await freshTable();
  await postQuery(`INSERT INTO \`${DATASET}.${t}\` VALUES (1, 'a')`);
  assert.equal(await countRows(t), 1);

  const r = await postQuery(`
    BEGIN TRANSACTION;
    INSERT INTO \`${DATASET}.${t}\` VALUES (2, 'b');
    INSERT INTO \`${DATASET}.${t}\` VALUES (3, 'c');
    ROLLBACK;
  `);
  assert.equal(r.schema, undefined);
  assert.equal(r.rows, undefined);
  assert.equal(r.numDmlAffectedRows, undefined);

  assert.equal(await countRows(t), 1);
});

// ---------------------------------------------------------------------------
// COMMIT path: changes are durable after
// ---------------------------------------------------------------------------

test('BEGIN ... INSERT ... COMMIT persists the changes', async () => {
  const t = await freshTable();
  await postQuery(`
    BEGIN TRANSACTION;
    INSERT INTO \`${DATASET}.${t}\` VALUES (1, 'a'), (2, 'b'), (3, 'c');
    COMMIT;
  `);
  assert.equal(await countRows(t), 3);
});

// ---------------------------------------------------------------------------
// Bare BEGIN (no TRANSACTION keyword) is also accepted
// ---------------------------------------------------------------------------

test('COMMIT TRANSACTION is the explicit commit form (alternative spelling)', async () => {
  // BQ accepts both COMMIT and COMMIT TRANSACTION. Verify the long form works.
  const t = await freshTable();
  await postQuery(`
    BEGIN TRANSACTION;
    INSERT INTO \`${DATASET}.${t}\` VALUES (1, 'a');
    COMMIT TRANSACTION;
  `);
  assert.equal(await countRows(t), 1);
});

// ---------------------------------------------------------------------------
// Persisted job carries statementType=SCRIPT
// ---------------------------------------------------------------------------

test('persisted job has statementType=SCRIPT; no DML stats', async () => {
  const t = await freshTable();
  const r = await postQuery(`
    BEGIN TRANSACTION;
    INSERT INTO \`${DATASET}.${t}\` VALUES (1, 'a');
    COMMIT;
  `);
  const jobRes = await fetch(`${server.url}/projects/${PROJECT}/jobs/${r.jobReference.jobId}`);
  const job = (await jobRes.json()) as {
    statistics: {
      numDmlAffectedRows?: string;
      query: { statementType: string; dmlStats?: unknown };
    };
  };
  assert.equal(job.statistics.query.statementType, 'SCRIPT');
  assert.equal(job.statistics.numDmlAffectedRows, undefined);
  assert.equal(job.statistics.query.dmlStats, undefined);
});

// ---------------------------------------------------------------------------
// Mid-script error rolls everything back (DuckDB's atomic-transaction default)
// ---------------------------------------------------------------------------

test('an error inside the transaction prevents earlier changes from persisting', async () => {
  const t = await freshTable();
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `
        BEGIN TRANSACTION;
        INSERT INTO \`${DATASET}.${t}\` VALUES (1, 'a');
        INSERT INTO \`${DATASET}.does_not_exist\` VALUES (2, 'b');
        COMMIT;
      `,
    }),
  });
  assert.equal(res.status, 400);
  // The failing statement aborts the script; the prior insert isn't durable.
  assert.equal(await countRows(t), 0);
});

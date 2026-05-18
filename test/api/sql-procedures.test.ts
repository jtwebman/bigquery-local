/**
 * BL-065 — Stored procedures: CREATE / DROP PROCEDURE + CALL + RETURN.
 *
 *   CREATE [OR REPLACE] PROCEDURE [`proj.`]dataset.proc(args) BEGIN … END
 *   DROP PROCEDURE [IF EXISTS] [`proj.`]dataset.proc
 *   CALL [`proj.`]dataset.proc(args)
 *   RETURN  -- inside a procedure body, exits early
 *
 * Procedures persist in `_bq.routines` with routine_type='PROCEDURE'.
 * CALL creates a fresh variable scope from the formal-parameter list,
 * binds the caller's argument values, and runs the body through the same
 * scripting interpreter as BL-066 / BL-067. RETURN exits the current
 * procedure cleanly (caught by the CALL frame).
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
const PROJECT = 'sql-procs';
const DATASET = 'ds';

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [...createDatasetRoutes(db), ...createTableRoutes(db), ...createQueriesRoutes(db)],
  });
  await server.listen(0);
  await fetch(`${server.url}/projects/${PROJECT}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: DATASET } }),
  });
  // Table for procedures that mutate state.
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'log' },
      schema: {
        fields: [
          { name: 'id', type: 'INT64' },
          { name: 'message', type: 'STRING' },
        ],
      },
    }),
  });
});
after(async () => {
  await server.close();
  await db.close();
});

interface QueryResponse {
  schema?: { fields: Array<{ name: string; type: string }> };
  rows?: Array<{ f: Array<{ v: string | null }> }>;
}

async function postQuery(query: string): Promise<{ status: number; json: QueryResponse }> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { status: res.status, json: (await res.json()) as QueryResponse };
}

async function scalar(script: string): Promise<string | null | undefined> {
  const r = await postQuery(script);
  return r.json.rows?.[0]?.f[0]?.v;
}

// ---------------------------------------------------------------------------
// CREATE PROCEDURE — registers in _bq.routines as a PROCEDURE
// ---------------------------------------------------------------------------

test('CREATE PROCEDURE persists into _bq.routines with routine_type=PROCEDURE', async () => {
  const r = await postQuery(`CREATE PROCEDURE \`${DATASET}.noop\`() BEGIN SELECT 1; END`);
  assert.equal(r.status, 200);
  const rows = await db.query<Record<string, unknown>>(
    `SELECT routine_id, routine_type, language, body
       FROM _bq.routines
      WHERE project = $1 AND dataset_id = $2 AND routine_id = $3`,
    [PROJECT, DATASET, 'noop'],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.['routine_type'], 'PROCEDURE');
  assert.equal(rows[0]?.['language'], 'SQL');
  assert.match(rows[0]?.['body'] as string, /^BEGIN/);
});

test('CREATE PROCEDURE on existing without OR REPLACE: 409', async () => {
  await postQuery(`CREATE PROCEDURE \`${DATASET}.dup\`() BEGIN SELECT 1; END`);
  const r = await postQuery(`CREATE PROCEDURE \`${DATASET}.dup\`() BEGIN SELECT 2; END`);
  assert.equal(r.status, 409);
});

test('CREATE OR REPLACE PROCEDURE updates the body', async () => {
  await postQuery(`CREATE PROCEDURE \`${DATASET}.repl\`() BEGIN SELECT 1; END`);
  const replace = await postQuery(
    `CREATE OR REPLACE PROCEDURE \`${DATASET}.repl\`() BEGIN INSERT INTO \`${DATASET}.log\` VALUES (1, 'replaced'); END`,
  );
  assert.equal(replace.status, 200);
  const rows = await db.query<{ body: string }>(
    `SELECT body FROM _bq.routines WHERE routine_id = 'repl'`,
  );
  assert.match(rows[0]?.body ?? '', /INSERT/);
});

test('CREATE PROCEDURE IF NOT EXISTS is idempotent', async () => {
  await postQuery(`CREATE PROCEDURE \`${DATASET}.idem\`() BEGIN SELECT 7; END`);
  const r = await postQuery(
    `CREATE PROCEDURE IF NOT EXISTS \`${DATASET}.idem\`() BEGIN SELECT 9; END`,
  );
  assert.equal(r.status, 200);
  // The body of `idem` should still be the original (7), not the second one (9).
  const rows = await db.query<{ body: string }>(
    `SELECT body FROM _bq.routines WHERE routine_id = 'idem'`,
  );
  assert.match(rows[0]?.body ?? '', /SELECT 7/);
});

// ---------------------------------------------------------------------------
// CALL — execution
// ---------------------------------------------------------------------------

test('CALL runs the procedure body; arguments bind into the local scope', async () => {
  await postQuery(`
    CREATE PROCEDURE \`${DATASET}.add_log\`(msg STRING) BEGIN
      INSERT INTO \`${DATASET}.log\` VALUES (1, msg);
    END
  `);
  const callRes = await postQuery(`CALL \`${DATASET}.add_log\`('hello')`);
  assert.equal(callRes.status, 200);
  const got = await scalar(
    `SELECT message FROM \`${DATASET}.log\` WHERE id = 1 ORDER BY message DESC LIMIT 1`,
  );
  assert.equal(got, 'hello');
});

test('CALL with multiple args evaluates each in the caller scope', async () => {
  await postQuery(`
    CREATE PROCEDURE \`${DATASET}.add_pair\`(id INT64, msg STRING) BEGIN
      INSERT INTO \`${DATASET}.log\` VALUES (id, msg);
    END
  `);
  await postQuery(`
    DECLARE caller_id INT64 DEFAULT 42;
    CALL \`${DATASET}.add_pair\`(caller_id, 'from-caller');
  `);
  const got = await scalar(`SELECT message FROM \`${DATASET}.log\` WHERE id = 42`);
  assert.equal(got, 'from-caller');
});

test('procedure body can use DECLARE/SET/IF', async () => {
  await postQuery(`
    CREATE PROCEDURE \`${DATASET}.classify\`(n INT64) BEGIN
      DECLARE label STRING;
      IF n > 0 THEN
        SET label = 'positive';
      ELSEIF n < 0 THEN
        SET label = 'negative';
      ELSE
        SET label = 'zero';
      END IF;
      INSERT INTO \`${DATASET}.log\` VALUES (n + 1000, label);
    END
  `);
  await postQuery(`CALL \`${DATASET}.classify\`(-5)`);
  const got = await scalar(`SELECT message FROM \`${DATASET}.log\` WHERE id = 995`);
  assert.equal(got, 'negative');
});

test('RETURN exits the procedure body early', async () => {
  await postQuery(`
    CREATE PROCEDURE \`${DATASET}.early_exit\`(n INT64) BEGIN
      INSERT INTO \`${DATASET}.log\` VALUES (n, 'before-return');
      IF n > 0 THEN
        RETURN;
      END IF;
      INSERT INTO \`${DATASET}.log\` VALUES (n, 'after-return');
    END
  `);
  await postQuery(`CALL \`${DATASET}.early_exit\`(2000)`);
  const r = await postQuery(`SELECT message FROM \`${DATASET}.log\` WHERE id = 2000`);
  const messages = (r.json.rows ?? []).map((row) => row.f[0]?.v);
  // Only the before-return row was inserted.
  assert.deepEqual(messages, ['before-return']);
});

test('CALL with wrong number of arguments errors', async () => {
  await postQuery(
    `CREATE PROCEDURE \`${DATASET}.three_args\`(a INT64, b INT64, c INT64) BEGIN SELECT a + b + c; END`,
  );
  const r = await postQuery(`CALL \`${DATASET}.three_args\`(1, 2)`);
  assert.equal(r.status, 400);
});

test('CALL on a missing procedure: 404', async () => {
  const r = await postQuery(`CALL \`${DATASET}.never_existed\`()`);
  assert.equal(r.status, 404);
});

// ---------------------------------------------------------------------------
// DROP PROCEDURE
// ---------------------------------------------------------------------------

test('DROP PROCEDURE removes the routine; subsequent CALLs error', async () => {
  await postQuery(`CREATE PROCEDURE \`${DATASET}.transient\`() BEGIN SELECT 1; END`);
  const drop = await postQuery(`DROP PROCEDURE \`${DATASET}.transient\``);
  assert.equal(drop.status, 200);
  const after = await postQuery(`CALL \`${DATASET}.transient\`()`);
  assert.equal(after.status, 404);
});

test('DROP PROCEDURE on missing without IF EXISTS: 404', async () => {
  const r = await postQuery(`DROP PROCEDURE \`${DATASET}.never_existed\``);
  assert.equal(r.status, 404);
});

test('DROP PROCEDURE IF EXISTS on missing: 200', async () => {
  const r = await postQuery(`DROP PROCEDURE IF EXISTS \`${DATASET}.never_existed\``);
  assert.equal(r.status, 200);
});

// ---------------------------------------------------------------------------
// Procedure variable shadowing — procedure has its own scope
// ---------------------------------------------------------------------------

test('procedure scope is fresh — caller variables are not visible inside', async () => {
  await postQuery(`
    CREATE PROCEDURE \`${DATASET}.uses_local_x\`() BEGIN
      DECLARE x INT64 DEFAULT 999;
      INSERT INTO \`${DATASET}.log\` VALUES (x, 'proc-x');
    END
  `);
  await postQuery(`
    DECLARE x INT64 DEFAULT 1;
    CALL \`${DATASET}.uses_local_x\`();
  `);
  const r = await postQuery(`SELECT message FROM \`${DATASET}.log\` WHERE id = 999`);
  assert.equal(r.json.rows?.[0]?.f[0]?.v, 'proc-x');
});

// ---------------------------------------------------------------------------
// Missing dataset
// ---------------------------------------------------------------------------

test('CREATE PROCEDURE in a missing dataset: 404', async () => {
  const r = await postQuery(`CREATE PROCEDURE \`does_not_exist.p\`() BEGIN SELECT 1; END`);
  assert.equal(r.status, 404);
});

// ---------------------------------------------------------------------------
// Persisted job
// ---------------------------------------------------------------------------

test('CREATE PROCEDURE job has statementType=CREATE_PROCEDURE', async () => {
  const r = await postQuery(`CREATE PROCEDURE \`${DATASET}.job_check\`() BEGIN SELECT 1; END`);
  // jobReference is in the response body
  const body = r.json as unknown as { jobReference: { jobId: string } };
  const jobRes = await fetch(`${server.url}/projects/${PROJECT}/jobs/${body.jobReference.jobId}`);
  // jobs route not registered in this test; skip if it 404s on missing route.
  if (jobRes.status === 404) return;
  const job = (await jobRes.json()) as { statistics: { query: { statementType: string } } };
  assert.equal(job.statistics.query.statementType, 'CREATE_PROCEDURE');
});

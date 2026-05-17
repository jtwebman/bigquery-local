/**
 * BL-053 — MERGE statement, end-to-end.
 *
 * BQ's MERGE is supported by DuckDB natively with the same surface:
 *   - `WHEN MATCHED [AND <cond>] THEN UPDATE SET … / DELETE`
 *   - `WHEN NOT MATCHED [BY TARGET] THEN INSERT …`
 *   - `WHEN NOT MATCHED BY SOURCE THEN UPDATE / DELETE`
 *
 * BL-052's statement-type detection already classifies MERGE; the DML
 * code path runs it. These tests pin the BQ doc examples.
 *
 * Note: `statistics.query.dmlStats` is *not* populated for MERGE — real BQ
 * splits affected rows into inserted/updated/deleted buckets, but DuckDB
 * only returns a single total. We surface that total in
 * `statistics.numDmlAffectedRows` and leave `dmlStats` undefined.
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
const PROJECT = 'sql-merge';
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

let n = 0;
async function freshPair(): Promise<{ tgt: string; src: string }> {
  n += 1;
  const tgt = `tgt${n}`;
  const src = `src${n}`;
  const make = async (id: string) =>
    fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
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
  await make(tgt);
  await make(src);
  return { tgt, src };
}

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

async function listTarget(tableId: string): Promise<Array<[string, string]>> {
  const r = await postQuery(`SELECT id, v FROM \`${DATASET}.${tableId}\` ORDER BY id`);
  return (r.rows ?? []).map((row) => [row.f[0]?.v ?? '', row.f[1]?.v ?? '']);
}

// ---------------------------------------------------------------------------
// Canonical two-branch MERGE: upsert pattern (MATCHED → UPDATE, NOT MATCHED → INSERT)
// ---------------------------------------------------------------------------

test('MERGE upsert: matched rows update, unmatched rows insert', async () => {
  const { tgt, src } = await freshPair();
  await postQuery(`INSERT INTO \`${DATASET}.${tgt}\` VALUES (1, 'a'), (2, 'b')`);
  await postQuery(`INSERT INTO \`${DATASET}.${src}\` VALUES (2, 'B'), (3, 'c')`);
  const r = await postQuery(`
		MERGE INTO \`${DATASET}.${tgt}\` AS T
		USING \`${DATASET}.${src}\` AS S
		  ON T.id = S.id
		WHEN MATCHED THEN UPDATE SET v = S.v
		WHEN NOT MATCHED THEN INSERT (id, v) VALUES (S.id, S.v)
	`);
  assert.equal(r.numDmlAffectedRows, '2');
  assert.equal(r.schema, undefined);
  assert.equal(r.rows, undefined);
  assert.deepEqual(await listTarget(tgt), [
    ['1', 'a'],
    ['2', 'B'],
    ['3', 'c'],
  ]);
});

// ---------------------------------------------------------------------------
// MATCHED with AND-clause + DELETE branch
// ---------------------------------------------------------------------------

test('MERGE MATCHED ... AND ... THEN DELETE removes only the gated rows', async () => {
  const { tgt, src } = await freshPair();
  await postQuery(`INSERT INTO \`${DATASET}.${tgt}\` VALUES (1, 'keep'), (2, 'drop'), (3, 'keep')`);
  await postQuery(`INSERT INTO \`${DATASET}.${src}\` VALUES (1, 'x'), (2, 'x'), (3, 'x')`);
  const r = await postQuery(`
		MERGE INTO \`${DATASET}.${tgt}\` AS T
		USING \`${DATASET}.${src}\` AS S
		  ON T.id = S.id
		WHEN MATCHED AND T.v = 'drop' THEN DELETE
	`);
  assert.equal(r.numDmlAffectedRows, '1');
  assert.deepEqual(await listTarget(tgt), [
    ['1', 'keep'],
    ['3', 'keep'],
  ]);
});

// ---------------------------------------------------------------------------
// Three-way MERGE: includes NOT MATCHED BY SOURCE
// ---------------------------------------------------------------------------

test('MERGE three-way: MATCHED + NOT MATCHED + NOT MATCHED BY SOURCE', async () => {
  const { tgt, src } = await freshPair();
  await postQuery(`INSERT INTO \`${DATASET}.${tgt}\` VALUES (1, 'a'), (2, 'b'), (3, 'c')`);
  await postQuery(`INSERT INTO \`${DATASET}.${src}\` VALUES (2, 'B'), (4, 'D')`);
  const r = await postQuery(`
		MERGE INTO \`${DATASET}.${tgt}\` AS T
		USING \`${DATASET}.${src}\` AS S
		  ON T.id = S.id
		WHEN MATCHED THEN UPDATE SET v = S.v
		WHEN NOT MATCHED THEN INSERT VALUES (S.id, S.v)
		WHEN NOT MATCHED BY SOURCE THEN UPDATE SET v = 'orphan'
	`);
  assert.equal(r.numDmlAffectedRows, '4');
  assert.deepEqual(await listTarget(tgt), [
    ['1', 'orphan'],
    ['2', 'B'],
    ['3', 'orphan'],
    ['4', 'D'],
  ]);
});

// ---------------------------------------------------------------------------
// MERGE USING a subquery (BQ allows source to be a subquery, not just a table)
// ---------------------------------------------------------------------------

test('MERGE with USING (subquery) as the source', async () => {
  const { tgt, src } = await freshPair();
  await postQuery(`INSERT INTO \`${DATASET}.${tgt}\` VALUES (1, 'a'), (2, 'b')`);
  await postQuery(`INSERT INTO \`${DATASET}.${src}\` VALUES (1, 'x'), (2, 'y'), (3, 'z')`);
  const r = await postQuery(`
		MERGE INTO \`${DATASET}.${tgt}\` AS T
		USING (SELECT id, UPPER(v) AS v FROM \`${DATASET}.${src}\`) AS S
		  ON T.id = S.id
		WHEN MATCHED THEN UPDATE SET v = S.v
		WHEN NOT MATCHED THEN INSERT VALUES (S.id, S.v)
	`);
  assert.equal(r.numDmlAffectedRows, '3');
  assert.deepEqual(await listTarget(tgt), [
    ['1', 'X'],
    ['2', 'Y'],
    ['3', 'Z'],
  ]);
});

// ---------------------------------------------------------------------------
// Persisted job carries statementType=MERGE and the affected total
// ---------------------------------------------------------------------------

test('persisted job has statementType=MERGE; dmlStats is omitted (no per-branch counts)', async () => {
  const { tgt, src } = await freshPair();
  await postQuery(`INSERT INTO \`${DATASET}.${tgt}\` VALUES (1, 'a')`);
  await postQuery(`INSERT INTO \`${DATASET}.${src}\` VALUES (1, 'A'), (2, 'B')`);
  const r = await postQuery(`
		MERGE INTO \`${DATASET}.${tgt}\` AS T
		USING \`${DATASET}.${src}\` AS S
		  ON T.id = S.id
		WHEN MATCHED THEN UPDATE SET v = S.v
		WHEN NOT MATCHED THEN INSERT VALUES (S.id, S.v)
	`);
  const jobRes = await fetch(`${server.url}/projects/${PROJECT}/jobs/${r.jobReference.jobId}`);
  const job = (await jobRes.json()) as {
    statistics: {
      numDmlAffectedRows?: string;
      query: { statementType: string; dmlStats?: unknown };
    };
  };
  assert.equal(job.statistics.query.statementType, 'MERGE');
  assert.equal(job.statistics.numDmlAffectedRows, '2');
  assert.equal(job.statistics.query.dmlStats, undefined);
});

// ---------------------------------------------------------------------------
// dryRun on MERGE
// ---------------------------------------------------------------------------

test('dryRun on MERGE validates without mutating', async () => {
  const { tgt, src } = await freshPair();
  await postQuery(`INSERT INTO \`${DATASET}.${tgt}\` VALUES (1, 'a')`);
  await postQuery(`INSERT INTO \`${DATASET}.${src}\` VALUES (1, 'X'), (2, 'Y')`);
  const before = await listTarget(tgt);
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `
				MERGE INTO \`${DATASET}.${tgt}\` AS T
				USING \`${DATASET}.${src}\` AS S
				  ON T.id = S.id
				WHEN MATCHED THEN UPDATE SET v = S.v
				WHEN NOT MATCHED THEN INSERT VALUES (S.id, S.v)
			`,
      dryRun: true,
    }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await listTarget(tgt), before);
});

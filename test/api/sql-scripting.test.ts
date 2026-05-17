/**
 * BL-066 — BQ scripting: DECLARE / SET / IF.
 *
 * All examples are drawn from BigQuery's scripting documentation. The
 * interpreter (src/sql/script.ts) walks the script's statements, maintains
 * a flat variable scope, and dispatches plain SQL to DuckDB after
 * variable references are substituted as `$N` placeholders.
 *
 * Reference: https://cloud.google.com/bigquery/docs/reference/standard-sql/procedural-language
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
const PROJECT = 'sql-script';
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
      tableReference: { tableId: 'events' },
      schema: {
        fields: [
          { name: 'id', type: 'INT64' },
          { name: 'category', type: 'STRING' },
        ],
      },
    }),
  });
  await postQuery(
    `INSERT INTO \`${DATASET}.events\` VALUES (1, 'a'), (2, 'b'), (3, 'a'), (4, 'c'), (5, 'a')`,
  );
});
after(async () => {
  await server.close();
  await db.close();
});

interface QueryResponse {
  jobReference: { jobId: string };
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

async function lastSelectValue(script: string): Promise<string | null | undefined> {
  const r = await postQuery(script);
  return r.json.rows?.[0]?.f[0]?.v;
}

// ---------------------------------------------------------------------------
// DECLARE — simple cases
// ---------------------------------------------------------------------------

test('DECLARE INT64 DEFAULT then SELECT returns the declared value', async () => {
  const v = await lastSelectValue(`
    DECLARE x INT64 DEFAULT 42;
    SELECT x;
  `);
  assert.equal(v, '42');
});

test('DECLARE STRING with quoted default', async () => {
  const v = await lastSelectValue(`
    DECLARE name STRING DEFAULT 'jt';
    SELECT name;
  `);
  assert.equal(v, 'jt');
});

test('DECLARE without DEFAULT initializes to NULL', async () => {
  // Note: BOOL wire encoding in this codebase returns a JS boolean, not the
  // BQ docs' string `"true"`. That's a pre-existing wire-encoding choice
  // outside the scope of BL-066; the test asserts what the codebase does.
  const v = await lastSelectValue(`
    DECLARE x INT64;
    SELECT x IS NULL AS is_null;
  `);
  assert.equal(v, true);
});

test('DECLARE multiple variables of the same type with a shared default', async () => {
  const r = await postQuery(`
    DECLARE a, b, c INT64 DEFAULT 5;
    SELECT a, b, c;
  `);
  const row = r.json.rows?.[0]?.f.map((f) => f.v);
  assert.deepEqual(row, ['5', '5', '5']);
});

test('DECLARE DATE with quoted-string default coerces to DATE', async () => {
  const r = await postQuery(`
    DECLARE d DATE DEFAULT '2026-01-15';
    SELECT d;
  `);
  assert.equal(r.json.rows?.[0]?.f[0]?.v, '2026-01-15');
  assert.equal(r.json.schema?.fields[0]?.type, 'DATE');
});

// ---------------------------------------------------------------------------
// SET — scalar, parallel, from subquery
// ---------------------------------------------------------------------------

test('SET <var> = <expr> updates the variable', async () => {
  const v = await lastSelectValue(`
    DECLARE x INT64 DEFAULT 10;
    SET x = x * 2 + 1;
    SELECT x;
  `);
  assert.equal(v, '21');
});

test('SET (a, b) = (e1, e2) parallel-assigns', async () => {
  const r = await postQuery(`
    DECLARE a INT64;
    DECLARE b INT64;
    SET (a, b) = (10, 20);
    SELECT a, b;
  `);
  assert.deepEqual(
    r.json.rows?.[0]?.f.map((f) => f.v),
    ['10', '20'],
  );
});

test('SET (a, b) = (b, a) swaps atomically (BQ doc example)', async () => {
  const r = await postQuery(`
    DECLARE a INT64 DEFAULT 1;
    DECLARE b INT64 DEFAULT 2;
    SET (a, b) = (b, a);
    SELECT a, b;
  `);
  assert.deepEqual(
    r.json.rows?.[0]?.f.map((f) => f.v),
    ['2', '1'],
  );
});

test('SET var = (SELECT scalar) pulls a single value out of a subquery', async () => {
  const v = await lastSelectValue(`
    DECLARE total INT64;
    SET total = (SELECT COUNT(*) FROM \`${DATASET}.events\`);
    SELECT total;
  `);
  assert.equal(v, '5');
});

test('SET (a, b) = (SELECT col1, col2) destructures a single-row result', async () => {
  const r = await postQuery(`
    DECLARE first_id INT64;
    DECLARE first_cat STRING;
    SET (first_id, first_cat) = (SELECT id, category FROM \`${DATASET}.events\` ORDER BY id LIMIT 1);
    SELECT first_id, first_cat;
  `);
  assert.deepEqual(
    r.json.rows?.[0]?.f.map((f) => f.v),
    ['1', 'a'],
  );
});

// ---------------------------------------------------------------------------
// IF / ELSEIF / ELSE / END IF
// ---------------------------------------------------------------------------

test('IF cond THEN ... END IF runs the body when true', async () => {
  const v = await lastSelectValue(`
    DECLARE label STRING DEFAULT 'before';
    IF 1 = 1 THEN
      SET label = 'matched';
    END IF;
    SELECT label;
  `);
  assert.equal(v, 'matched');
});

test('IF cond THEN ... END IF skips the body when false', async () => {
  const v = await lastSelectValue(`
    DECLARE label STRING DEFAULT 'before';
    IF 1 = 2 THEN
      SET label = 'matched';
    END IF;
    SELECT label;
  `);
  assert.equal(v, 'before');
});

test('IF / ELSEIF / ELSE picks the right branch (BQ doc example)', async () => {
  const make = (n: number) => `
    DECLARE n INT64 DEFAULT ${n};
    DECLARE label STRING;
    IF n > 0 THEN
      SET label = 'positive';
    ELSEIF n < 0 THEN
      SET label = 'negative';
    ELSE
      SET label = 'zero';
    END IF;
    SELECT label;
  `;
  assert.equal(await lastSelectValue(make(7)), 'positive');
  assert.equal(await lastSelectValue(make(-3)), 'negative');
  assert.equal(await lastSelectValue(make(0)), 'zero');
});

test('IF condition uses a variable in scope', async () => {
  const v = await lastSelectValue(`
    DECLARE x INT64 DEFAULT 100;
    DECLARE tag STRING;
    IF x > 50 THEN
      SET tag = 'big';
    ELSE
      SET tag = 'small';
    END IF;
    SELECT tag;
  `);
  assert.equal(v, 'big');
});

// ---------------------------------------------------------------------------
// BEGIN ... END block
// ---------------------------------------------------------------------------

test('BEGIN ... END block runs its statements', async () => {
  const v = await lastSelectValue(`
    DECLARE x INT64 DEFAULT 1;
    BEGIN
      SET x = x + 100;
    END;
    SELECT x;
  `);
  assert.equal(v, '101');
});

// ---------------------------------------------------------------------------
// Mixed: variables inside regular SQL (the substitution path)
// ---------------------------------------------------------------------------

test('regular SQL inside a script can reference a script variable', async () => {
  const v = await lastSelectValue(`
    DECLARE cat STRING DEFAULT 'a';
    SELECT COUNT(*) FROM \`${DATASET}.events\` WHERE category = cat;
  `);
  assert.equal(v, '3');
});

test('INSERT inside a script honors a script variable', async () => {
  await postQuery(`
    DECLARE new_id INT64 DEFAULT 100;
    DECLARE new_cat STRING DEFAULT 'inserted';
    INSERT INTO \`${DATASET}.events\` VALUES (new_id, new_cat);
  `);
  const v = await lastSelectValue(`SELECT category FROM \`${DATASET}.events\` WHERE id = 100`);
  assert.equal(v, 'inserted');
});

// ---------------------------------------------------------------------------
// Variable substitution doesn't touch column refs that happen to match
// ---------------------------------------------------------------------------

test('qualified column ref (t.col) is not substituted with a same-named variable', async () => {
  // A variable called `category` exists; the qualified column ref `e.category`
  // must keep referring to the table column, not the variable.
  const r = await postQuery(`
    DECLARE category STRING DEFAULT 'a';
    SELECT e.category FROM \`${DATASET}.events\` AS e WHERE e.id = 2;
  `);
  // Row with id=2 has category='b'; if we'd mistakenly substituted the var,
  // this would have returned 'a' or errored.
  assert.equal(r.json.rows?.[0]?.f[0]?.v, 'b');
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

test('referring to an undeclared variable in SET errors', async () => {
  const r = await postQuery(`SET nope = 1;`);
  assert.equal(r.status, 400);
});

test('declaring the same variable twice in one scope errors', async () => {
  const r = await postQuery(`
    DECLARE x INT64 DEFAULT 1;
    DECLARE x INT64 DEFAULT 2;
  `);
  assert.equal(r.status, 400);
});

test('SET (a, b) = (SELECT ...) with a multi-row source errors', async () => {
  const r = await postQuery(`
    DECLARE a INT64;
    DECLARE b INT64;
    SET (a, b) = (SELECT id, id FROM \`${DATASET}.events\`);
  `);
  assert.equal(r.status, 400);
});

test('SET (a, b) = (SELECT one_column) with column-count mismatch errors', async () => {
  const r = await postQuery(`
    DECLARE a INT64;
    DECLARE b INT64;
    SET (a, b) = (SELECT 1);
  `);
  assert.equal(r.status, 400);
});

test('SET (a, b) = (e1) with arity mismatch errors', async () => {
  const r = await postQuery(`
    DECLARE a INT64;
    DECLARE b INT64;
    SET (a, b) = (1);
  `);
  assert.equal(r.status, 400);
});

test('SET to an undeclared variable in a tuple errors', async () => {
  const r = await postQuery(`
    DECLARE a INT64;
    SET (a, not_declared) = (1, 2);
  `);
  assert.equal(r.status, 400);
});

test('IF without END IF errors with a clear message', async () => {
  const r = await postQuery(`
    DECLARE x INT64 DEFAULT 1;
    IF x > 0 THEN
      SET x = 99;
    -- missing END IF
  `);
  assert.equal(r.status, 400);
});

test('expression evaluation surfaces DuckDB errors as 400', async () => {
  // Type-incompatible default → DuckDB errors on the CAST.
  const r = await postQuery(`DECLARE n INT64 DEFAULT 'not-a-number';`);
  assert.equal(r.status, 400);
});

test('TIMESTAMP variable: store and re-bind survives round-trip', async () => {
  const r = await postQuery(`
    DECLARE t TIMESTAMP DEFAULT TIMESTAMP '2026-05-17 10:30:00 UTC';
    SELECT EXTRACT(YEAR FROM t) AS yr;
  `);
  assert.equal(r.json.rows?.[0]?.f[0]?.v, '2026');
});

test('an unrelated variable name inside a string literal is not substituted', async () => {
  const r = await postQuery(`
    DECLARE category STRING DEFAULT 'a';
    SELECT 'literal category text' AS s;
  `);
  // The literal contains the word `category` but we should NOT substitute
  // inside string tokens — verify by checking the value is preserved.
  assert.equal(r.json.rows?.[0]?.f[0]?.v, 'literal category text');
});

test('BEGIN ... END nesting: inner SET sees outer DECLARE', async () => {
  const r = await postQuery(`
    DECLARE counter INT64 DEFAULT 0;
    BEGIN
      SET counter = counter + 10;
      BEGIN
        SET counter = counter + 100;
      END;
    END;
    SELECT counter;
  `);
  assert.equal(r.json.rows?.[0]?.f[0]?.v, '110');
});

// ---------------------------------------------------------------------------
// Persisted job
// ---------------------------------------------------------------------------

test('persisted script job has statementType=SCRIPT and last-SELECT rows persisted', async () => {
  const r = await postQuery(`
    DECLARE x INT64 DEFAULT 7;
    SELECT x AS the_value;
  `);
  const jobRes = await fetch(`${server.url}/projects/${PROJECT}/jobs/${r.json.jobReference.jobId}`);
  const job = (await jobRes.json()) as {
    statistics: { query: { statementType: string; schema?: { fields: unknown[] } } };
  };
  assert.equal(job.statistics.query.statementType, 'SCRIPT');
  // The last SELECT's schema is recorded on the job.
  assert.equal(
    (job.statistics.query.schema?.fields[0] as { name: string } | undefined)?.name,
    'the_value',
  );
});

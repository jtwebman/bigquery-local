/**
 * BL-068 — EXECUTE IMMEDIATE: dynamic SQL execution.
 *
 *   EXECUTE IMMEDIATE <sql_expr>
 *   EXECUTE IMMEDIATE <sql_expr> INTO <var1>, <var2>, ...
 *   EXECUTE IMMEDIATE <sql_expr> USING <expr> [AS <name>], ...
 *   EXECUTE IMMEDIATE <sql_expr> INTO ... USING ...
 *
 * The SQL-text expression evaluates in the current scope (so it can use
 * script variables and built-in string functions like FORMAT to build the
 * SQL dynamically). USING supplies parameter values:
 *   - `?` placeholders bind positionally to USING values in order
 *   - `@name` placeholders bind to USING values marked `AS name`
 * INTO captures the result of a single-row SELECT into the listed script
 * variables.
 *
 * Reference: https://cloud.google.com/bigquery/docs/reference/standard-sql/procedural-language#execute_immediate
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
const PROJECT = 'sql-exec-imm';
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
  await fetch(`${server.url}/projects/${PROJECT}/datasets/${DATASET}/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'items' },
      schema: {
        fields: [
          { name: 'id', type: 'INT64' },
          { name: 'name', type: 'STRING' },
        ],
      },
    }),
  });
  await postQuery(`INSERT INTO \`${DATASET}.items\` VALUES (1, 'a'), (2, 'b'), (3, 'c')`);
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
// Bare EXECUTE IMMEDIATE
// ---------------------------------------------------------------------------

test('EXECUTE IMMEDIATE with a string literal runs the SQL', async () => {
  // Single quotes inside a single-quoted SQL string are doubled (SQL standard).
  await postQuery(`EXECUTE IMMEDIATE 'INSERT INTO \`${DATASET}.items\` VALUES (100, ''imm'')';`);
  const v = await scalar(`SELECT name FROM \`${DATASET}.items\` WHERE id = 100`);
  assert.equal(v, 'imm');
});

test('EXECUTE IMMEDIATE with FORMAT() builds the SQL string dynamically (BQ doc example)', async () => {
  const v = await scalar(`
    DECLARE table_name STRING DEFAULT '${DATASET}.items';
    DECLARE row_count INT64;
    EXECUTE IMMEDIATE FORMAT('SELECT COUNT(*) FROM \`%s\`', table_name) INTO row_count;
    SELECT row_count;
  `);
  // 3 seed rows + the 'imm' row from the previous test = 4. Tests share
  // state in this suite (only one `before`), so account for it.
  assert.equal(v, '4');
});

// ---------------------------------------------------------------------------
// INTO — capture single-row SELECT into script variables
// ---------------------------------------------------------------------------

test('EXECUTE IMMEDIATE INTO single-var captures a scalar result', async () => {
  const v = await scalar(`
    DECLARE max_id INT64;
    EXECUTE IMMEDIATE 'SELECT MAX(id) FROM \`${DATASET}.items\`' INTO max_id;
    SELECT max_id;
  `);
  assert.equal(v, '100');
});

test('EXECUTE IMMEDIATE INTO multiple vars destructures a single-row result', async () => {
  const r = await postQuery(`
    DECLARE row_id INT64;
    DECLARE row_name STRING;
    EXECUTE IMMEDIATE 'SELECT id, name FROM \`${DATASET}.items\` ORDER BY id LIMIT 1'
      INTO row_id, row_name;
    SELECT row_id, row_name;
  `);
  assert.deepEqual(
    r.json.rows?.[0]?.f.map((f) => f.v),
    ['1', 'a'],
  );
});

test('EXECUTE IMMEDIATE INTO with a multi-row source errors', async () => {
  const r = await postQuery(`
    DECLARE x INT64;
    EXECUTE IMMEDIATE 'SELECT id FROM \`${DATASET}.items\`' INTO x;
  `);
  assert.equal(r.status, 400);
});

// ---------------------------------------------------------------------------
// USING — positional and named placeholders
// ---------------------------------------------------------------------------

test('EXECUTE IMMEDIATE USING with named `@x` placeholder (BQ doc example)', async () => {
  const v = await scalar(`
    DECLARE total INT64;
    EXECUTE IMMEDIATE 'SELECT @x + @y' INTO total USING 10 AS x, 32 AS y;
    SELECT total;
  `);
  assert.equal(v, '42');
});

test('EXECUTE IMMEDIATE USING with positional `?` placeholders', async () => {
  const v = await scalar(`
    DECLARE result INT64;
    EXECUTE IMMEDIATE 'SELECT ? + ?' INTO result USING 7, 8;
    SELECT result;
  `);
  assert.equal(v, '15');
});

test('USING values come from caller-scope expressions', async () => {
  const v = await scalar(`
    DECLARE base INT64 DEFAULT 100;
    DECLARE doubled INT64;
    EXECUTE IMMEDIATE 'SELECT @b * 2' INTO doubled USING base AS b;
    SELECT doubled;
  `);
  assert.equal(v, '200');
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test('EXECUTE IMMEDIATE with too few USING values errors', async () => {
  const r = await postQuery(`EXECUTE IMMEDIATE 'SELECT ?, ?' USING 1;`);
  assert.equal(r.status, 400);
});

test('EXECUTE IMMEDIATE referencing @missing without USING clause errors', async () => {
  const r = await postQuery(`EXECUTE IMMEDIATE 'SELECT @missing';`);
  assert.equal(r.status, 400);
});

test('EXECUTE IMMEDIATE on invalid dynamic SQL surfaces the parser error', async () => {
  const r = await postQuery(`EXECUTE IMMEDIATE 'this is not valid SQL';`);
  assert.equal(r.status, 400);
});

test('EXECUTE IMMEDIATE expr that does not evaluate to STRING errors', async () => {
  const r = await postQuery(`EXECUTE IMMEDIATE 42;`);
  assert.equal(r.status, 400);
});

// ---------------------------------------------------------------------------
// Combined with control flow
// ---------------------------------------------------------------------------

test('EXECUTE IMMEDIATE inside an IF branch runs only when the branch is taken', async () => {
  // Insert via dynamic SQL only when n > 0. The dynamic SQL's single-quoted
  // string uses BQ's `''` doubled-quote escape for the embedded literal.
  await postQuery(`
    DECLARE n INT64 DEFAULT 1;
    IF n > 0 THEN
      EXECUTE IMMEDIATE 'INSERT INTO \`${DATASET}.items\` VALUES (200, ''cond-yes'')';
    END IF;
  `);
  assert.equal(await scalar(`SELECT name FROM \`${DATASET}.items\` WHERE id = 200`), 'cond-yes');
});

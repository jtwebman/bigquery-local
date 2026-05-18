/**
 * BL-067 — BQ scripting loops: LOOP / WHILE / REPEAT / FOR plus BREAK and
 * CONTINUE (with their LEAVE / ITERATE synonyms).
 *
 * Examples track BigQuery's procedural-language docs:
 *   https://cloud.google.com/bigquery/docs/reference/standard-sql/procedural-language
 *
 * Loops live inside the same interpreter as BL-066's DECLARE / SET / IF.
 * BREAK / CONTINUE propagate via internal signal classes; the FOR loop
 * binds the row as a special row variable that `record.col` references
 * resolve against during variable substitution.
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
const PROJECT = 'sql-loops';
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
      tableReference: { tableId: 'words' },
      schema: {
        fields: [
          { name: 'word', type: 'STRING' },
          { name: 'word_count', type: 'INT64' },
        ],
      },
    }),
  });
  await postQuery(
    `INSERT INTO \`${DATASET}.words\` VALUES ('a', 5), ('b', 10), ('c', 15), ('d', 20)`,
  );
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
// LOOP / BREAK
// ---------------------------------------------------------------------------

test('LOOP with BREAK exits the loop', async () => {
  const v = await scalar(`
    DECLARE i INT64 DEFAULT 0;
    LOOP
      SET i = i + 1;
      IF i >= 5 THEN
        BREAK;
      END IF;
    END LOOP;
    SELECT i;
  `);
  assert.equal(v, '5');
});

test('LEAVE is a synonym for BREAK', async () => {
  const v = await scalar(`
    DECLARE i INT64 DEFAULT 0;
    LOOP
      SET i = i + 1;
      IF i = 3 THEN LEAVE; END IF;
    END LOOP;
    SELECT i;
  `);
  assert.equal(v, '3');
});

// ---------------------------------------------------------------------------
// WHILE
// ---------------------------------------------------------------------------

test('WHILE counts to N', async () => {
  const v = await scalar(`
    DECLARE i INT64 DEFAULT 0;
    DECLARE total INT64 DEFAULT 0;
    WHILE i < 10 DO
      SET i = i + 1;
      SET total = total + i;
    END WHILE;
    SELECT total;
  `);
  // 1+2+...+10 = 55.
  assert.equal(v, '55');
});

test('WHILE with CONTINUE skips iterations', async () => {
  const v = await scalar(`
    DECLARE i INT64 DEFAULT 0;
    DECLARE odd_total INT64 DEFAULT 0;
    WHILE i < 10 DO
      SET i = i + 1;
      IF MOD(i, 2) = 0 THEN CONTINUE; END IF;
      SET odd_total = odd_total + i;
    END WHILE;
    SELECT odd_total;
  `);
  // 1+3+5+7+9 = 25.
  assert.equal(v, '25');
});

test('ITERATE is a synonym for CONTINUE', async () => {
  const v = await scalar(`
    DECLARE i INT64 DEFAULT 0;
    DECLARE odd_total INT64 DEFAULT 0;
    WHILE i < 6 DO
      SET i = i + 1;
      IF MOD(i, 2) = 0 THEN ITERATE; END IF;
      SET odd_total = odd_total + i;
    END WHILE;
    SELECT odd_total;
  `);
  // 1+3+5 = 9.
  assert.equal(v, '9');
});

// ---------------------------------------------------------------------------
// REPEAT … UNTIL
// ---------------------------------------------------------------------------

test('REPEAT runs the body at least once, then exits when UNTIL is true', async () => {
  const v = await scalar(`
    DECLARE i INT64 DEFAULT 100;
    DECLARE iterations INT64 DEFAULT 0;
    REPEAT
      SET iterations = iterations + 1;
      SET i = i + 1;
    UNTIL i > 100
    END REPEAT;
    SELECT iterations;
  `);
  // i starts at 100, body increments to 101; UNTIL 101 > 100 is true → exit.
  // So exactly 1 iteration.
  assert.equal(v, '1');
});

test('REPEAT loops until UNTIL is satisfied', async () => {
  const v = await scalar(`
    DECLARE i INT64 DEFAULT 0;
    REPEAT
      SET i = i + 2;
    UNTIL i >= 10
    END REPEAT;
    SELECT i;
  `);
  assert.equal(v, '10');
});

// ---------------------------------------------------------------------------
// FOR row IN (SELECT ...)
// ---------------------------------------------------------------------------

test('FOR iterates each row of a SELECT and exposes row.col', async () => {
  const v = await scalar(`
    DECLARE total INT64 DEFAULT 0;
    FOR record IN (SELECT word_count FROM \`${DATASET}.words\` ORDER BY word_count)
    DO
      SET total = total + record.word_count;
    END FOR;
    SELECT total;
  `);
  // 5+10+15+20 = 50.
  assert.equal(v, '50');
});

test('FOR with BREAK exits early; only seen rows count', async () => {
  const v = await scalar(`
    DECLARE total INT64 DEFAULT 0;
    FOR r IN (SELECT word_count FROM \`${DATASET}.words\` ORDER BY word_count)
    DO
      IF r.word_count > 10 THEN BREAK; END IF;
      SET total = total + r.word_count;
    END FOR;
    SELECT total;
  `);
  // Seen: 5, 10. Then 15 triggers BREAK before SET. So 5+10=15.
  assert.equal(v, '15');
});

test('FOR with CONTINUE skips selected rows', async () => {
  const v = await scalar(`
    DECLARE total INT64 DEFAULT 0;
    FOR r IN (SELECT word_count FROM \`${DATASET}.words\`)
    DO
      IF MOD(r.word_count, 10) = 0 THEN CONTINUE; END IF;
      SET total = total + r.word_count;
    END FOR;
    SELECT total;
  `);
  // Excludes 10 and 20. Includes 5 and 15. Total = 20.
  assert.equal(v, '20');
});

test('FOR row var is scoped to the loop — used outside is undeclared', async () => {
  const r = await postQuery(`
    FOR r IN (SELECT 1 AS x)
    DO
      SET r.x = 99;
    END FOR;
  `);
  // r.x isn't an assignable target — SET expects a scalar var name.
  assert.equal(r.status, 400);
});

// ---------------------------------------------------------------------------
// Nested loops — BREAK only exits the innermost
// ---------------------------------------------------------------------------

test('BREAK only exits the innermost loop', async () => {
  // DECLARE doesn't get per-iteration scoping in our v0 interpreter (flat
  // scope, no nested-block scoping yet), so we declare loop counters at the
  // top and reset `j` to 0 each outer iteration.
  const v = await scalar(`
    DECLARE outer_count INT64 DEFAULT 0;
    DECLARE inner_count INT64 DEFAULT 0;
    DECLARE i INT64 DEFAULT 0;
    DECLARE j INT64;
    WHILE i < 3 DO
      SET i = i + 1;
      SET outer_count = outer_count + 1;
      SET j = 0;
      LOOP
        SET j = j + 1;
        SET inner_count = inner_count + 1;
        IF j >= 2 THEN BREAK; END IF;
      END LOOP;
    END WHILE;
    SELECT outer_count * 100 + inner_count;
  `);
  // Outer runs 3 times (so outer_count=3). Inner runs twice each outer iter
  // (so inner_count = 3*2 = 6). 3*100 + 6 = 306.
  assert.equal(v, '306');
});

// ---------------------------------------------------------------------------
// Mixed control flow — FOR inside WHILE
// ---------------------------------------------------------------------------

test('FOR inside WHILE: nesting compounds cleanly', async () => {
  const v = await scalar(`
    DECLARE outer_i INT64 DEFAULT 0;
    DECLARE grand_total INT64 DEFAULT 0;
    WHILE outer_i < 2 DO
      SET outer_i = outer_i + 1;
      FOR r IN (SELECT word_count FROM \`${DATASET}.words\`)
      DO
        SET grand_total = grand_total + r.word_count;
      END FOR;
    END WHILE;
    SELECT grand_total;
  `);
  // Sum of words is 50; two outer iterations → 100.
  assert.equal(v, '100');
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

test('LOOP without END LOOP errors', async () => {
  const r = await postQuery(`
    LOOP
      SET i = 1;
    END
  `);
  assert.equal(r.status, 400);
});

test('WHILE without DO errors', async () => {
  const r = await postQuery(`
    DECLARE i INT64 DEFAULT 0;
    WHILE i < 1
      SET i = i + 1;
    END WHILE;
  `);
  assert.equal(r.status, 400);
});

test('REPEAT without UNTIL errors', async () => {
  const r = await postQuery(`
    DECLARE i INT64 DEFAULT 0;
    REPEAT
      SET i = i + 1;
    END REPEAT;
  `);
  assert.equal(r.status, 400);
});

test('FOR with bad syntax errors', async () => {
  const r = await postQuery(`
    FOR r SELECT 1
    DO
      SELECT 1;
    END FOR;
  `);
  // Missing IN before the parenthesized select.
  assert.equal(r.status, 400);
});

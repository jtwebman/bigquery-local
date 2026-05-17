/**
 * Conformance test — the schema-evolution flow that motivated this whole
 * project. Replicates a real BigQuery workload end-to-end:
 *
 *   1. createServer → listen(0)
 *   2. create dataset
 *   3. create table with initial schema (id, payload JSON, created_at TIMESTAMP)
 *   4. insertAll five rows
 *   5. PATCH the table to add a `category STRING` column (the operation
 *      that's broken in the existing emulator we were using — the bug that
 *      named this repo)
 *   6. insertAll five more rows that include the new column
 *   7. run a parameterized query exercising JSON_VALUE, TIMESTAMP_SUB,
 *      and `IN UNNEST(@arr)` against the evolved schema
 *   8. assert: exactly the expected rows come back, with the new column
 *      visible for the post-PATCH rows and NULL for the pre-PATCH rows
 *
 * Imports ONLY from `'bigquery-local'`, so a regression in the public
 * surface breaks this test even before any individual subsystem does.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { type Server, createServer } from 'bigquery-local';

const PROJECT = 'conf';
const DATASET = 'evolution';
const TABLE = 'events';

let server: Server;

// Fixed "now" so the time-window query is reproducible. 2026-05-16T12:00:00Z
const NOW_MS = 1779278400000;

// Five "old" rows inserted before the PATCH.
const OLD_ROWS = [
  { id: 'a', payload: { name: 'alpha', score: 1 } },
  { id: 'b', payload: { name: 'bravo', score: 2 } },
  { id: 'c', payload: { name: 'charlie', score: 3 } },
  { id: 'd', payload: { name: 'delta', score: 4 } },
  { id: 'e', payload: { name: 'echo', score: 5 } },
] as const;

// Five "new" rows inserted after the PATCH — these carry `category`.
const NEW_ROWS = [
  { id: 'f', payload: { name: 'foxtrot', score: 6 }, category: 'recent' },
  { id: 'g', payload: { name: 'golf', score: 7 }, category: 'recent' },
  { id: 'h', payload: { name: 'hotel', score: 8 }, category: 'archive' },
  { id: 'i', payload: { name: 'india', score: 9 }, category: 'archive' },
  { id: 'j', payload: { name: 'juliet', score: 10 }, category: 'recent' },
] as const;

function url(path: string): string {
  return `${server.url}${path}`;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(url(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patchJson(path: string, body: unknown): Promise<Response> {
  return fetch(url(path), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

before(async () => {
  server = await createServer({ database: ':memory:' });
  await server.listen(0);
});

after(async () => {
  await server.close();
});

test('full schema-evolution conformance flow', async () => {
  // ── Step 1+2: dataset ───────────────────────────────────────────────────
  {
    const res = await postJson(`/projects/${PROJECT}/datasets`, {
      datasetReference: { datasetId: DATASET },
    });
    assert.equal(res.status, 200, 'dataset create');
  }

  // ── Step 3: table with initial schema (id, payload JSON, created_at) ────
  {
    const res = await postJson(`/projects/${PROJECT}/datasets/${DATASET}/tables`, {
      tableReference: { tableId: TABLE },
      schema: {
        fields: [
          { name: 'id', type: 'STRING', mode: 'REQUIRED' },
          { name: 'payload', type: 'JSON' },
          { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
        ],
      },
    });
    assert.equal(res.status, 200, 'table create');
  }

  // ── Step 4: insert the OLD rows (timestamps span the last hour) ─────────
  {
    // Stagger across the hour preceding NOW_MS: 60, 50, 40, 30, 20 minutes ago.
    const rows = OLD_ROWS.map((r, i) => {
      const minutesAgo = 60 - i * 10;
      const ts = new Date(NOW_MS - minutesAgo * 60_000).toISOString();
      return { json: { id: r.id, payload: JSON.stringify(r.payload), created_at: ts } };
    });
    const res = await postJson(
      `/projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}/insertAll`,
      { rows },
    );
    assert.equal(res.status, 200, 'insertAll OLD');
    const body = (await res.json()) as { insertErrors?: unknown[] };
    assert.equal(body.insertErrors, undefined, 'no insert errors on OLD rows');
  }

  // ── Step 5: PATCH the table to add `category STRING` (the bug-fix path) ──
  {
    const res = await patchJson(`/projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}`, {
      schema: {
        fields: [
          { name: 'id', type: 'STRING', mode: 'REQUIRED' },
          { name: 'payload', type: 'JSON' },
          { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
          { name: 'category', type: 'STRING' },
        ],
      },
    });
    assert.equal(res.status, 200, 'PATCH add column');
    const body = (await res.json()) as {
      schema: { fields: Array<{ name: string }> };
    };
    assert.deepEqual(
      body.schema.fields.map((f) => f.name),
      ['id', 'payload', 'created_at', 'category'],
      'PATCH response reflects new column order',
    );
  }

  // ── Step 6: insert the NEW rows (now including `category`) ──────────────
  {
    // Stagger the new rows across 15 down to -25 minutes from NOW.
    // (The last two are *after* NOW; they fall outside the 1-hour window.)
    const rows = NEW_ROWS.map((r, i) => {
      const minutesOffset = 15 - i * 10; // 15, 5, -5, -15, -25
      const ts = new Date(NOW_MS - minutesOffset * 60_000).toISOString();
      return {
        json: {
          id: r.id,
          payload: JSON.stringify(r.payload),
          created_at: ts,
          category: r.category,
        },
      };
    });
    const res = await postJson(
      `/projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}/insertAll`,
      { rows },
    );
    assert.equal(res.status, 200, 'insertAll NEW');
    const body = (await res.json()) as { insertErrors?: unknown[] };
    assert.equal(body.insertErrors, undefined, 'no insert errors on NEW rows');
  }

  // ── Step 7: parameterized query that exercises the BQ-specific SQL ──────
  //
  // - JSON_VALUE(payload, '$.name') — extract a field from the JSON column
  // - TIMESTAMP_SUB(@now, INTERVAL 1 HOUR) — restrict to the last hour
  // - id IN UNNEST(@ids) — filter to a specific subset
  //
  // The @ids list intentionally mixes OLD ('c', 'd') and NEW ('f', 'g')
  // ids. Both groups exist within the 1-hour window. NEW ids 'h', 'i', 'j'
  // are inside the @ids list visually but are EITHER outside the window
  // OR not selected — we'll narrow @ids to ['c', 'd', 'f', 'g'].
  const queryRes = await postJson(`/projects/${PROJECT}/queries`, {
    query: `
      SELECT
        id,
        JSON_VALUE(payload, '$.name') AS name,
        category
      FROM \`${DATASET}.${TABLE}\`
      WHERE id IN UNNEST(@ids)
        AND created_at > TIMESTAMP_SUB(@now, INTERVAL 1 HOUR)
      ORDER BY id
    `,
    queryParameters: [
      {
        name: 'now',
        parameterType: { type: 'TIMESTAMP' },
        parameterValue: { value: new Date(NOW_MS).toISOString() },
      },
      {
        name: 'ids',
        parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
        parameterValue: {
          arrayValues: [{ value: 'c' }, { value: 'd' }, { value: 'f' }, { value: 'g' }],
        },
      },
    ],
  });
  assert.equal(queryRes.status, 200, 'query OK');
  const queryBody = (await queryRes.json()) as {
    kind: string;
    totalRows: string;
    schema: { fields: Array<{ name: string }> };
    rows: Array<{ f: Array<{ v: unknown }> }>;
  };

  // ── Step 8: assertions ──────────────────────────────────────────────────
  assert.equal(queryBody.kind, 'bigquery#queryResponse');
  assert.equal(queryBody.totalRows, '4', 'four rows match the filter');
  assert.deepEqual(
    queryBody.schema.fields.map((f) => f.name),
    ['id', 'name', 'category'],
    'result schema includes the post-PATCH column',
  );

  // Result rows, in id order: c, d (OLD → category NULL), f, g (NEW → category set).
  const rows = queryBody.rows.map((r) => ({
    id: r.f[0]?.v,
    name: r.f[1]?.v,
    category: r.f[2]?.v,
  }));
  assert.deepEqual(rows, [
    { id: 'c', name: 'charlie', category: null },
    { id: 'd', name: 'delta', category: null },
    { id: 'f', name: 'foxtrot', category: 'recent' },
    { id: 'g', name: 'golf', category: 'recent' },
  ]);
});

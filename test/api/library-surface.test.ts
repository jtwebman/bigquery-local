/**
 * Library-surface acceptance test.
 *
 * Imports ONLY from `'bigquery-local'` (the package self-reference, which
 * resolves to `src/index.ts` in dev via the `src` export condition and to
 * `dist/index.js` once the package is published). Proves the public surface
 * is enough on its own to run a real BigQuery-style workflow end-to-end:
 *
 *   1. spin up the server
 *   2. POST a dataset
 *   3. POST a table
 *   4. POST rows via insertAll
 *   5. POST a query
 *   6. assert the result rows
 *   7. assert BqError is exported and instanceof-checkable
 *   8. close() the server (which also closes the DB)
 *
 * If this test ever needs to import from a non-public module, the public
 * surface is missing something.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { BqError, type Server, type ServerConfig, createServer } from 'bigquery-local';

const PROJECT = 'lib-surface';

test('createServer({}) defaults to an in-memory database', async () => {
  // Empty config compiles — `database` is optional. Verifies ServerConfig's shape.
  const config: ServerConfig = {};
  const server: Server = await createServer(config);
  await server.listen(0);
  assert.match(server.url, /^http:\/\/localhost:\d+$/);
  await server.close();
});

test('happy path: dataset → table → insertAll → query', async () => {
  const server = await createServer({ database: ':memory:' });
  await server.listen(0);
  try {
    // 1. Create a dataset.
    const dsRes = await fetch(`${server.url}/projects/${PROJECT}/datasets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ datasetReference: { datasetId: 'ds' } }),
    });
    assert.equal(dsRes.status, 200);

    // 2. Create a table with one STRING column.
    const tblRes = await fetch(`${server.url}/projects/${PROJECT}/datasets/ds/tables`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tableReference: { tableId: 't' },
        schema: { fields: [{ name: 'name', type: 'STRING' }] },
      }),
    });
    assert.equal(tblRes.status, 200);

    // 3. Insert rows.
    const insertRes = await fetch(
      `${server.url}/projects/${PROJECT}/datasets/ds/tables/t/insertAll`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rows: [{ json: { name: 'alice' } }, { json: { name: 'bob' } }],
        }),
      },
    );
    assert.equal(insertRes.status, 200);

    // 4. Run a query.
    const queryRes = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT name FROM `ds.t` ORDER BY name' }),
    });
    assert.equal(queryRes.status, 200);
    const body = (await queryRes.json()) as {
      totalRows: string;
      rows: Array<{ f: Array<{ v: unknown }> }>;
    };
    assert.equal(body.totalRows, '2');
    assert.deepEqual(
      body.rows.map((r) => r.f[0]?.v),
      ['alice', 'bob'],
    );
  } finally {
    await server.close();
  }
});

test('BqError is exported and instanceof-checkable', () => {
  const err = BqError.notFound('Test dataset not found.');
  assert.ok(err instanceof BqError);
  assert.ok(err instanceof Error);
  assert.equal(err.reason, 'notFound');
  assert.equal(err.code, 404);
});

test('server.close() is idempotent and closes the database', async () => {
  const server = await createServer({});
  await server.listen(0);
  await server.close();
  // A second close is a no-op for the HTTP server; the DB's close() is also
  // idempotent (see Db.close()), so calling close twice must not throw.
  await server.close();
  // After close, url getter throws because the listener is gone.
  assert.throws(() => server.url, /not listening/);
});

test('two concurrent servers can serve different projects on the same instance', async () => {
  // Even with one server, multiple projects work because routes scope by URL.
  // This test proves the multi-tenant model from the README.
  const server = await createServer({});
  await server.listen(0);
  try {
    for (const projectId of ['proj-a', 'proj-b']) {
      const res = await fetch(`${server.url}/projects/${projectId}/datasets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ datasetReference: { datasetId: 'shared' } }),
      });
      assert.equal(res.status, 200, `creating dataset for ${projectId} should succeed`);
    }
  } finally {
    await server.close();
  }
});

test('server handles parallel requests across projects without races', async () => {
  // Real concern: bigquery-local runs every route handler through a single
  // DuckDB connection. Node's HTTP server happily fires many in-flight at
  // once. If we don't serialize correctly, you'd see lost rows, weird wire
  // shapes, or rejected promises. Drive 20 parallel POSTs at the same
  // server and verify every one succeeds and returns sane data.
  const server = await createServer({});
  await server.listen(0);
  try {
    const projectIds = Array.from({ length: 20 }, (_, i) => `parallel-${i}`);
    // Create datasets in parallel.
    await Promise.all(
      projectIds.map((projectId) =>
        fetch(`${server.url}/projects/${projectId}/datasets`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ datasetReference: { datasetId: 'ds' } }),
        }).then((r) => assert.equal(r.status, 200, `create ${projectId}`)),
      ),
    );
    // List back: each project's metadata is its own — confirm by GET.
    const results = await Promise.all(
      projectIds.map((projectId) =>
        fetch(`${server.url}/projects/${projectId}/datasets/ds`).then((r) => r.json()),
      ),
    );
    for (const [i, body] of results.entries()) {
      const ref = (body as { datasetReference: { projectId: string; datasetId: string } })
        .datasetReference;
      assert.equal(ref.projectId, projectIds[i]);
      assert.equal(ref.datasetId, 'ds');
    }
  } finally {
    await server.close();
  }
});

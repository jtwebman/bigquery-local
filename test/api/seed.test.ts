/**
 * --data-from-yaml integration: load a YAML seed file against a running
 * server and confirm everything's queryable.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createServer } from '../../src/index.ts';
import { loadSeedFromFile } from '../../src/seed.ts';
import type { Server } from '../../src/types.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/seed.yaml', import.meta.url));

let server: Server;

before(async () => {
  server = await createServer({ database: ':memory:' });
  await server.listen(0);
  await loadSeedFromFile(server.url, FIXTURE, 'local');
});

after(async () => {
  await server.close();
});

interface QueryResponse {
  totalRows: string;
  rows: Array<{ f: Array<{ v: unknown }> }>;
}

async function runQuery(project: string, query: string): Promise<QueryResponse> {
  const res = await fetch(`${server.url}/projects/${project}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as QueryResponse;
}

test('seed file populates the default-project dataset and its tables', async () => {
  const events = await runQuery('local', 'SELECT id FROM `analytics.events` ORDER BY id');
  assert.equal(events.totalRows, '3');
  assert.deepEqual(
    events.rows.map((r) => r.f[0]?.v),
    ['a', 'b', 'c'],
  );

  const users = await runQuery('local', 'SELECT username FROM `analytics.users` ORDER BY username');
  assert.equal(users.totalRows, '2');
  assert.deepEqual(
    users.rows.map((r) => r.f[0]?.v),
    ['alice', 'bob'],
  );
});

test('seed honors per-dataset project override', async () => {
  // The third dataset in seed.yaml has `project: other-proj`.
  const res = await fetch(`${server.url}/projects/other-proj/datasets/warehouse`);
  assert.equal(res.status, 200);
});

test("seed file dataset under default project does NOT appear in another project's listing", async () => {
  // analytics is under 'local', not 'other-proj'.
  const otherRes = await fetch(`${server.url}/projects/other-proj/datasets`);
  const body = (await otherRes.json()) as {
    datasets: Array<{ datasetReference: { datasetId: string } }>;
  };
  const ids = body.datasets.map((d) => d.datasetReference.datasetId);
  assert.ok(!ids.includes('analytics'));
  assert.ok(ids.includes('warehouse'));
});

test('seed file with a table that has no rows still creates the table', async () => {
  // warehouse.snapshots is declared with no rows.
  const res = await fetch(`${server.url}/projects/other-proj/datasets/warehouse/tables/snapshots`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { schema: { fields: Array<{ name: string }> } };
  assert.deepEqual(
    body.schema.fields.map((f) => f.name),
    ['at'],
  );
});

/**
 * Multi-project isolation (BL-034 — the acceptance side).
 *
 * The CLI flag is repeatable (`--project=foo --project=bar`), but more
 * importantly: at the API level, two projects with the same dataset/table
 * names must not collide. Real BigQuery scopes everything by project; we
 * do too, via `_bq.datasets`'s `(project, dataset_id)` primary key.
 *
 * The CLI parser tests live in test/unit/cli-parseArgs.test.ts — these
 * focus on actual request-time isolation.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createTabledataRoutes } from '../../src/routes/tabledata.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

interface DatasetWire {
  kind: string;
  datasetReference: { projectId: string; datasetId: string };
}
interface TableWire {
  kind: string;
  tableReference: { projectId: string; datasetId: string; tableId: string };
}

let db: Db;
let server: Server;

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [...createDatasetRoutes(db), ...createTableRoutes(db), ...createTabledataRoutes(db)],
  });
  await server.listen(0);
});

after(async () => {
  await server.close();
  await db.close();
});

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('same dataset id in two projects: each created independently', async () => {
  // proj-a/shared-ds
  const a = await postJson('/projects/proj-a/datasets', {
    datasetReference: { datasetId: 'shared-ds' },
  });
  assert.equal(a.status, 200);
  // proj-b/shared-ds — should NOT collide.
  const b = await postJson('/projects/proj-b/datasets', {
    datasetReference: { datasetId: 'shared-ds' },
  });
  assert.equal(b.status, 200);
  // Each GET returns its own.
  const ra = await fetch(`${server.url}/projects/proj-a/datasets/shared-ds`);
  const rb = await fetch(`${server.url}/projects/proj-b/datasets/shared-ds`);
  const da = (await ra.json()) as DatasetWire;
  const db_ = (await rb.json()) as DatasetWire;
  assert.equal(da.datasetReference.projectId, 'proj-a');
  assert.equal(db_.datasetReference.projectId, 'proj-b');
});

test('same dataset+table id in two projects: tables are independent', async () => {
  await postJson('/projects/proj-c/datasets', {
    datasetReference: { datasetId: 'analytics' },
  });
  await postJson('/projects/proj-d/datasets', {
    datasetReference: { datasetId: 'analytics' },
  });
  // Same tableId in both, different schemas.
  await postJson('/projects/proj-c/datasets/analytics/tables', {
    tableReference: { tableId: 'events' },
    schema: { fields: [{ name: 'id', type: 'STRING' }] },
  });
  await postJson('/projects/proj-d/datasets/analytics/tables', {
    tableReference: { tableId: 'events' },
    schema: { fields: [{ name: 'when', type: 'TIMESTAMP' }] },
  });
  // Each project sees its own schema.
  const tc = (await (
    await fetch(`${server.url}/projects/proj-c/datasets/analytics/tables/events`)
  ).json()) as { schema: { fields: Array<{ name: string }> } };
  const td = (await (
    await fetch(`${server.url}/projects/proj-d/datasets/analytics/tables/events`)
  ).json()) as { schema: { fields: Array<{ name: string }> } };
  assert.deepEqual(
    tc.schema.fields.map((f) => f.name),
    ['id'],
  );
  assert.deepEqual(
    td.schema.fields.map((f) => f.name),
    ['when'],
  );
});

test("listing datasets in one project does not include another project's datasets", async () => {
  // Project e has 3 datasets; project f has 1.
  for (const id of ['e_one', 'e_two', 'e_three']) {
    await postJson('/projects/proj-e/datasets', { datasetReference: { datasetId: id } });
  }
  await postJson('/projects/proj-f/datasets', {
    datasetReference: { datasetId: 'f_only' },
  });
  const re = await fetch(`${server.url}/projects/proj-e/datasets`);
  const rf = await fetch(`${server.url}/projects/proj-f/datasets`);
  const be = (await re.json()) as { datasets: DatasetWire[] };
  const bf = (await rf.json()) as { datasets: DatasetWire[] };
  assert.deepEqual(be.datasets.map((d) => d.datasetReference.datasetId).sort(), [
    'e_one',
    'e_three',
    'e_two',
  ]);
  assert.deepEqual(
    bf.datasets.map((d) => d.datasetReference.datasetId),
    ['f_only'],
  );
});

test('inserts into proj-A.shared.t do not appear in proj-B.shared.t', async () => {
  await postJson('/projects/proj-g/datasets', { datasetReference: { datasetId: 'shared' } });
  await postJson('/projects/proj-h/datasets', { datasetReference: { datasetId: 'shared' } });
  for (const project of ['proj-g', 'proj-h']) {
    await postJson(`/projects/${project}/datasets/shared/tables`, {
      tableReference: { tableId: 't' },
      schema: { fields: [{ name: 'v', type: 'STRING' }] },
    });
  }
  await postJson('/projects/proj-g/datasets/shared/tables/t/insertAll', {
    rows: [{ json: { v: 'g-only-1' } }, { json: { v: 'g-only-2' } }],
  });
  await postJson('/projects/proj-h/datasets/shared/tables/t/insertAll', {
    rows: [{ json: { v: 'h-only' } }],
  });
  // Each project's table has its own row count via tabledata.list.
  const g = await fetch(`${server.url}/projects/proj-g/datasets/shared/tables/t/data`);
  const h = await fetch(`${server.url}/projects/proj-h/datasets/shared/tables/t/data`);
  const bg = (await g.json()) as { totalRows: string; rows: Array<{ f: Array<{ v: unknown }> }> };
  const bh = (await h.json()) as { totalRows: string; rows: Array<{ f: Array<{ v: unknown }> }> };
  assert.equal(bg.totalRows, '2');
  assert.equal(bh.totalRows, '1');
  // Suppress unused-var warning by lightly using TableWire.
  const _t: TableWire = {
    kind: 'bigquery#table',
    tableReference: { projectId: 'proj-g', datasetId: 'shared', tableId: 't' },
  };
  void _t;
});

/**
 * BL-073 — Projects list + getServiceAccount endpoints.
 *
 * Projects.list reflects what the caller has access to in real BigQuery;
 * the emulator has no auth, so we return every project that has datasets.
 * getServiceAccount returns a deterministic emulator-shaped address.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createProjectRoutes } from '../../src/routes/projects.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

let db: Db;
let server: Server;

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [...createProjectRoutes(db), ...createDatasetRoutes(db)],
  });
  await server.listen(0);
  // Seed datasets across two projects so listProjects has rows.
  for (const project of ['proj-alpha', 'proj-beta']) {
    await fetch(`${server.url}/projects/${project}/datasets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ datasetReference: { datasetId: 'd1' } }),
    });
  }
});
after(async () => {
  await server.close();
  await db.close();
});

interface ProjectListResponse {
  kind: string;
  projects: Array<{
    id: string;
    numericId: string;
    projectReference: { projectId: string };
    friendlyName: string;
  }>;
  totalItems: number;
  nextPageToken?: string;
}

test('GET /projects returns every project that has datasets', async () => {
  const res = await fetch(`${server.url}/projects`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as ProjectListResponse;
  assert.equal(body.kind, 'bigquery#projectList');
  const ids = body.projects.map((p) => p.projectReference.projectId).sort();
  assert.deepEqual(ids, ['proj-alpha', 'proj-beta']);
});

test('Project numericId is a deterministic decimal string', async () => {
  const first = (await (await fetch(`${server.url}/projects`)).json()) as ProjectListResponse;
  const second = (await (await fetch(`${server.url}/projects`)).json()) as ProjectListResponse;
  const alpha1 = first.projects.find((p) => p.id === 'proj-alpha');
  const alpha2 = second.projects.find((p) => p.id === 'proj-alpha');
  assert.ok(alpha1 && alpha2);
  assert.equal(alpha1.numericId, alpha2.numericId);
  assert.match(alpha1.numericId, /^\d+$/);
});

test('GET /projects?pageToken=1 paginates correctly', async () => {
  const first = await fetch(`${server.url}/projects?maxResults=1`);
  const firstBody = (await first.json()) as ProjectListResponse;
  assert.equal(firstBody.projects.length, 1);
  assert.equal(firstBody.nextPageToken, '1');

  const second = await fetch(`${server.url}/projects?maxResults=1&pageToken=1`);
  const secondBody = (await second.json()) as ProjectListResponse;
  assert.equal(secondBody.projects.length, 1);
  assert.notEqual(
    secondBody.projects[0]?.projectReference.projectId,
    firstBody.projects[0]?.projectReference.projectId,
  );
});

test('GET /projects validation rejects bad pageToken / maxResults', async () => {
  let res = await fetch(`${server.url}/projects?pageToken=-1`);
  assert.equal(res.status, 400);
  res = await fetch(`${server.url}/projects?maxResults=0`);
  assert.equal(res.status, 400);
});

test('GET /projects/{p}/serviceAccount returns a deterministic shaped email', async () => {
  const res = await fetch(`${server.url}/projects/proj-alpha/serviceAccount`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { kind: string; email: string };
  assert.equal(body.kind, 'bigquery#getServiceAccountResponse');
  assert.match(body.email, /^bq-\d+@bigquery-local\.iam\.gserviceaccount\.invalid$/);

  // Same project → same email (deterministic).
  const second = (await (
    await fetch(`${server.url}/projects/proj-alpha/serviceAccount`)
  ).json()) as {
    email: string;
  };
  assert.equal(second.email, body.email);

  // Different project → different email.
  const beta = (await (await fetch(`${server.url}/projects/proj-beta/serviceAccount`)).json()) as {
    email: string;
  };
  assert.notEqual(beta.email, body.email);
});

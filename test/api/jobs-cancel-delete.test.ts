/**
 * jobs.cancel + jobs.delete:
 *   POST   /projects/{p}/jobs/{j}/cancel  → bigquery#jobCancelResponse
 *   DELETE /projects/{p}/jobs/{j}/delete  → 204 No Content (matches the
 *     trailing-/delete path that BigQuery's actual REST endpoint uses)
 *
 * Cancel transitions PENDING/RUNNING → DONE with `errorResult.reason='stopped'`
 * and is a no-op on already-DONE jobs (also matching real BQ).
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createJobsRoutes } from '../../src/routes/jobs.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

interface JobResourceWire {
  kind: string;
  jobReference: { projectId: string; jobId: string };
  status: {
    state: 'PENDING' | 'RUNNING' | 'DONE';
    errorResult?: { reason: string; message: string };
  };
}

interface CancelResponseWire {
  kind: string;
  job: JobResourceWire;
}

interface GoogleErrorBody {
  error: { code: number; errors: Array<{ reason: string; message: string }>; message: string };
}

let db: Db;
let server: Server;

const PROJECT = 'cancel-delete-tests';

async function seedJob(jobId: string, state: 'PENDING' | 'RUNNING' | 'DONE'): Promise<void> {
  await db.exec(
    `INSERT INTO _bq.jobs (project, job_id, state, statement_type, query, created_at)
     VALUES ($1, $2, $3, 'SELECT', 'SELECT 1', epoch_ms(1780000000000::BIGINT))`,
    [PROJECT, jobId, state],
  );
}

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({ routes: [...createJobsRoutes(db)] });
  await server.listen(0);
});

after(async () => {
  await server.close();
  await db.close();
});

async function postCancel(jobId: string): Promise<Response> {
  return fetch(`${server.url}/projects/${PROJECT}/jobs/${jobId}/cancel`, { method: 'POST' });
}

async function deleteJob(jobId: string): Promise<Response> {
  return fetch(`${server.url}/projects/${PROJECT}/jobs/${jobId}/delete`, { method: 'DELETE' });
}

async function getJob(jobId: string): Promise<Response> {
  return fetch(`${server.url}/projects/${PROJECT}/jobs/${jobId}`);
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

test('POST /jobs/{j}/cancel on a PENDING job transitions it to DONE with stopped error', async () => {
  await seedJob('j_pending', 'PENDING');
  const res = await postCancel('j_pending');
  assert.equal(res.status, 200);
  const body = (await res.json()) as CancelResponseWire;
  assert.equal(body.kind, 'bigquery#jobCancelResponse');
  assert.equal(body.job.status.state, 'DONE');
  assert.equal(body.job.status.errorResult?.reason, 'stopped');
  // Persisted: GET reflects the same state + error.
  const after = (await (await getJob('j_pending')).json()) as JobResourceWire;
  assert.equal(after.status.state, 'DONE');
  assert.equal(after.status.errorResult?.reason, 'stopped');
});

test('POST /jobs/{j}/cancel on a RUNNING job also transitions to DONE', async () => {
  await seedJob('j_running', 'RUNNING');
  const res = await postCancel('j_running');
  assert.equal(res.status, 200);
  const body = (await res.json()) as CancelResponseWire;
  assert.equal(body.job.status.state, 'DONE');
  assert.equal(body.job.status.errorResult?.reason, 'stopped');
});

test('POST /jobs/{j}/cancel on an already-DONE job is a no-op (returns DONE, no error)', async () => {
  await seedJob('j_done', 'DONE');
  const res = await postCancel('j_done');
  assert.equal(res.status, 200);
  const body = (await res.json()) as CancelResponseWire;
  assert.equal(body.job.status.state, 'DONE');
  // No errorResult set — the job was never cancelled, it just finished.
  assert.equal(body.job.status.errorResult, undefined);
});

test('POST /jobs/{j}/cancel returns 404 for an unknown job', async () => {
  const res = await postCancel('never-existed');
  assert.equal(res.status, 404);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'notFound');
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

test('DELETE /jobs/{j}/delete removes the job; subsequent GET is 404', async () => {
  await seedJob('j_to_delete', 'DONE');
  // Confirm it exists first.
  assert.equal((await getJob('j_to_delete')).status, 200);
  // Delete: 204 No Content.
  const del = await deleteJob('j_to_delete');
  assert.equal(del.status, 204);
  const body = await del.text();
  assert.equal(body, '', 'DELETE response body must be empty');
  // Subsequent GET returns 404.
  assert.equal((await getJob('j_to_delete')).status, 404);
});

test('DELETE /jobs/{j}/delete returns 404 for an unknown job', async () => {
  const res = await deleteJob('never-existed');
  assert.equal(res.status, 404);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'notFound');
});

test('DELETE removes persisted result rows too (no orphans in _bq.job_rows)', async () => {
  // Seed a job AND a few result rows.
  await seedJob('j_with_rows', 'DONE');
  for (let i = 0; i < 3; i++) {
    await db.exec(
      `INSERT INTO _bq.job_rows (project, job_id, row_index, row)
       VALUES ($1, $2, $3::BIGINT, $4::JSON)`,
      [PROJECT, 'j_with_rows', BigInt(i), JSON.stringify({ f: [{ v: String(i) }] })],
    );
  }
  const before = await db.query<{ count: bigint }>(
    'SELECT COUNT(*)::BIGINT AS count FROM _bq.job_rows WHERE project = $1 AND job_id = $2',
    [PROJECT, 'j_with_rows'],
  );
  assert.equal(before[0]?.count, 3n);
  assert.equal((await deleteJob('j_with_rows')).status, 204);
  const after = await db.query<{ count: bigint }>(
    'SELECT COUNT(*)::BIGINT AS count FROM _bq.job_rows WHERE project = $1 AND job_id = $2',
    [PROJECT, 'j_with_rows'],
  );
  assert.equal(after[0]?.count, 0n, 'all result rows for the deleted job must be gone');
});

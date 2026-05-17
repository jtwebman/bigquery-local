/**
 * GET /projects/{p}/jobs — list with filters.
 *
 * Tests pagination plus the three documented filters:
 *   - stateFilter (single + comma-separated multi)
 *   - minCreationTime / maxCreationTime (ms since epoch)
 *   - projection: minimal (default; no `configuration`) vs full
 *
 * Jobs are seeded via raw SQL so we can control `created_at` precisely —
 * `upsertJob` always uses `Date.now()` for new jobs, which would make the
 * time-range filter tests flaky.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createJobsRoutes } from '../../src/routes/jobs.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

interface JobListWire {
  kind: string;
  etag: string;
  jobs: Array<{
    kind: string;
    id: string;
    jobReference: { projectId: string; jobId: string };
    state: 'PENDING' | 'RUNNING' | 'DONE';
    status: { state: string };
    statistics: { creationTime: string };
    configuration?: { query: { query: string } };
  }>;
  nextPageToken?: string;
}

interface GoogleErrorBody {
  error: { code: number; errors: Array<{ reason: string; message: string }>; message: string };
}

let db: Db;
let server: Server;

const PROJECT = 'jobs-list-tests';

// Reference points for time-range filters. T0 ... T4 are spaced 1 second apart.
const T0 = 1_780_000_000_000;
const T1 = T0 + 1_000;
const T2 = T0 + 2_000;
const T3 = T0 + 3_000;
const T4 = T0 + 4_000;

interface SeedJob {
  readonly jobId: string;
  readonly state: 'PENDING' | 'RUNNING' | 'DONE';
  readonly createdMs: number;
}

async function seedJob(job: SeedJob): Promise<void> {
  // Bypass upsertJob to set a deterministic created_at.
  await db.exec(
    `INSERT INTO _bq.jobs (project, job_id, state, statement_type, query, created_at)
     VALUES ($1, $2, $3, 'SELECT', 'SELECT 1', epoch_ms($4::BIGINT))`,
    [PROJECT, job.jobId, job.state, BigInt(job.createdMs)],
  );
}

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({ routes: [...createJobsRoutes(db)] });
  await server.listen(0);

  // Seed 5 jobs across states and times:
  //   j_done_old      DONE     T0
  //   j_done_mid      DONE     T1
  //   j_running_mid   RUNNING  T2
  //   j_pending_new   PENDING  T3
  //   j_done_new      DONE     T4
  await seedJob({ jobId: 'j_done_old', state: 'DONE', createdMs: T0 });
  await seedJob({ jobId: 'j_done_mid', state: 'DONE', createdMs: T1 });
  await seedJob({ jobId: 'j_running_mid', state: 'RUNNING', createdMs: T2 });
  await seedJob({ jobId: 'j_pending_new', state: 'PENDING', createdMs: T3 });
  await seedJob({ jobId: 'j_done_new', state: 'DONE', createdMs: T4 });
});

after(async () => {
  await server.close();
  await db.close();
});

async function getList(query: string): Promise<{ status: number; body: JobListWire }> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs${query}`);
  return { status: res.status, body: (await res.json()) as JobListWire };
}

// ---------------------------------------------------------------------------
// Empty / unknown project
// ---------------------------------------------------------------------------

test('GET /jobs for an unknown project returns an empty list', async () => {
  const res = await fetch(`${server.url}/projects/no-such-project/jobs`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as JobListWire;
  assert.equal(body.kind, 'bigquery#jobList');
  assert.deepEqual(body.jobs, []);
  assert.equal(body.nextPageToken, undefined);
});

// ---------------------------------------------------------------------------
// Ordering — newest first
// ---------------------------------------------------------------------------

test('GET /jobs returns jobs ordered newest first', async () => {
  const { status, body } = await getList('');
  assert.equal(status, 200);
  assert.equal(body.kind, 'bigquery#jobList');
  assert.deepEqual(
    body.jobs.map((j) => j.jobReference.jobId),
    ['j_done_new', 'j_pending_new', 'j_running_mid', 'j_done_mid', 'j_done_old'],
  );
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test('GET /jobs paginates with maxResults + pageToken', async () => {
  const p1 = await getList('?maxResults=2');
  assert.equal(p1.body.jobs.length, 2);
  assert.equal(p1.body.nextPageToken, '2');

  const p2 = await getList('?maxResults=2&pageToken=2');
  assert.equal(p2.body.jobs.length, 2);
  assert.equal(p2.body.nextPageToken, '4');

  const p3 = await getList('?maxResults=2&pageToken=4');
  assert.equal(p3.body.jobs.length, 1);
  assert.equal(p3.body.nextPageToken, undefined);
});

// ---------------------------------------------------------------------------
// stateFilter
// ---------------------------------------------------------------------------

test('GET /jobs?stateFilter=DONE returns only DONE jobs', async () => {
  const { body } = await getList('?stateFilter=DONE');
  assert.deepEqual(
    body.jobs.map((j) => j.jobReference.jobId),
    ['j_done_new', 'j_done_mid', 'j_done_old'],
  );
});

test('GET /jobs accepts comma-separated stateFilter values', async () => {
  const { body } = await getList('?stateFilter=PENDING,RUNNING');
  assert.deepEqual(
    body.jobs.map((j) => j.jobReference.jobId),
    ['j_pending_new', 'j_running_mid'],
  );
});

test('GET /jobs?stateFilter=done is case-insensitive', async () => {
  const { body } = await getList('?stateFilter=done');
  assert.equal(body.jobs.length, 3);
});

test('GET /jobs rejects an unknown state in stateFilter', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs?stateFilter=BOGUS`);
  assert.equal(res.status, 400);
  const err = (await res.json()) as GoogleErrorBody;
  assert.equal(err.error.errors[0]?.reason, 'invalid');
  assert.match(err.error.errors[0]?.message ?? '', /stateFilter/);
});

// ---------------------------------------------------------------------------
// minCreationTime / maxCreationTime
// ---------------------------------------------------------------------------

test('GET /jobs?minCreationTime narrows to jobs created at-or-after the bound', async () => {
  const { body } = await getList(`?minCreationTime=${T2}`);
  assert.deepEqual(
    body.jobs.map((j) => j.jobReference.jobId),
    ['j_done_new', 'j_pending_new', 'j_running_mid'],
  );
});

test('GET /jobs?maxCreationTime narrows to jobs created at-or-before the bound', async () => {
  const { body } = await getList(`?maxCreationTime=${T1}`);
  assert.deepEqual(
    body.jobs.map((j) => j.jobReference.jobId),
    ['j_done_mid', 'j_done_old'],
  );
});

test('GET /jobs?minCreationTime + maxCreationTime form an inclusive window', async () => {
  const { body } = await getList(`?minCreationTime=${T1}&maxCreationTime=${T3}`);
  assert.deepEqual(
    body.jobs.map((j) => j.jobReference.jobId),
    ['j_pending_new', 'j_running_mid', 'j_done_mid'],
  );
});

test('GET /jobs rejects non-numeric minCreationTime', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs?minCreationTime=tomorrow`);
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// projection
// ---------------------------------------------------------------------------

test('GET /jobs default projection (minimal) omits configuration', async () => {
  const { body } = await getList('?maxResults=1');
  const entry = body.jobs[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.configuration, undefined);
  // But state + jobReference + statistics are still present.
  assert.equal(entry.kind, 'bigquery#job');
  assert.equal(entry.state, 'DONE');
  assert.match(entry.statistics.creationTime, /^\d+$/);
});

test('GET /jobs?projection=full includes configuration.query.query', async () => {
  const { body } = await getList('?maxResults=1&projection=full');
  const entry = body.jobs[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.configuration?.query.query, 'SELECT 1');
});

test('GET /jobs rejects projection=bogus', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/jobs?projection=bogus`);
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// Combined filter + pagination
// ---------------------------------------------------------------------------

test('GET /jobs filters apply before pagination', async () => {
  // 3 DONE jobs total; with maxResults=2, we get the 2 newest, plus a token.
  const { body } = await getList('?stateFilter=DONE&maxResults=2');
  assert.deepEqual(
    body.jobs.map((j) => j.jobReference.jobId),
    ['j_done_new', 'j_done_mid'],
  );
  assert.equal(body.nextPageToken, '2');
});

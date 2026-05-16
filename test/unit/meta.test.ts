import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import {
  deleteDataset,
  deleteTable,
  ensureMetaSchema,
  getDataset,
  getJob,
  getTable,
  upsertDataset,
  upsertJob,
  upsertTable,
} from '../../src/storage/meta.ts';
import { BqError } from '../../src/util/errors.ts';

async function freshDb(): Promise<Db> {
  const db = await createDb();
  await ensureMetaSchema(db);
  return db;
}

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

test('ensureMetaSchema creates the _bq schema and all four tables', async () => {
  const db = await freshDb();
  try {
    const rows = await db.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = '_bq' ORDER BY table_name`,
    );
    assert.deepEqual(
      rows.map((r) => r.name),
      ['datasets', 'job_rows', 'jobs', 'tables'],
    );
  } finally {
    await db.close();
  }
});

test('ensureMetaSchema is idempotent', async () => {
  const db = await createDb();
  try {
    await ensureMetaSchema(db);
    await ensureMetaSchema(db);
    await ensureMetaSchema(db);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

test('upsertDataset inserts a new dataset and getDataset reads it back', async () => {
  const db = await freshDb();
  try {
    const created = await upsertDataset(db, {
      project: 'p',
      datasetId: 'd',
      location: 'US',
      friendlyName: 'My dataset',
      description: 'desc',
      labels: { env: 'dev', team: 'data' },
      defaultTableExpirationMs: 86_400_000,
    });
    assert.equal(created.project, 'p');
    assert.equal(created.datasetId, 'd');
    assert.equal(created.location, 'US');
    assert.equal(created.friendlyName, 'My dataset');
    assert.equal(created.description, 'desc');
    assert.deepEqual(created.labels, { env: 'dev', team: 'data' });
    assert.equal(created.defaultTableExpirationMs, 86_400_000);
    assert.equal(created.etag.length, 16);
    assert.ok(created.createdMs > 0);
    assert.equal(created.createdMs, created.updatedMs);

    const fetched = await getDataset(db, 'p', 'd');
    assert.deepEqual(fetched, created);
  } finally {
    await db.close();
  }
});

test('getDataset returns null when missing', async () => {
  const db = await freshDb();
  try {
    assert.equal(await getDataset(db, 'nope', 'nope'), null);
  } finally {
    await db.close();
  }
});

test('upsertDataset preserves createdMs and updates updatedMs on update', async () => {
  const db = await freshDb();
  try {
    const first = await upsertDataset(db, { project: 'p', datasetId: 'd' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await upsertDataset(db, {
      project: 'p',
      datasetId: 'd',
      description: 'now with description',
    });
    assert.equal(second.createdMs, first.createdMs);
    assert.ok(second.updatedMs >= first.updatedMs);
    assert.notEqual(second.etag, first.etag);
    assert.equal(second.description, 'now with description');
  } finally {
    await db.close();
  }
});

test('upsertDataset honors If-Match (success path)', async () => {
  const db = await freshDb();
  try {
    const created = await upsertDataset(db, { project: 'p', datasetId: 'd' });
    const updated = await upsertDataset(
      db,
      { project: 'p', datasetId: 'd', description: 'patched' },
      created.etag,
    );
    assert.equal(updated.description, 'patched');
  } finally {
    await db.close();
  }
});

test('upsertDataset throws conditionNotMet on stale If-Match', async () => {
  const db = await freshDb();
  try {
    await upsertDataset(db, { project: 'p', datasetId: 'd' });
    await assert.rejects(
      () => upsertDataset(db, { project: 'p', datasetId: 'd', description: 'fail' }, 'stale-etag'),
      (err: unknown) => err instanceof BqError && err.reason === 'conditionNotMet',
    );
  } finally {
    await db.close();
  }
});

test('upsertDataset with If-Match on a missing dataset throws notFound', async () => {
  const db = await freshDb();
  try {
    await assert.rejects(
      () => upsertDataset(db, { project: 'p', datasetId: 'missing' }, 'any-etag'),
      (err: unknown) => err instanceof BqError && err.reason === 'notFound',
    );
  } finally {
    await db.close();
  }
});

test('deleteDataset returns true when the dataset exists, false otherwise', async () => {
  const db = await freshDb();
  try {
    await upsertDataset(db, { project: 'p', datasetId: 'd' });
    assert.equal(await deleteDataset(db, 'p', 'd'), true);
    assert.equal(await deleteDataset(db, 'p', 'd'), false);
    assert.equal(await getDataset(db, 'p', 'd'), null);
  } finally {
    await db.close();
  }
});

test('deleteDataset throws conditionNotMet on stale If-Match', async () => {
  const db = await freshDb();
  try {
    await upsertDataset(db, { project: 'p', datasetId: 'd' });
    await assert.rejects(
      () => deleteDataset(db, 'p', 'd', 'stale'),
      (err: unknown) => err instanceof BqError && err.reason === 'conditionNotMet',
    );
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

test('upsertTable + getTable round-trip with schema and partitioning JSON', async () => {
  const db = await freshDb();
  try {
    const created = await upsertTable(db, {
      project: 'p',
      datasetId: 'd',
      tableId: 't',
      type: 'TABLE',
      schema: { fields: [{ name: 'id', type: 'INTEGER', mode: 'REQUIRED' }] },
      description: 'a table',
      numRows: 0,
      partitioning: { type: 'DAY', field: 'created_at' },
      clustering: { fields: ['user_id'] },
    });
    assert.equal(created.etag.length, 16);
    const fetched = await getTable(db, 'p', 'd', 't');
    assert.deepEqual(fetched, created);
    assert.deepEqual((fetched?.schema as { fields: unknown[] }).fields.length, 1);
  } finally {
    await db.close();
  }
});

test('deleteTable returns true when the table exists, false otherwise', async () => {
  const db = await freshDb();
  try {
    await upsertTable(db, {
      project: 'p',
      datasetId: 'd',
      tableId: 't',
      type: 'TABLE',
    });
    assert.equal(await deleteTable(db, 'p', 'd', 't'), true);
    assert.equal(await deleteTable(db, 'p', 'd', 't'), false);
  } finally {
    await db.close();
  }
});

test('upsertTable If-Match conditionNotMet on stale etag', async () => {
  const db = await freshDb();
  try {
    await upsertTable(db, { project: 'p', datasetId: 'd', tableId: 't', type: 'TABLE' });
    await assert.rejects(
      () =>
        upsertTable(
          db,
          { project: 'p', datasetId: 'd', tableId: 't', type: 'TABLE', description: 'x' },
          'stale',
        ),
      (err: unknown) => err instanceof BqError && err.reason === 'conditionNotMet',
    );
  } finally {
    await db.close();
  }
});

test('upsertTable If-Match against missing table throws notFound', async () => {
  const db = await freshDb();
  try {
    await assert.rejects(
      () =>
        upsertTable(
          db,
          { project: 'p', datasetId: 'd', tableId: 'missing', type: 'TABLE' },
          'anything',
        ),
      (err: unknown) => err instanceof BqError && err.reason === 'notFound',
    );
  } finally {
    await db.close();
  }
});

test('deleteTable conditionNotMet on stale If-Match', async () => {
  const db = await freshDb();
  try {
    await upsertTable(db, { project: 'p', datasetId: 'd', tableId: 't', type: 'TABLE' });
    await assert.rejects(
      () => deleteTable(db, 'p', 'd', 't', 'stale'),
      (err: unknown) => err instanceof BqError && err.reason === 'conditionNotMet',
    );
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

test('upsertJob + getJob round-trip with JSON params/types/error', async () => {
  const db = await freshDb();
  try {
    const created = await upsertJob(db, {
      project: 'p',
      jobId: 'job-1',
      state: 'RUNNING',
      statementType: 'SELECT',
      query: 'SELECT 1',
      params: { since: '2026-05-01' },
      types: { since: ['TIMESTAMP'] },
      startedMs: Date.now(),
    });
    const fetched = await getJob(db, 'p', 'job-1');
    assert.ok(fetched);
    assert.equal(fetched.state, 'RUNNING');
    assert.equal(fetched.query, 'SELECT 1');
    assert.deepEqual(fetched.params, { since: '2026-05-01' });
    assert.deepEqual(fetched.types, { since: ['TIMESTAMP'] });
    assert.equal(fetched.createdMs, created.createdMs);
  } finally {
    await db.close();
  }
});

test('upsertJob transitions state and preserves createdMs', async () => {
  const db = await freshDb();
  try {
    const pending = await upsertJob(db, {
      project: 'p',
      jobId: 'job-2',
      state: 'PENDING',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const done = await upsertJob(db, {
      project: 'p',
      jobId: 'job-2',
      state: 'DONE',
      endedMs: Date.now(),
      resultTotalRows: 42,
    });
    const fetched = await getJob(db, 'p', 'job-2');
    assert.equal(fetched?.state, 'DONE');
    assert.equal(fetched?.resultTotalRows, 42);
    assert.equal(fetched?.createdMs, pending.createdMs);
    assert.equal(done.createdMs, pending.createdMs);
  } finally {
    await db.close();
  }
});

test('getJob returns null when missing', async () => {
  const db = await freshDb();
  try {
    assert.equal(await getJob(db, 'p', 'nope'), null);
  } finally {
    await db.close();
  }
});

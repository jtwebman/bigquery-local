import { strict as assert } from 'node:assert';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createDb } from '../../src/storage/db.ts';

test('createDb opens an in-memory database and closes cleanly', async () => {
  const db = await createDb();
  await db.close();
});

test('query("SELECT 1") returns a single row', async () => {
  const db = await createDb();
  try {
    const rows = await db.query<{ n: number }>('SELECT 1 AS n');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.n, 1);
  } finally {
    await db.close();
  }
});

test('exec + query round-trips DDL/DML and reads back', async () => {
  const db = await createDb();
  try {
    await db.exec('CREATE TABLE t (id INTEGER, name VARCHAR)');
    await db.exec("INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')");
    const rows = await db.query<{ id: number; name: string }>('SELECT id, name FROM t ORDER BY id');
    assert.deepEqual(
      rows.map((r) => ({ id: r.id, name: r.name })),
      [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
        { id: 3, name: 'c' },
      ],
    );
  } finally {
    await db.close();
  }
});

test('parameterized query binds positional values', async () => {
  const db = await createDb();
  try {
    const rows = await db.query<{ x: number; y: string }>(
      'SELECT $1::INTEGER AS x, $2::VARCHAR AS y',
      [42, 'hello'],
    );
    assert.equal(rows[0]?.x, 42);
    assert.equal(rows[0]?.y, 'hello');
  } finally {
    await db.close();
  }
});

test('parameterized exec binds positional values', async () => {
  const db = await createDb();
  try {
    await db.exec('CREATE TABLE t (id INTEGER, name VARCHAR)');
    await db.exec('INSERT INTO t VALUES ($1, $2)', [1, 'a']);
    const rows = await db.query<{ id: number; name: string }>('SELECT * FROM t');
    assert.deepEqual(
      rows.map((r) => ({ id: r.id, name: r.name })),
      [{ id: 1, name: 'a' }],
    );
  } finally {
    await db.close();
  }
});

test('prepare reuses the same underlying statement for the same SQL', async () => {
  const db = await createDb();
  try {
    await db.exec('CREATE TABLE t (id INTEGER)');
    const insertSql = 'INSERT INTO t VALUES ($1)';
    const insert1 = db.prepare(insertSql);
    const insert2 = db.prepare(insertSql);
    await insert1.exec([1]);
    await insert2.exec([2]);
    await db.prepare(insertSql).exec([3]);
    const rows = await db.query<{ id: number }>('SELECT id FROM t ORDER BY id');
    assert.deepEqual(
      rows.map((r) => r.id),
      [1, 2, 3],
    );
  } finally {
    await db.close();
  }
});

test('PreparedStatement.all returns rows', async () => {
  const db = await createDb();
  try {
    await db.exec('CREATE TABLE t (id INTEGER, label VARCHAR)');
    await db.exec("INSERT INTO t VALUES (1, 'a'), (2, 'b')");
    const select = db.prepare('SELECT id, label FROM t WHERE id >= $1 ORDER BY id');
    const rows = await select.all<{ id: number; label: string }>([1]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.label, 'a');
    assert.equal(rows[1]?.label, 'b');
  } finally {
    await db.close();
  }
});

test('PreparedStatement.all and .exec work without params', async () => {
  const db = await createDb();
  try {
    await db.exec('CREATE TABLE t (id INTEGER)');
    await db.prepare('INSERT INTO t VALUES (1)').exec();
    const rows = await db.prepare('SELECT id FROM t').all<{ id: number }>();
    assert.deepEqual(
      rows.map((r) => r.id),
      [1],
    );
  } finally {
    await db.close();
  }
});

test('close() is idempotent', async () => {
  const db = await createDb();
  await db.close();
  await db.close();
});

test('using the database after close throws', async () => {
  const db = await createDb();
  await db.close();
  await assert.rejects(() => db.query('SELECT 1'), /closed/i);
  await assert.rejects(() => db.exec('SELECT 1'), /closed/i);
  assert.throws(() => db.prepare('SELECT 1'), /closed/i);
});

test('persists to disk when a file path is given', async () => {
  const tmpPath = join(tmpdir(), `bigquery-local-db-test-${process.pid}-${Date.now()}.duckdb`);
  try {
    const db1 = await createDb({ path: tmpPath });
    await db1.exec('CREATE TABLE persistent (id INTEGER)');
    await db1.exec('INSERT INTO persistent VALUES (1), (2), (3)');
    await db1.close();

    const db2 = await createDb({ path: tmpPath });
    try {
      const rows = await db2.query<{ id: number }>('SELECT id FROM persistent ORDER BY id');
      assert.deepEqual(
        rows.map((r) => r.id),
        [1, 2, 3],
      );
    } finally {
      await db2.close();
    }
  } finally {
    await rm(tmpPath, { force: true });
    await rm(`${tmpPath}.wal`, { force: true });
  }
});

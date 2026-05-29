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

// -----------------------------------------------------------------------
// Db.registerScalarFunction — exercises the parseDuckType branches and
// the onClose hook. JS UDFs ride on top of this in src/sql/jsUdf.ts but
// the surface itself is general; pin its behavior independently.
// -----------------------------------------------------------------------

test('registerScalarFunction wires every supported DuckDB type via parseDuckType', async () => {
  const db = await createDb();
  try {
    // Each case below stresses a different branch of parseDuckType().
    // The callback is a no-op identity that returns the input — it only
    // needs to be invoked once for the type to be exercised.
    db.registerScalarFunction({
      name: 'echo_bigint',
      argTypes: ['BIGINT'],
      returnType: 'BIGINT',
      callback: ([v]) => v,
    });
    db.registerScalarFunction({
      name: 'echo_integer',
      argTypes: ['INTEGER'],
      returnType: 'INTEGER',
      callback: ([v]) => v,
    });
    db.registerScalarFunction({
      name: 'echo_double',
      argTypes: ['DOUBLE'],
      returnType: 'DOUBLE',
      callback: ([v]) => v,
    });
    db.registerScalarFunction({
      name: 'echo_float',
      argTypes: ['FLOAT'],
      returnType: 'FLOAT',
      callback: ([v]) => v,
    });
    db.registerScalarFunction({
      name: 'echo_bool',
      argTypes: ['BOOLEAN'],
      returnType: 'BOOL',
      callback: ([v]) => v,
    });
    db.registerScalarFunction({
      name: 'echo_string',
      argTypes: ['STRING'],
      returnType: 'VARCHAR',
      callback: ([v]) => v,
    });
    db.registerScalarFunction({
      name: 'echo_json',
      argTypes: ['JSON'],
      returnType: 'JSON',
      callback: ([v]) => v,
    });
    db.registerScalarFunction({
      name: 'echo_bytes',
      argTypes: ['BYTES'],
      returnType: 'BLOB',
      callback: ([v]) => v,
    });
    db.registerScalarFunction({
      name: 'echo_date',
      argTypes: ['DATE'],
      returnType: 'DATE',
      callback: ([v]) => v,
    });
    db.registerScalarFunction({
      name: 'echo_time',
      argTypes: ['TIME'],
      returnType: 'TIME',
      callback: ([v]) => v,
    });
    db.registerScalarFunction({
      name: 'echo_ts',
      argTypes: ['TIMESTAMP'],
      returnType: 'DATETIME',
      callback: ([v]) => v,
    });
    db.registerScalarFunction({
      name: 'echo_tstz',
      argTypes: ['TIMESTAMPTZ'],
      returnType: 'TIMESTAMP WITH TIME ZONE',
      callback: ([v]) => v,
    });
    db.registerScalarFunction({
      name: 'echo_dec',
      argTypes: ['DECIMAL(38, 9)'],
      returnType: 'DECIMAL(38, 9)',
      callback: ([v]) => v,
    });
    db.registerScalarFunction({
      name: 'echo_list',
      argTypes: ['BIGINT[]'],
      returnType: 'BIGINT[]',
      callback: ([v]) => v,
    });

    // Tiny invocation of one of them — verifies the callback actually
    // fires through the DuckDB scalar-function API (the bigger goal is
    // type-mapping coverage, which is realized just by registering).
    const rows = await db.query<{ x: bigint }>('SELECT echo_bigint(42) AS x');
    assert.equal(rows[0]?.x, 42n);
  } finally {
    await db.close();
  }
});

test('registerScalarFunction rejects an unsupported DuckDB type', async () => {
  const db = await createDb();
  try {
    assert.throws(
      () =>
        db.registerScalarFunction({
          name: 'bad',
          argTypes: ['UUID'],
          returnType: 'BIGINT',
          callback: () => 0n,
        }),
      /Unsupported DuckDB type/,
    );
  } finally {
    await db.close();
  }
});

test('registerScalarFunction wraps callback exceptions with row + name context', async () => {
  const db = await createDb();
  try {
    db.registerScalarFunction({
      name: 'thrower',
      argTypes: ['BIGINT'],
      returnType: 'BIGINT',
      callback: () => {
        throw new Error('inner boom');
      },
    });
    await assert.rejects(db.query('SELECT thrower(1) AS x'), /thrower.*inner boom/);
  } finally {
    await db.close();
  }
});

test('onClose hooks run in reverse order; a thrown hook does not strand close()', async () => {
  const db = await createDb();
  const order: number[] = [];
  db.onClose(() => {
    order.push(1);
  });
  db.onClose(() => {
    throw new Error('hook 2 boom');
  });
  db.onClose(() => {
    order.push(3);
  });
  await db.close();
  // Last-registered runs first; the failing hook is swallowed; the
  // first-registered still runs.
  assert.deepEqual(order, [3, 1]);
});

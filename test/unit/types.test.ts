import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createDb } from '../../src/storage/db.ts';
import {
  type BqField,
  bqInsertExpression,
  bqRowToDuck,
  bqSelectExpression,
  bqTypeToDuck,
  bqValueToDuck,
  duckRowToBq,
  duckTypeToBq,
  duckValueToBq,
  normalizeBqType,
} from '../../src/storage/types.ts';

// ---------------------------------------------------------------------------
// Pure unit tests
// ---------------------------------------------------------------------------

test('normalizeBqType maps aliases', () => {
  assert.equal(normalizeBqType('INTEGER'), 'INT64');
  assert.equal(normalizeBqType('FLOAT'), 'FLOAT64');
  assert.equal(normalizeBqType('BOOLEAN'), 'BOOL');
  assert.equal(normalizeBqType('RECORD'), 'STRUCT');
  assert.equal(normalizeBqType('string'), 'STRING');
});

test('normalizeBqType throws on an unknown type', () => {
  assert.throws(() => normalizeBqType('NOPE'), /Unknown BigQuery type/);
});

test('bqTypeToDuck maps each scalar BQ type to DuckDB', () => {
  const cases: Array<readonly [BqField['type'], string]> = [
    ['STRING', 'VARCHAR'],
    ['BYTES', 'BLOB'],
    ['INT64', 'BIGINT'],
    ['FLOAT64', 'DOUBLE'],
    ['BOOL', 'BOOLEAN'],
    ['NUMERIC', 'DECIMAL(38, 9)'],
    ['BIGNUMERIC', 'VARCHAR'],
    ['TIMESTAMP', 'TIMESTAMP WITH TIME ZONE'],
    ['DATETIME', 'TIMESTAMP'],
    ['DATE', 'DATE'],
    ['TIME', 'TIME'],
    ['JSON', 'JSON'],
    ['GEOGRAPHY', 'VARCHAR'],
  ];
  for (const [bq, duck] of cases) {
    assert.equal(bqTypeToDuck({ name: 'v', type: bq }), duck);
  }
});

test('bqTypeToDuck appends [] for REPEATED mode', () => {
  assert.equal(bqTypeToDuck({ name: 'v', type: 'INT64', mode: 'REPEATED' }), 'BIGINT[]');
  assert.equal(bqTypeToDuck({ name: 'v', type: 'STRING', mode: 'REPEATED' }), 'VARCHAR[]');
});

test('bqTypeToDuck recurses through STRUCT', () => {
  const field: BqField = {
    name: 's',
    type: 'STRUCT',
    fields: [
      { name: 'a', type: 'INT64' },
      { name: 'b', type: 'STRING' },
    ],
  };
  assert.equal(bqTypeToDuck(field), 'STRUCT("a" BIGINT, "b" VARCHAR)');
});

test('bqTypeToDuck throws on STRUCT with no fields', () => {
  assert.throws(() => bqTypeToDuck({ name: 's', type: 'STRUCT' }), /requires a non-empty fields/);
});

test('duckTypeToBq maps base types', () => {
  assert.equal(duckTypeToBq('VARCHAR', 'x').type, 'STRING');
  assert.equal(duckTypeToBq('BIGINT', 'x').type, 'INT64');
  assert.equal(duckTypeToBq('DOUBLE', 'x').type, 'FLOAT64');
  assert.equal(duckTypeToBq('TIMESTAMP', 'x').type, 'DATETIME');
  assert.equal(duckTypeToBq('TIMESTAMP WITH TIME ZONE', 'x').type, 'TIMESTAMP');
  assert.equal(duckTypeToBq('DECIMAL(38, 9)', 'x').type, 'NUMERIC');
});

test('duckTypeToBq picks up REPEATED from a trailing []', () => {
  const f = duckTypeToBq('BIGINT[]', 'xs');
  assert.equal(f.type, 'INT64');
  assert.equal(f.mode, 'REPEATED');
});

test('duckTypeToBq parses STRUCT inner fields', () => {
  const f = duckTypeToBq('STRUCT("a" BIGINT, "b" VARCHAR)', 's');
  assert.equal(f.type, 'STRUCT');
  assert.equal(f.fields?.length, 2);
  assert.equal(f.fields?.[0]?.name, 'a');
  assert.equal(f.fields?.[0]?.type, 'INT64');
  assert.equal(f.fields?.[1]?.name, 'b');
  assert.equal(f.fields?.[1]?.type, 'STRING');
});

test('duckTypeToBq throws on an unmapped DuckDB type', () => {
  assert.throws(() => duckTypeToBq('UNKNOWN_TYPE', 'x'), /Unmapped/);
});

// ---------------------------------------------------------------------------
// Round-trip through real DuckDB
// ---------------------------------------------------------------------------

async function roundTrip(field: BqField, value: unknown): Promise<unknown> {
  const db = await createDb();
  try {
    const columnDef = bqTypeToDuck({ ...field, name: 'v' });
    await db.exec(`CREATE TABLE t (v ${columnDef})`);
    const insertExpr = bqInsertExpression(1, field);
    const sql = `INSERT INTO t (v) VALUES (${insertExpr})`;
    await db.exec(sql, [bqValueToDuck(value, field)]);
    const selectExpr = bqSelectExpression('v', field);
    const rows = await db.query<{ v: unknown }>(`SELECT ${selectExpr} AS v FROM t`);
    return duckValueToBq(rows[0]?.v, field);
  } finally {
    await db.close();
  }
}

test('round-trip: STRING', async () => {
  assert.equal(await roundTrip({ name: 'v', type: 'STRING' }, 'hello world'), 'hello world');
});

test('round-trip: BYTES (base64 wire format)', async () => {
  const b64 = Buffer.from('binary content').toString('base64');
  assert.equal(await roundTrip({ name: 'v', type: 'BYTES' }, b64), b64);
});

test('round-trip: INT64 (decimal string wire format)', async () => {
  assert.equal(await roundTrip({ name: 'v', type: 'INT64' }, '1234567890123'), '1234567890123');
});

test('round-trip: FLOAT64', async () => {
  const value = Math.E;
  assert.equal(await roundTrip({ name: 'v', type: 'FLOAT64' }, value), value);
});

test('round-trip: BOOL', async () => {
  assert.equal(await roundTrip({ name: 'v', type: 'BOOL' }, true), true);
  assert.equal(await roundTrip({ name: 'v', type: 'BOOL' }, false), false);
});

test('round-trip: NUMERIC (small)', async () => {
  const out = (await roundTrip({ name: 'v', type: 'NUMERIC' }, '123.456')) as string;
  assert.equal(Number(out), 123.456);
});

test('round-trip: BIGNUMERIC', async () => {
  assert.equal(
    await roundTrip(
      { name: 'v', type: 'BIGNUMERIC' },
      '99999999999999999999999999999999999999.123456789',
    ),
    '99999999999999999999999999999999999999.123456789',
  );
});

test('round-trip: TIMESTAMP', async () => {
  assert.equal(
    await roundTrip({ name: 'v', type: 'TIMESTAMP' }, '2026-05-16T10:11:12.000Z'),
    '2026-05-16T10:11:12.000Z',
  );
});

test('round-trip: DATETIME', async () => {
  const out = await roundTrip({ name: 'v', type: 'DATETIME' }, '2026-05-16T10:11:12');
  // DuckDB roundtrips the value; we emit ISO format on read.
  assert.match(out as string, /^2026-05-16T10:11:12/);
});

test('round-trip: DATE', async () => {
  assert.equal(await roundTrip({ name: 'v', type: 'DATE' }, '2026-05-16'), '2026-05-16');
});

test('round-trip: TIME', async () => {
  const out = (await roundTrip({ name: 'v', type: 'TIME' }, '10:11:12')) as string;
  assert.match(out, /^10:11:12/);
});

test('round-trip: JSON', async () => {
  const wire = '{"a":1,"b":"two","c":[1,2,3]}';
  const out = await roundTrip({ name: 'v', type: 'JSON' }, wire);
  assert.deepEqual(JSON.parse(out as string), JSON.parse(wire));
});

test('round-trip: GEOGRAPHY (WKT pass-through)', async () => {
  assert.equal(
    await roundTrip({ name: 'v', type: 'GEOGRAPHY' }, 'POINT(-122.4194 37.7749)'),
    'POINT(-122.4194 37.7749)',
  );
});

test('round-trip: REPEATED STRING', async () => {
  const out = await roundTrip({ name: 'v', type: 'STRING', mode: 'REPEATED' }, [
    'alpha',
    'beta',
    'gamma',
  ]);
  assert.deepEqual(out, ['alpha', 'beta', 'gamma']);
});

test('round-trip: REPEATED INT64', async () => {
  const out = await roundTrip({ name: 'v', type: 'INT64', mode: 'REPEATED' }, ['1', '2', '3']);
  assert.deepEqual(out, ['1', '2', '3']);
});

test('round-trip: STRUCT', async () => {
  const field: BqField = {
    name: 'v',
    type: 'STRUCT',
    fields: [
      { name: 'a', type: 'INT64' },
      { name: 'b', type: 'STRING' },
      { name: 'c', type: 'BOOL' },
    ],
  };
  const input = { a: '42', b: 'hello', c: true };
  const out = await roundTrip(field, input);
  assert.deepEqual(out, input);
});

test('round-trip: REPEATED STRUCT', async () => {
  const field: BqField = {
    name: 'v',
    type: 'STRUCT',
    mode: 'REPEATED',
    fields: [
      { name: 'a', type: 'INT64' },
      { name: 'b', type: 'STRING' },
    ],
  };
  const input = [
    { a: '1', b: 'one' },
    { a: '2', b: 'two' },
  ];
  const out = await roundTrip(field, input);
  assert.deepEqual(out, input);
});

// ---------------------------------------------------------------------------
// Row-level wrappers
// ---------------------------------------------------------------------------

test('bqRowToDuck encodes a row to values in schema field order', () => {
  const schema: readonly BqField[] = [
    { name: 'id', type: 'INT64' },
    { name: 'name', type: 'STRING' },
  ];
  const values = bqRowToDuck({ id: '42', name: 'a' }, schema);
  assert.equal(values.length, 2);
  assert.equal(values[0], 42n);
  assert.equal(values[1], 'a');
});

test('duckRowToBq decodes a DuckDB row to a BQ-shaped object', () => {
  const schema: readonly BqField[] = [
    { name: 'id', type: 'INT64' },
    { name: 'name', type: 'STRING' },
  ];
  const out = duckRowToBq({ id: 42n, name: 'a' }, schema);
  assert.deepEqual(out, { id: '42', name: 'a' });
});

test('row helpers preserve null cells', () => {
  const schema: readonly BqField[] = [{ name: 'id', type: 'INT64', mode: 'NULLABLE' }];
  assert.equal(bqRowToDuck({ id: null }, schema)[0], null);
  assert.equal(duckRowToBq({ id: null }, schema)['id'], null);
});

test('bqValueToDuck throws when REPEATED field receives non-array', () => {
  assert.throws(
    () => bqValueToDuck('not an array', { name: 'v', type: 'STRING', mode: 'REPEATED' }),
    /Expected array/,
  );
});

test('bqValueToDuck throws when STRUCT field receives non-object', () => {
  assert.throws(
    () =>
      bqValueToDuck('not an object', {
        name: 'v',
        type: 'STRUCT',
        fields: [{ name: 'a', type: 'INT64' }],
      }),
    /Expected object/,
  );
});

// ---------------------------------------------------------------------------
// Defensive paths for duckTypeToBq and decoders
// ---------------------------------------------------------------------------

test('duckTypeToBq accepts unquoted STRUCT field names', () => {
  const f = duckTypeToBq('STRUCT(a BIGINT, b VARCHAR)', 's');
  assert.equal(f.type, 'STRUCT');
  assert.equal(f.fields?.[0]?.name, 'a');
  assert.equal(f.fields?.[1]?.name, 'b');
});

test('duckTypeToBq handles an empty STRUCT body', () => {
  const f = duckTypeToBq('STRUCT()', 's');
  assert.equal(f.type, 'STRUCT');
  assert.equal(f.fields?.length, 0);
});

test('duckTypeToBq nested STRUCT inside REPEATED', () => {
  const f = duckTypeToBq('STRUCT("a" INTEGER)[]', 'xs');
  assert.equal(f.mode, 'REPEATED');
  assert.equal(f.type, 'STRUCT');
  assert.equal(f.fields?.[0]?.name, 'a');
});

test('duckValueToBq accepts Uint8Array fallback for BYTES', () => {
  const bytes = new Uint8Array([0x68, 0x69]); // "hi"
  const out = duckValueToBq(bytes, { name: 'v', type: 'BYTES' });
  assert.equal(out, Buffer.from(bytes).toString('base64'));
});

test('duckValueToBq accepts string NUMERIC fallback', () => {
  const out = duckValueToBq('1234567890.123456', { name: 'v', type: 'NUMERIC' });
  assert.equal(out, '1234567890.123456');
});

test('duckValueToBq throws on non-array REPEATED row', () => {
  assert.throws(
    () => duckValueToBq('not array', { name: 'v', type: 'STRING', mode: 'REPEATED' }),
    /Expected array/,
  );
});

test('duckValueToBq throws on non-object STRUCT row', () => {
  assert.throws(
    () =>
      duckValueToBq('not object', {
        name: 'v',
        type: 'STRUCT',
        fields: [{ name: 'a', type: 'INT64' }],
      }),
    /Expected object/,
  );
});

test('bqInsertExpression for REPEATED produces JSON cast', () => {
  const expr = bqInsertExpression(1, { name: 'v', type: 'STRING', mode: 'REPEATED' });
  assert.equal(expr, '$1::JSON::VARCHAR[]');
});

test('bqInsertExpression for STRUCT produces JSON cast to STRUCT type', () => {
  const expr = bqInsertExpression(1, {
    name: 'v',
    type: 'STRUCT',
    fields: [{ name: 'a', type: 'INT64' }],
  });
  assert.equal(expr, '$1::JSON::STRUCT("a" BIGINT)');
});

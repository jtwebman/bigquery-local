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
    ['INTERVAL', 'INTERVAL'],
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
  // FLOAT64 wire format is a decimal string per BQ spec (Int64Value /
  // float-as-string pattern across the response).
  const value = Math.E;
  assert.equal(await roundTrip({ name: 'v', type: 'FLOAT64' }, value), value.toString());
});

test('round-trip: BOOL', async () => {
  // BOOL wire format is the literal strings "true" / "false".
  assert.equal(await roundTrip({ name: 'v', type: 'BOOL' }, true), 'true');
  assert.equal(await roundTrip({ name: 'v', type: 'BOOL' }, false), 'false');
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
  // Wire output is microseconds-since-epoch as a decimal string (BQ's
  // useInt64Timestamp form). Input accepts ISO strings for parameter binding.
  const out = await roundTrip({ name: 'v', type: 'TIMESTAMP' }, '2026-05-16T10:11:12.000Z');
  const expectedUs = String(BigInt(Date.UTC(2026, 4, 16, 10, 11, 12)) * 1000n);
  assert.equal(out, expectedUs);
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

test('round-trip: INTERVAL (Y-M D H:M:S wire format)', async () => {
  // 1 year, 2 months, 3 days, 4h 5m 6.5s.
  assert.equal(await roundTrip({ name: 'v', type: 'INTERVAL' }, '1-2 3 4:5:6.5'), '1-2 3 4:5:6.5');
});

test('round-trip: INTERVAL with only days', async () => {
  assert.equal(await roundTrip({ name: 'v', type: 'INTERVAL' }, '0-0 5 0:0:0'), '0-0 5 0:0:0');
});

test('round-trip: INTERVAL negative', async () => {
  // Whole-interval negation: every non-zero component shares the sign.
  assert.equal(await roundTrip({ name: 'v', type: 'INTERVAL' }, '-1-2 3 0:0:0'), '-1-2 3 0:0:0');
});

test('round-trip: REPEATED STRING (BQ wire wraps each element as {v: ...})', async () => {
  const out = await roundTrip({ name: 'v', type: 'STRING', mode: 'REPEATED' }, [
    'alpha',
    'beta',
    'gamma',
  ]);
  assert.deepEqual(out, [{ v: 'alpha' }, { v: 'beta' }, { v: 'gamma' }]);
});

test('round-trip: REPEATED INT64 (each element {v: <decimal-string>})', async () => {
  const out = await roundTrip({ name: 'v', type: 'INT64', mode: 'REPEATED' }, ['1', '2', '3']);
  assert.deepEqual(out, [{ v: '1' }, { v: '2' }, { v: '3' }]);
});

test('round-trip: STRUCT (BQ wire is {"f": [{"v": ...}, ...]})', async () => {
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
  assert.deepEqual(out, {
    f: [{ v: '42' }, { v: 'hello' }, { v: 'true' }],
  });
});

test('round-trip: REPEATED STRUCT (each element wraps a struct in {v: {f: [...]}})', async () => {
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
  assert.deepEqual(out, [
    { v: { f: [{ v: '1' }, { v: 'one' }] } },
    { v: { f: [{ v: '2' }, { v: 'two' }] } },
  ]);
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

// ---------------------------------------------------------------------------
// Coverage gaps surfaced by BL-021: the JSON-encoder error / dispatch paths
// ---------------------------------------------------------------------------

test('bqValueToDuck: REPEATED FLOAT64 array gets coerced to numbers in JSON', () => {
  // Exercises `structuredEncodeForJson` FLOAT64 branch.
  const field: BqField = { name: 'nums', type: 'FLOAT64', mode: 'REPEATED' };
  const out = bqValueToDuck(['1.5', '2', 3], field);
  assert.equal(out, '[1.5,2,3]');
});

test('bqValueToDuck: REPEATED JSON parses each string element', () => {
  // Exercises `structuredEncodeForJson` JSON branch.
  const field: BqField = { name: 'docs', type: 'JSON', mode: 'REPEATED' };
  const out = bqValueToDuck(['{"a":1}', '{"b":2}'], field) as string;
  // The outer encoder wraps with JSON.stringify, but inner values are parsed.
  assert.deepEqual(JSON.parse(out), [{ a: 1 }, { b: 2 }]);
});

test('bqValueToDuck: REPEATED with a non-array value throws', () => {
  const field: BqField = { name: 'xs', type: 'STRING', mode: 'REPEATED' };
  assert.throws(() => bqValueToDuck('not-an-array', field), /Expected array for REPEATED/);
});

test('duckTypeToBq throws on an unmapped DuckDB type', () => {
  // `STRUCT` without an opening paren falls through to the unmapped-type path.
  assert.throws(() => duckTypeToBq('STRUCT something-without-parens', 'x'), /Unmapped DuckDB type/);
});

test('duckTypeToBq throws on STRUCT(…  with no closing paren', () => {
  // Reaches parseStructFields; trailing `)` missing → Malformed STRUCT type.
  assert.throws(() => duckTypeToBq('STRUCT(foo BIGINT', 'x'), /Malformed STRUCT type/);
});

test('duckValueToBq: NUMERIC integer-valued number gets a trailing .0', () => {
  // Exercises `trimDecimal` integer branch (the `.0` append). DuckDB returns
  // small DECIMALs as a JS number; trimDecimal makes sure integer-valued
  // NUMERIC still serializes as a decimal string ("1.0", not "1").
  const field: BqField = { name: 'amount', type: 'NUMERIC' };
  assert.equal(duckValueToBq(1, field), '1.0');
});

test('bqValueToDuck: STRUCT containing a REPEATED sub-field rejects non-array sub-value', () => {
  // Exercises `structuredEncodeForJson` REPEATED-non-array branch (the
  // nested case, reached via STRUCT recursion rather than directly).
  const field: BqField = {
    name: 's',
    type: 'STRUCT',
    fields: [{ name: 'tags', type: 'STRING', mode: 'REPEATED' }],
  };
  assert.throws(
    () => bqValueToDuck({ tags: 'not-an-array' }, field),
    /Expected array for REPEATED field "tags"/,
  );
});

// ---------------------------------------------------------------------------
// Wire-encoding edge cases (cf. test/api/sql-wire-fidelity.test.ts for the
// end-to-end audits; these cover values DuckDB can't produce through SQL).
// ---------------------------------------------------------------------------

test('duckValueToBq: FLOAT64 Infinity renders as the literal string "Infinity"', () => {
  const field: BqField = { name: 'f', type: 'FLOAT64' };
  assert.equal(duckValueToBq(Number.POSITIVE_INFINITY, field), 'Infinity');
  assert.equal(duckValueToBq(Number.NEGATIVE_INFINITY, field), '-Infinity');
  assert.equal(duckValueToBq(Number.NaN, field), 'NaN');
});

test('duckValueToBq: BOOL true/false render as literal strings', () => {
  const field: BqField = { name: 'b', type: 'BOOL' };
  assert.equal(duckValueToBq(true, field), 'true');
  assert.equal(duckValueToBq(false, field), 'false');
});

test('duckValueToBq: BIGNUMERIC long decimal string passes through verbatim', () => {
  const field: BqField = { name: 'n', type: 'BIGNUMERIC' };
  const big = '578960446186580977117854925043439539266';
  assert.equal(duckValueToBq(big, field), big);
});

test('duckValueToBq: STRUCT wraps as {"f": [{"v": ...}, ...]} recursively', () => {
  const field: BqField = {
    name: 's',
    type: 'STRUCT',
    fields: [
      { name: 'id', type: 'INT64' },
      { name: 'msg', type: 'STRING' },
    ],
  };
  assert.deepEqual(duckValueToBq({ id: 1n, msg: 'hi' }, field), {
    f: [{ v: '1' }, { v: 'hi' }],
  });
});

test('duckValueToBq: REPEATED ARRAY wraps each element as {"v": ...}', () => {
  const field: BqField = { name: 'xs', type: 'INT64', mode: 'REPEATED' };
  assert.deepEqual(duckValueToBq([1n, 2n, null], field), [{ v: '1' }, { v: '2' }, { v: null }]);
});

test('duckValueToBq: REPEATED STRUCT wraps each cell as {"v": {"f": [...]}}', () => {
  const field: BqField = {
    name: 'rows',
    type: 'STRUCT',
    mode: 'REPEATED',
    fields: [{ name: 'n', type: 'INT64' }],
  };
  assert.deepEqual(duckValueToBq([{ n: 1n }, { n: 2n }], field), [
    { v: { f: [{ v: '1' }] } },
    { v: { f: [{ v: '2' }] } },
  ]);
});

test('duckValueToBq: TIMESTAMP from a Date renders microseconds-since-epoch', () => {
  const field: BqField = { name: 't', type: 'TIMESTAMP' };
  const date = new Date(Date.UTC(2026, 4, 17, 10, 30, 0));
  assert.equal(duckValueToBq(date, field), String(BigInt(date.getTime()) * 1000n));
});

test('duckValueToBq: TIMESTAMP accepts bigint (DuckDB epoch_us) and number (epoch_ms)', () => {
  const field: BqField = { name: 't', type: 'TIMESTAMP' };
  // bigint path: already microseconds, passed through.
  assert.equal(duckValueToBq(1779013800000000n, field), '1779013800000000');
  // number path: treated as milliseconds-since-epoch, multiplied to micros.
  assert.equal(duckValueToBq(1779013800000, field), '1779013800000000');
});

test('duckValueToBq: TIMESTAMP with a string falls back to String() coercion', () => {
  const field: BqField = { name: 't', type: 'TIMESTAMP' };
  assert.equal(duckValueToBq('2026-05-17T10:30:00Z', field), '2026-05-17T10:30:00Z');
});

test('duckValueToBq: DATETIME from a Date drops the trailing Z', () => {
  const field: BqField = { name: 'dt', type: 'DATETIME' };
  const date = new Date(Date.UTC(2026, 4, 17, 12, 34, 56));
  assert.equal(duckValueToBq(date, field), '2026-05-17T12:34:56.000');
});

test('duckValueToBq: DATETIME with a string passes through verbatim', () => {
  const field: BqField = { name: 'dt', type: 'DATETIME' };
  assert.equal(duckValueToBq('2026-05-17T12:34:56', field), '2026-05-17T12:34:56');
});

test('duckValueToBq: TIME from a Date renders HH:MM:SS.fff', () => {
  const field: BqField = { name: 't', type: 'TIME' };
  const epochPlusTime = new Date(Date.UTC(1970, 0, 1, 12, 34, 56, 789));
  assert.equal(duckValueToBq(epochPlusTime, field), '12:34:56.789');
});

test('duckValueToBq: TIME with zero microseconds drops the fractional part', () => {
  const field: BqField = { name: 't', type: 'TIME' };
  const noFraction = 12n * 3600n * 1_000_000n;
  assert.equal(duckValueToBq(noFraction, field), '12:00:00');
});

test('duckValueToBq: TIME with neither Date nor bigint falls back to String()', () => {
  const field: BqField = { name: 't', type: 'TIME' };
  assert.equal(duckValueToBq('10:11:12', field), '10:11:12');
});

test('duckValueToBq: FLOAT64 with a non-number value falls back to String()', () => {
  const field: BqField = { name: 'f', type: 'FLOAT64' };
  assert.equal(duckValueToBq('3.14', field), '3.14');
});

/**
 * Coverage for `src/grpc-impl/avroRows.ts` — exercises every BqType +
 * mode branch of `avroSelectExpression` and the encoder.
 *
 * The encoder is verified by encoding via `createAvroRowEncoder` and
 * decoding back with raw `avsc.Type.forSchema(...)` so we never trust
 * one side of the round-trip alone.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import avsc from 'avsc';

import { avroSelectExpression, createAvroRowEncoder } from '../../src/grpc-impl/avroRows.ts';
import { bqSchemaToAvroJson } from '../../src/grpc-impl/avroSchema.ts';
import type { BqField } from '../../src/storage/types.ts';

function decode(schemaJson: string, bytes: Buffer): Record<string, unknown> {
  const type = avsc.Type.forSchema(JSON.parse(schemaJson));
  const { value, offset } = type.decode(bytes, 0);
  assert.equal(offset, bytes.length, 'decoder consumed exactly the bytes we wrote');
  return value as Record<string, unknown>;
}

test('avroSelectExpression covers every BQ type', () => {
  const cases: ReadonlyArray<[BqField, string]> = [
    [{ name: 'a', type: 'STRING' }, '"a"'],
    [{ name: 'a', type: 'INT64' }, '"a"'],
    [{ name: 'a', type: 'FLOAT64' }, '"a"'],
    [{ name: 'a', type: 'BOOL' }, '"a"'],
    [{ name: 'a', type: 'BYTES' }, '"a"'],
    [{ name: 'a', type: 'JSON' }, '"a"'],
    [{ name: 'a', type: 'INTERVAL' }, '"a"'],
    [{ name: 'a', type: 'RANGE' }, '"a"'],
    [{ name: 'a', type: 'GEOGRAPHY' }, `replace(ST_AsText("a"), ' (', '(')`],
    [{ name: 'a', type: 'NUMERIC' }, '"a"::VARCHAR'],
    [{ name: 'a', type: 'BIGNUMERIC' }, '"a"::VARCHAR'],
    [{ name: 'a', type: 'TIMESTAMP' }, 'epoch_us("a")::BIGINT'],
    // DATETIME is projected as an ISO string (BQ encodes it as Avro `string`).
    [{ name: 'a', type: 'DATETIME' }, `strftime("a", '%Y-%m-%dT%H:%M:%S.%f')`],
    [{ name: 'a', type: 'DATE' }, `date_diff('day', DATE '1970-01-01', "a")::INTEGER`],
    [{ name: 'a', type: 'STRUCT', fields: [] }, '"a"'],
  ];
  for (const [field, expected] of cases) {
    assert.equal(avroSelectExpression('a', field), expected, `${field.type} projection`);
  }
  assert.equal(
    avroSelectExpression('a', { name: 'a', type: 'STRING', mode: 'REPEATED' }),
    '"a"',
    'REPEATED mode short-circuits to the bare identifier',
  );
  // TIME has its own bespoke decomposition.
  assert.match(avroSelectExpression('t', { name: 't', type: 'TIME' }), /date_part\('hour'/);
});

test('encoder round-trips every scalar+mode combination', () => {
  const fields: BqField[] = [
    { name: 'str', type: 'STRING' },
    { name: 'i64', type: 'INT64', mode: 'REQUIRED' },
    { name: 'f64', type: 'FLOAT64' },
    { name: 'bool', type: 'BOOL' },
    { name: 'bytes', type: 'BYTES' },
    { name: 'json', type: 'JSON' },
    { name: 'geo', type: 'GEOGRAPHY' },
    { name: 'iv', type: 'INTERVAL' },
    { name: 'range', type: 'RANGE' },
    { name: 'd', type: 'DATE' },
    { name: 'ts', type: 'TIMESTAMP' },
    { name: 'dt', type: 'DATETIME' },
    { name: 'tm', type: 'TIME' },
    { name: 'num', type: 'NUMERIC' },
    { name: 'bnum', type: 'BIGNUMERIC' },
    { name: 'tags', type: 'STRING', mode: 'REPEATED' },
  ];
  const schemaJson = bqSchemaToAvroJson('t', fields);
  const encoder = createAvroRowEncoder(schemaJson, fields);
  // The "DuckDB-projected" values: bigint for INT64 / TIMESTAMP / DATETIME / TIME,
  // number for DATE, string for NUMERIC/BIGNUMERIC (decimal as string), Uint8Array for BYTES.
  const row = {
    str: 'hello',
    i64: 42n,
    f64: 1.25,
    bool: true,
    bytes: Buffer.from([0x01, 0x02, 0x03]),
    json: '{"a":1}',
    geo: 'POINT(0 0)',
    iv: '0-0 0 0:0:0',
    range: '[2024-01-01, 2024-12-31)',
    d: 7409, // 1990-04-15 as days since epoch
    ts: 1_704_164_645_000_000n, // 2024-01-02T03:04:05Z micros
    dt: '2024-01-02T03:04:05.000000', // DATETIME projected as ISO string
    tm: 27_000_000_000n, // 07:30:00 in micros
    num: '12.5',
    bnum: '-1.5',
    tags: ['a', 'b'],
  };
  const encoded = encoder.encodeRow(row);
  const decoded = decode(schemaJson, encoded);
  assert.equal(decoded['str'], 'hello');
  assert.equal(decoded['i64'], 42);
  assert.equal(decoded['f64'], 1.25);
  assert.equal(decoded['bool'], true);
  assert.deepEqual([...(decoded['bytes'] as Buffer)], [0x01, 0x02, 0x03]);
  assert.equal(decoded['d'], 7409);
  assert.equal(decoded['ts'], 1_704_164_645_000_000);
  assert.equal(decoded['tm'], 27_000_000_000);
  assert.deepEqual(decoded['tags'], ['a', 'b']);
  // NUMERIC: encoded as decimal bytes; decoded raw = unscaled two's-complement.
  // 12.5 with scale 9 = 12_500_000_000
  const numBytes = decoded['num'] as Buffer;
  let unscaled = 0n;
  for (const b of numBytes) unscaled = (unscaled << 8n) | BigInt(b);
  assert.equal(unscaled, 12_500_000_000n);
  // BIGNUMERIC: -1.5 at scale 38 → -1.5 * 10^38 = -1.5e38
  const bnumBytes = decoded['bnum'] as Buffer;
  let raw = 0n;
  for (const b of bnumBytes) raw = (raw << 8n) | BigInt(b);
  // two's-complement decode for negative
  if ((bnumBytes[0] ?? 0) & 0x80) raw -= 1n << BigInt(bnumBytes.length * 8);
  assert.equal(raw, -150000000000000000000000000000000000000n);
});

test('encoder handles NULL for NULLABLE fields', () => {
  const fields: BqField[] = [
    { name: 'id', type: 'INT64', mode: 'REQUIRED' },
    { name: 'maybe', type: 'STRING' },
  ];
  const schemaJson = bqSchemaToAvroJson('t', fields);
  const encoder = createAvroRowEncoder(schemaJson, fields);
  const encoded = encoder.encodeRow({ id: 5n, maybe: null });
  const decoded = decode(schemaJson, encoded);
  assert.equal(decoded['id'], 5);
  assert.equal(decoded['maybe'], null);
});

test('encoder handles NULL repeated field as empty array', () => {
  const fields: BqField[] = [{ name: 'tags', type: 'STRING', mode: 'REPEATED' }];
  const schemaJson = bqSchemaToAvroJson('t', fields);
  const encoder = createAvroRowEncoder(schemaJson, fields);
  const encoded = encoder.encodeRow({ tags: null });
  const decoded = decode(schemaJson, encoded);
  assert.deepEqual(decoded['tags'], []);
});

test('encoder handles nested STRUCT including NULL parent', () => {
  const fields: BqField[] = [
    { name: 'id', type: 'INT64', mode: 'REQUIRED' },
    {
      name: 'addr',
      type: 'STRUCT',
      mode: 'NULLABLE',
      fields: [
        { name: 'street', type: 'STRING', mode: 'REQUIRED' },
        { name: 'zip', type: 'STRING' },
      ],
    },
  ];
  const schemaJson = bqSchemaToAvroJson('t', fields);
  const encoder = createAvroRowEncoder(schemaJson, fields);
  const row1 = encoder.encodeRow({ id: 1n, addr: { street: '1 St', zip: '01234' } });
  const row2 = encoder.encodeRow({ id: 2n, addr: null });
  const decoded1 = decode(schemaJson, row1);
  const decoded2 = decode(schemaJson, row2);
  assert.equal((decoded1['addr'] as { street: string; zip: string | null }).street, '1 St');
  assert.equal(decoded2['addr'], null);
});

test('encodeBatch concatenates rows; empty batch returns an empty buffer', () => {
  const fields: BqField[] = [{ name: 'id', type: 'INT64', mode: 'REQUIRED' }];
  const encoder = createAvroRowEncoder(bqSchemaToAvroJson('t', fields), fields);
  const batchBytes = encoder.encodeBatch([{ id: 1n }, { id: 2n }, { id: 3n }]);
  // Each long-encoded as Avro zigzag varint: 1→0x02, 2→0x04, 3→0x06
  assert.deepEqual([...batchBytes], [0x02, 0x04, 0x06]);
  assert.equal(encoder.encodeBatch([]).length, 0);
});

test("NUMERIC negative values encode as two's-complement bytes", () => {
  const fields: BqField[] = [{ name: 'amt', type: 'NUMERIC', mode: 'REQUIRED' }];
  const schemaJson = bqSchemaToAvroJson('t', fields);
  const encoder = createAvroRowEncoder(schemaJson, fields);
  const encoded = encoder.encodeRow({ amt: '-1' });
  const decoded = decode(schemaJson, encoded);
  // unscaled = -1 * 10^9 = -1_000_000_000
  const bytes = decoded['amt'] as Buffer;
  let raw = 0n;
  for (const b of bytes) raw = (raw << 8n) | BigInt(b);
  if ((bytes[0] ?? 0) & 0x80) raw -= 1n << BigInt(bytes.length * 8);
  assert.equal(raw, -1_000_000_000n);
});

test('NUMERIC zero encodes as 16 zero bytes (BQ-conformant fixed width)', () => {
  const fields: BqField[] = [{ name: 'amt', type: 'NUMERIC', mode: 'REQUIRED' }];
  const schemaJson = bqSchemaToAvroJson('t', fields);
  const encoder = createAvroRowEncoder(schemaJson, fields);
  const encoded = encoder.encodeRow({ amt: '0' });
  const decoded = decode(schemaJson, encoded);
  const bytes = decoded['amt'] as Buffer;
  assert.equal(bytes.length, 16);
  assert.ok(bytes.every((b) => b === 0));
});

test('BIGNUMERIC pads to 32 bytes', () => {
  const fields: BqField[] = [{ name: 'amt', type: 'BIGNUMERIC', mode: 'REQUIRED' }];
  const schemaJson = bqSchemaToAvroJson('t', fields);
  const encoder = createAvroRowEncoder(schemaJson, fields);
  const decoded = decode(schemaJson, encoder.encodeRow({ amt: '0' })) as { amt: Buffer };
  assert.equal(decoded.amt.length, 32);
});

test('REPEATED rejects non-array input', () => {
  const fields: BqField[] = [{ name: 'tags', type: 'STRING', mode: 'REPEATED' }];
  const encoder = createAvroRowEncoder(bqSchemaToAvroJson('t', fields), fields);
  assert.throws(
    () => encoder.encodeRow({ tags: 'not-an-array' as unknown as readonly string[] }),
    /Expected array for REPEATED/,
  );
});

test('STRUCT rejects array or scalar input', () => {
  const fields: BqField[] = [
    {
      name: 's',
      type: 'STRUCT',
      mode: 'REQUIRED',
      fields: [{ name: 'x', type: 'INT64', mode: 'REQUIRED' }],
    },
  ];
  const encoder = createAvroRowEncoder(bqSchemaToAvroJson('t', fields), fields);
  assert.throws(
    () => encoder.encodeRow({ s: [1] as unknown as Record<string, unknown> }),
    /STRUCT/,
  );
});

/**
 * Coverage for src/grpc-impl/avroSchema.ts — every BigQuery scalar +
 * mode combination maps to the Avro type Storage Read returns.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { bqSchemaToAvroJson } from '../../src/grpc-impl/avroSchema.ts';
import type { BqField } from '../../src/storage/types.ts';

interface AvroField {
  name: string;
  type: unknown;
  default?: unknown;
}

function build(fields: readonly BqField[]): AvroField[] {
  const schema = JSON.parse(bqSchemaToAvroJson('t', fields)) as { fields: AvroField[] };
  return schema.fields;
}

test('every scalar BQ type maps to the expected Avro shape (NULLABLE default)', () => {
  const fields: BqField[] = [
    { name: 's', type: 'STRING' },
    { name: 'b', type: 'BYTES' },
    { name: 'i', type: 'INT64' },
    { name: 'f', type: 'FLOAT64' },
    { name: 'bo', type: 'BOOL' },
    { name: 'n', type: 'NUMERIC' },
    { name: 'bn', type: 'BIGNUMERIC' },
    { name: 'ts', type: 'TIMESTAMP' },
    { name: 'dt', type: 'DATETIME' },
    { name: 'd', type: 'DATE' },
    { name: 'tm', type: 'TIME' },
    { name: 'j', type: 'JSON' },
    { name: 'g', type: 'GEOGRAPHY' },
    { name: 'iv', type: 'INTERVAL' },
    { name: 'r', type: 'RANGE' },
  ];
  const out = build(fields);
  assert.deepEqual(out[0]?.type, ['null', 'string']);
  assert.deepEqual(out[1]?.type, ['null', 'bytes']);
  assert.deepEqual(out[2]?.type, ['null', 'long']);
  assert.deepEqual(out[3]?.type, ['null', 'double']);
  assert.deepEqual(out[4]?.type, ['null', 'boolean']);
  assert.deepEqual(out[5]?.type, [
    'null',
    { type: 'bytes', logicalType: 'decimal', precision: 38, scale: 9 },
  ]);
  // Real BQ emits BIGNUMERIC precision=77 (the storage width), not 76.
  assert.deepEqual(out[6]?.type, [
    'null',
    { type: 'bytes', logicalType: 'decimal', precision: 77, scale: 38 },
  ]);
  assert.deepEqual(out[7]?.type, ['null', { type: 'long', logicalType: 'timestamp-micros' }]);
  // BQ encodes DATETIME as an ISO string with a custom `datetime` logical type.
  assert.deepEqual(out[8]?.type, ['null', { type: 'string', logicalType: 'datetime' }]);
  assert.deepEqual(out[9]?.type, ['null', { type: 'int', logicalType: 'date' }]);
  assert.deepEqual(out[10]?.type, ['null', { type: 'long', logicalType: 'time-micros' }]);
  // BQ tags JSON columns with `sqlType: JSON` on the Avro string.
  assert.deepEqual(out[11]?.type, ['null', { type: 'string', sqlType: 'JSON' }]);
  assert.deepEqual(out[12]?.type, ['null', 'string']); // GEOGRAPHY
  assert.deepEqual(out[13]?.type, ['null', 'string']); // INTERVAL
  assert.deepEqual(out[14]?.type, ['null', 'string']); // RANGE
});

test('REQUIRED drops the [null, T] union; REPEATED wraps in array', () => {
  const out = build([
    { name: 'a', type: 'INT64', mode: 'REQUIRED' },
    { name: 'b', type: 'INT64', mode: 'REPEATED' },
  ]);
  assert.equal(out[0]?.type, 'long');
  assert.deepEqual(out[1]?.type, { type: 'array', items: 'long' });
});

test('STRUCT becomes an Avro record with the right inner fields', () => {
  const out = build([
    {
      name: 'addr',
      type: 'STRUCT',
      mode: 'REQUIRED',
      fields: [
        { name: 'street', type: 'STRING', mode: 'REQUIRED' },
        { name: 'zip', type: 'STRING' },
      ],
    },
  ]);
  // Real BQ uses `__s_0`, `__s_1`, … for nested record names, and
  // doesn't emit `default: null` on NULLABLE unions.
  assert.deepEqual(out[0]?.type, {
    type: 'record',
    name: '__s_0',
    fields: [
      { name: 'street', type: 'string' },
      { name: 'zip', type: ['null', 'string'] },
    ],
  });
});

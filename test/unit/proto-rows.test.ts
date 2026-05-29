/**
 * Coverage for `src/grpc-impl/protoRows.ts`:
 *   - DescriptorProto → protobufjs Type compilation across every
 *     supported FieldDescriptorProto.Type, in both the numeric and
 *     `TYPE_*` symbolic enum encodings.
 *   - REPEATED label round-trips through both `3` and `LABEL_REPEATED`.
 *   - per-BqType conversion of the decoded proto value to the BQ-wire
 *     shape `bqValueToDuck` expects (INT64 / FLOAT64 / BOOL / BYTES /
 *     DATE / TIME / TIMESTAMP / NUMERIC / STRUCT / REPEATED / nulls).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  compileWriterSchema,
  convertField,
  protoRowToValues,
} from '../../src/grpc-impl/protoRows.ts';
import type { BqField } from '../../src/storage/types.ts';

test('compileWriterSchema accepts numeric FieldDescriptorProto.Type values', () => {
  const type = compileWriterSchema({
    name: 'NumRow',
    field: [
      { name: 'a', number: 1, type: 1, label: 1 }, // DOUBLE
      { name: 'b', number: 2, type: 2, label: 1 }, // FLOAT
      { name: 'c', number: 3, type: 4, label: 1 }, // UINT64
      { name: 'd', number: 4, type: 5, label: 1 }, // INT32
      { name: 'e', number: 5, type: 6, label: 1 }, // FIXED64
      { name: 'f', number: 6, type: 7, label: 1 }, // FIXED32
      { name: 'g', number: 7, type: 12, label: 1 }, // BYTES
      { name: 'h', number: 8, type: 13, label: 1 }, // UINT32
      { name: 'i', number: 9, type: 15, label: 1 }, // SFIXED32
      { name: 'j', number: 10, type: 16, label: 1 }, // SFIXED64
      { name: 'k', number: 11, type: 17, label: 1 }, // SINT32
      { name: 'l', number: 12, type: 18, label: 1 }, // SINT64
    ],
  });
  // Round-trip encode/decode proves every field type is recognized.
  const buf = type.encode(type.fromObject({ a: 1.5, b: 2.5, d: 7 })).finish();
  const back = type.toObject(type.decode(buf));
  assert.equal(back['a'], 1.5);
  assert.equal(back['d'], 7);
});

test('compileWriterSchema accepts TYPE_* string enum names', () => {
  const type = compileWriterSchema({
    name: 'StrEnumRow',
    field: [
      { name: 'a', number: 1, type: 'TYPE_INT64', label: 'LABEL_OPTIONAL' },
      { name: 'b', number: 2, type: 'TYPE_STRING', label: 'LABEL_REPEATED' },
    ],
  });
  const buf = type.encode(type.fromObject({ a: 42, b: ['x', 'y'] })).finish();
  const back = type.toObject(type.decode(buf), { longs: String });
  assert.equal(back['a'], '42');
  assert.deepEqual(back['b'], ['x', 'y']);
});

test('compileWriterSchema rejects unsupported / malformed field descriptors', () => {
  assert.throws(
    () =>
      compileWriterSchema({
        name: 'Bad',
        field: [{ name: 'x', number: 1, type: 99 }],
      }),
    /Unsupported FieldDescriptorProto.Type 99/,
  );
  assert.throws(
    () =>
      compileWriterSchema({
        name: 'BadStr',
        field: [{ name: 'x', number: 1, type: 'TYPE_BOGUS' }],
      }),
    /Unsupported FieldDescriptorProto.Type TYPE_BOGUS/,
  );
  assert.throws(
    () =>
      compileWriterSchema({
        name: 'NoType',
        field: [{ name: 'x', number: 1 }],
      }),
    /missing name\/number\/type/,
  );
});

test('compileWriterSchema handles MESSAGE + ENUM (delegated to typeName)', () => {
  const type = compileWriterSchema({
    name: 'WithNested',
    field: [
      { name: 'sub', number: 1, type: 11, typeName: 'Inner', label: 1 },
      { name: 'kind', number: 2, type: 14, typeName: 'int32', label: 1 },
    ],
    nestedType: [
      {
        name: 'Inner',
        field: [{ name: 'v', number: 1, type: 5, label: 1 }],
      },
    ],
  });
  const buf = type.encode(type.fromObject({ sub: { v: 7 }, kind: 3 })).finish();
  const back = type.toObject(type.decode(buf)) as { sub: { v: number }; kind: number };
  assert.equal(back.sub.v, 7);
  assert.equal(back.kind, 3);
});

test('convertField + protoRowToValues — INT64 number/bigint/string variants', () => {
  const fields: BqField[] = [{ name: 'id', type: 'INT64', mode: 'REQUIRED' }];
  assert.deepEqual(protoRowToValues({ id: 42 }, fields), ['42']);
  assert.deepEqual(protoRowToValues({ id: 99n }, fields), ['99']);
  assert.deepEqual(protoRowToValues({ id: '7' }, fields), ['7']);
  // Long-shaped { toString } objects (protobufjs default for int64).
  assert.deepEqual(protoRowToValues({ id: { toString: () => '12345' } }, fields), ['12345']);
});

test('convertField BYTES — Uint8Array → base64', () => {
  const field: BqField = { name: 'b', type: 'BYTES' };
  assert.equal(convertField(new Uint8Array([0x68, 0x69]), field), 'aGk='); // "hi"
  // Pre-base64 string passes through.
  assert.equal(convertField('aGk=', field), 'aGk=');
});

test('convertField FLOAT64 / BOOL coercions', () => {
  assert.equal(convertField('1.5', { name: 'x', type: 'FLOAT64' }), 1.5);
  assert.equal(convertField(true, { name: 'x', type: 'BOOL' }), true);
  assert.equal(convertField('true', { name: 'x', type: 'BOOL' }), true);
  assert.equal(convertField('false', { name: 'x', type: 'BOOL' }), false);
});

test('convertField DATE — proto int days → YYYY-MM-DD', () => {
  // 7409 days = 1990-04-15.
  assert.equal(convertField(7409, { name: 'd', type: 'DATE' }), '1990-04-15');
  // Epoch.
  assert.equal(convertField(0, { name: 'd', type: 'DATE' }), '1970-01-01');
});

test('convertField TIME — proto int micros → HH:MM:SS[.SSSSSS]', () => {
  // 07:30:00 = 27_000_000_000 µs.
  assert.equal(convertField('27000000000', { name: 't', type: 'TIME' }), '07:30:00');
  // 12:00:00.123456.
  assert.equal(convertField('43200123456', { name: 't', type: 'TIME' }), '12:00:00.123456');
});

test('convertField TIMESTAMP / DATETIME — proto int µs round-trip as string', () => {
  assert.equal(
    convertField('1704164645000000', { name: 'ts', type: 'TIMESTAMP' }),
    '1704164645000000',
  );
  assert.equal(
    convertField('1704164645000000', { name: 'dt', type: 'DATETIME' }),
    '1704164645000000',
  );
});

test('convertField NUMERIC / BIGNUMERIC — proto string stays string', () => {
  assert.equal(convertField('12.5', { name: 'n', type: 'NUMERIC' }), '12.5');
  assert.equal(convertField('-99.999', { name: 'n', type: 'BIGNUMERIC' }), '-99.999');
});

test('convertField JSON / GEOGRAPHY / INTERVAL / RANGE — coerce to string', () => {
  assert.equal(convertField('{"a":1}', { name: 'j', type: 'JSON' }), '{"a":1}');
  assert.equal(convertField('POINT(0 0)', { name: 'g', type: 'GEOGRAPHY' }), 'POINT(0 0)');
  assert.equal(convertField('0-0 0 0:0:0', { name: 'i', type: 'INTERVAL' }), '0-0 0 0:0:0');
  // RANGE pass-through as string; non-string serializes to JSON.
  assert.equal(
    convertField('[2024-01-01, 2024-12-31)', { name: 'r', type: 'RANGE' }),
    '[2024-01-01, 2024-12-31)',
  );
  assert.equal(
    convertField({ start: '2024-01-01' }, { name: 'r', type: 'RANGE' }),
    '{"start":"2024-01-01"}',
  );
});

test('convertField REPEATED — wraps inner conversion in array', () => {
  const field: BqField = { name: 'tags', type: 'STRING', mode: 'REPEATED' };
  assert.deepEqual(convertField(['a', 'b'], field), ['a', 'b']);
  // null repeated → null (not empty array, matches bqInsertExpression).
  assert.equal(convertField(null, field), null);
  // Non-array on REPEATED → throws.
  assert.throws(() => convertField('not-an-array', field), /expects array/);
});

test('convertField STRUCT — recurses into sub-fields', () => {
  const field: BqField = {
    name: 'addr',
    type: 'STRUCT',
    mode: 'NULLABLE',
    fields: [
      { name: 'street', type: 'STRING', mode: 'REQUIRED' },
      { name: 'zip', type: 'STRING' },
    ],
  };
  assert.deepEqual(convertField({ street: '1 St', zip: '01234' }, field), {
    street: '1 St',
    zip: '01234',
  });
  // null parent → null.
  assert.equal(convertField(null, field), null);
  // Array on STRUCT → throws.
  assert.throws(() => convertField(['1 St'], field), /expects an object/);
});

test('convertField passes null/undefined through as null', () => {
  const field: BqField = { name: 'x', type: 'INT64' };
  assert.equal(convertField(null, field), null);
  assert.equal(convertField(undefined, field), null);
});

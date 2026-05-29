/**
 * Unit tests for `bqSchemaToArrowSchema` — pins the BQ → Arrow type
 * mapping. Covers every supported BQ type so each branch of
 * `baseArrowType` executes at least once.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  Binary,
  Bool,
  DateUnit,
  Date_,
  Decimal,
  Float64,
  Int64,
  List,
  Struct,
  Time,
  TimeUnit,
  Timestamp,
  Utf8,
} from 'apache-arrow';

import { bqSchemaToArrowSchema } from '../../src/grpc-impl/arrowSchema.ts';
import type { BqField } from '../../src/storage/types.ts';

function schemaFor(field: BqField) {
  return bqSchemaToArrowSchema([field]).fields[0];
}

test('bqSchemaToArrowSchema: STRING → Utf8', () => {
  const f = schemaFor({ name: 'v', type: 'STRING' });
  assert.ok(f?.type instanceof Utf8);
  assert.equal(f?.nullable, true);
});

test('bqSchemaToArrowSchema: BYTES → Binary', () => {
  assert.ok(schemaFor({ name: 'v', type: 'BYTES' })?.type instanceof Binary);
});

test('bqSchemaToArrowSchema: INT64 → Int64', () => {
  assert.ok(schemaFor({ name: 'v', type: 'INT64' })?.type instanceof Int64);
});

test('bqSchemaToArrowSchema: FLOAT64 → Float64', () => {
  assert.ok(schemaFor({ name: 'v', type: 'FLOAT64' })?.type instanceof Float64);
});

test('bqSchemaToArrowSchema: BOOL → Bool', () => {
  assert.ok(schemaFor({ name: 'v', type: 'BOOL' })?.type instanceof Bool);
});

test('bqSchemaToArrowSchema: DATE → Date_(DAY)', () => {
  const t = schemaFor({ name: 'v', type: 'DATE' })?.type;
  assert.ok(t instanceof Date_);
  assert.equal((t as Date_).unit, DateUnit.DAY);
});

test('bqSchemaToArrowSchema: TIME → Time(MICROSECOND, 64)', () => {
  const t = schemaFor({ name: 'v', type: 'TIME' })?.type;
  assert.ok(t instanceof Time);
  assert.equal((t as Time).unit, TimeUnit.MICROSECOND);
});

test('bqSchemaToArrowSchema: TIMESTAMP → Timestamp(MICROSECOND, UTC)', () => {
  const t = schemaFor({ name: 'v', type: 'TIMESTAMP' })?.type;
  assert.ok(t instanceof Timestamp);
  assert.equal((t as Timestamp).timezone, 'UTC');
});

test('bqSchemaToArrowSchema: DATETIME → Timestamp(MICROSECOND, null)', () => {
  const t = schemaFor({ name: 'v', type: 'DATETIME' })?.type;
  assert.ok(t instanceof Timestamp);
  assert.equal((t as Timestamp).timezone, null);
});

test('bqSchemaToArrowSchema: NUMERIC → Decimal(9, 38, 128)', () => {
  const t = schemaFor({ name: 'v', type: 'NUMERIC' })?.type;
  assert.ok(t instanceof Decimal);
  assert.equal((t as Decimal).scale, 9);
  assert.equal((t as Decimal).precision, 38);
  assert.equal((t as Decimal).bitWidth, 128);
});

test('bqSchemaToArrowSchema: BIGNUMERIC → Decimal(38, 76, 256)', () => {
  const t = schemaFor({ name: 'v', type: 'BIGNUMERIC' })?.type;
  assert.ok(t instanceof Decimal);
  assert.equal((t as Decimal).scale, 38);
  assert.equal((t as Decimal).precision, 76);
  assert.equal((t as Decimal).bitWidth, 256);
});

test('bqSchemaToArrowSchema: JSON / GEOGRAPHY / INTERVAL → Utf8', () => {
  assert.ok(schemaFor({ name: 'v', type: 'JSON' })?.type instanceof Utf8);
  assert.ok(schemaFor({ name: 'v', type: 'GEOGRAPHY' })?.type instanceof Utf8);
  assert.ok(schemaFor({ name: 'v', type: 'INTERVAL' })?.type instanceof Utf8);
});

test('bqSchemaToArrowSchema: RANGE<DATE> → Utf8 (fallback string repr)', () => {
  const t = schemaFor({
    name: 'v',
    type: 'RANGE',
    rangeElementType: { type: 'DATE' },
  })?.type;
  assert.ok(t instanceof Utf8);
});

test('bqSchemaToArrowSchema: REQUIRED mode flips nullable to false', () => {
  const f = schemaFor({ name: 'v', type: 'INT64', mode: 'REQUIRED' });
  assert.equal(f?.nullable, false);
});

test('bqSchemaToArrowSchema: REPEATED → List<inner>', () => {
  const f = schemaFor({ name: 'v', type: 'INT64', mode: 'REPEATED' });
  assert.ok(f?.type instanceof List);
  const inner = (f?.type as List).children[0];
  assert.ok(inner?.type instanceof Int64);
});

test('bqSchemaToArrowSchema: STRUCT → Struct of children', () => {
  const f = schemaFor({
    name: 'v',
    type: 'STRUCT',
    fields: [
      { name: 'a', type: 'INT64' },
      { name: 'b', type: 'STRING' },
    ],
  });
  assert.ok(f?.type instanceof Struct);
  const struct = f?.type as Struct;
  assert.equal(struct.children.length, 2);
  assert.ok(struct.children[0]?.type instanceof Int64);
  assert.ok(struct.children[1]?.type instanceof Utf8);
});

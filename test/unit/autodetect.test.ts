/**
 * BL-090 — schema autodetect.
 *
 * Tests focus on the type-decision rules in isolation so the load-job
 * integration suite doesn't have to drive every variant through HTTP.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { type SampleRow, inferSchema } from '../../src/load/autodetect.ts';

function infer(rows: SampleRow[]): readonly { name: string; type: string; mode?: string }[] {
  // Pull column order from the first row to keep the assertions ordered
  // the way the test wrote them.
  const order = rows.length > 0 ? Object.keys(rows[0] as SampleRow) : [];
  return inferSchema(rows, order).map((f) =>
    f.mode === undefined
      ? { name: f.name, type: f.type }
      : { name: f.name, type: f.type, mode: f.mode },
  );
}

test('all-int columns infer to INT64', () => {
  assert.deepEqual(infer([{ a: '1' }, { a: '42' }, { a: '-7' }]), [{ name: 'a', type: 'INT64' }]);
});

test('mix of int + decimal infers FLOAT64', () => {
  assert.deepEqual(infer([{ x: '1' }, { x: '2.5' }, { x: '-0.1' }]), [
    { name: 'x', type: 'FLOAT64' },
  ]);
});

test('case-insensitive true/false infers BOOL', () => {
  assert.deepEqual(infer([{ b: 'true' }, { b: 'FALSE' }, { b: 'True' }]), [
    { name: 'b', type: 'BOOL' },
  ]);
});

test('all YYYY-MM-DD strings infer DATE', () => {
  assert.deepEqual(infer([{ d: '2026-05-24' }, { d: '2020-01-01' }]), [
    { name: 'd', type: 'DATE' },
  ]);
});

test('all ISO-8601 timestamps infer TIMESTAMP', () => {
  assert.deepEqual(infer([{ t: '2026-05-24T10:00:00Z' }, { t: '2020-01-01T00:00:00.123+00:00' }]), [
    { name: 't', type: 'TIMESTAMP' },
  ]);
});

test('any free-form string demotes to STRING', () => {
  assert.deepEqual(infer([{ s: '1' }, { s: 'two' }, { s: '3' }]), [{ name: 's', type: 'STRING' }]);
});

test('JSON booleans (real `true`/`false`) infer BOOL', () => {
  assert.deepEqual(infer([{ ok: true }, { ok: false }]), [{ name: 'ok', type: 'BOOL' }]);
});

test('JSON integer numbers infer INT64', () => {
  assert.deepEqual(infer([{ n: 1 }, { n: 42 }, { n: -3 }]), [{ name: 'n', type: 'INT64' }]);
});

test('JSON float numbers infer FLOAT64', () => {
  assert.deepEqual(infer([{ n: 1.5 }, { n: 42 }]), [{ name: 'n', type: 'FLOAT64' }]);
});

test('non-finite numbers demote the column to STRING', () => {
  assert.deepEqual(infer([{ n: 1 }, { n: Number.NaN }, { n: 3 }]), [{ name: 'n', type: 'STRING' }]);
});

test('arrays produce a REPEATED field with element-typed base', () => {
  assert.deepEqual(infer([{ tags: ['a', 'b'] }, { tags: ['c'] }]), [
    { name: 'tags', type: 'STRING', mode: 'REPEATED' },
  ]);
});

test('REPEATED INT64 — array of integer literals infers ARRAY<INT64>', () => {
  assert.deepEqual(infer([{ nums: [1, 2] }, { nums: [3] }]), [
    { name: 'nums', type: 'INT64', mode: 'REPEATED' },
  ]);
});

test('nested JSON objects fall through to STRING in v0', () => {
  assert.deepEqual(infer([{ payload: { inner: 1 } }]), [{ name: 'payload', type: 'STRING' }]);
});

test('all empty / null values default to STRING', () => {
  assert.deepEqual(infer([{ x: null }, { x: '' }, { x: undefined as unknown as string }]), [
    { name: 'x', type: 'STRING' },
  ]);
});

test('columns not in columnOrder still appear (first-seen order)', () => {
  const rows: SampleRow[] = [{ id: '1' }, { id: '2', tag: 'a' }, { id: '3', tag: 'b', extra: '1' }];
  const fields = inferSchema(rows, ['id']);
  const names = fields.map((f) => f.name);
  assert.deepEqual(names, ['id', 'tag', 'extra']);
});

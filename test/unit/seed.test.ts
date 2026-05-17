/**
 * parseSeedDoc unit tests — the YAML→typed-doc step in isolation.
 *
 * Loader integration (against a real server) is exercised separately by
 * `test/api/seed.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { parseSeedDoc } from '../../src/seed.ts';
import { BqError } from '../../src/util/errors.ts';

test('parseSeedDoc accepts an empty datasets list', () => {
  const doc = parseSeedDoc('datasets: []');
  assert.deepEqual(doc.datasets, []);
});

test('parseSeedDoc accepts an empty document (no datasets key)', () => {
  // Implicit empty: the document is just a YAML mapping with no datasets.
  const doc = parseSeedDoc('{}');
  assert.deepEqual(doc.datasets, []);
});

test('parseSeedDoc parses a dataset with a table and rows', () => {
  const doc = parseSeedDoc(`
datasets:
  - datasetId: ds
    location: US
    tables:
      - tableId: t
        schema:
          fields:
            - { name: id, type: STRING }
        rows:
          - { id: a }
          - { id: b }
`);
  assert.equal(doc.datasets.length, 1);
  const ds = doc.datasets[0];
  assert.equal(ds?.datasetId, 'ds');
  assert.equal(ds?.location, 'US');
  assert.equal(ds?.tables?.length, 1);
  const t = ds?.tables?.[0];
  assert.equal(t?.tableId, 't');
  assert.equal(t?.schema.fields[0]?.name, 'id');
  assert.equal(t?.rows?.length, 2);
});

test('parseSeedDoc preserves explicit project on a dataset', () => {
  const doc = parseSeedDoc(`
datasets:
  - project: other-proj
    datasetId: ds
`);
  assert.equal(doc.datasets[0]?.project, 'other-proj');
});

test('parseSeedDoc parses field mode and nested STRUCT fields', () => {
  const doc = parseSeedDoc(`
datasets:
  - datasetId: ds
    tables:
      - tableId: t
        schema:
          fields:
            - name: id
              type: STRING
              mode: REQUIRED
            - name: meta
              type: STRUCT
              fields:
                - { name: created_at, type: TIMESTAMP }
                - { name: tags, type: STRING, mode: REPEATED }
`);
  const t = doc.datasets[0]?.tables?.[0];
  assert.equal(t?.schema.fields[0]?.mode, 'REQUIRED');
  assert.equal(t?.schema.fields[1]?.type, 'STRUCT');
  assert.equal(t?.schema.fields[1]?.fields?.[1]?.mode, 'REPEATED');
});

test('parseSeedDoc rejects malformed YAML', () => {
  assert.throws(
    () => parseSeedDoc('datasets: [ : invalid'),
    (err: unknown) => err instanceof BqError && err.reason === 'invalid',
  );
});

test('parseSeedDoc rejects a dataset without datasetId', () => {
  assert.throws(
    () =>
      parseSeedDoc(`
datasets:
  - location: US
`),
    (err: unknown) => err instanceof BqError && /datasetId must be a string/.test(err.message),
  );
});

test('parseSeedDoc rejects a table without schema', () => {
  assert.throws(
    () =>
      parseSeedDoc(`
datasets:
  - datasetId: ds
    tables:
      - tableId: t
`),
    (err: unknown) => err instanceof BqError && /schema is required/.test(err.message),
  );
});

test('parseSeedDoc rejects an unknown field mode', () => {
  assert.throws(
    () =>
      parseSeedDoc(`
datasets:
  - datasetId: ds
    tables:
      - tableId: t
        schema:
          fields:
            - { name: id, type: STRING, mode: BOGUS }
`),
    (err: unknown) => err instanceof BqError && /NULLABLE.*REQUIRED.*REPEATED/.test(err.message),
  );
});

test('parseSeedDoc rejects a row that is not a mapping', () => {
  assert.throws(
    () =>
      parseSeedDoc(`
datasets:
  - datasetId: ds
    tables:
      - tableId: t
        schema:
          fields:
            - { name: id, type: STRING }
        rows:
          - "not-a-mapping"
`),
    (err: unknown) => err instanceof BqError && /must be a YAML mapping/.test(err.message),
  );
});

/**
 * Direct unit tests for the parameter parser in src/sql/queryEngine.ts.
 *
 * These exercise the validation paths (asObject / expectString / array shape)
 * without going through HTTP. Cheaper than driving them via fetch and clearer
 * about which branch each test hits.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { parseQueryParameter, parseQueryParameters } from '../../../src/sql/queryEngine.ts';
import { BqError } from '../../../src/util/errors.ts';

test('parseQueryParameters returns [] when given undefined', () => {
  assert.deepEqual(parseQueryParameters(undefined, 'queryParameters'), []);
});

test('parseQueryParameters throws when the top-level value is not an array', () => {
  assert.throws(
    () => parseQueryParameters({ not: 'an-array' }, 'queryParameters'),
    (err: unknown) => err instanceof BqError && err.reason === 'invalid',
  );
});

test('parseQueryParameter throws when the parameter is not a JSON object', () => {
  assert.throws(
    () => parseQueryParameter('a-string', 'queryParameters[0]'),
    (err: unknown) => err instanceof BqError && /must be a JSON object/.test(err.message),
  );
});

test('parseQueryParameter throws when name is not a string', () => {
  assert.throws(
    () =>
      parseQueryParameter(
        {
          name: 42,
          parameterType: { type: 'STRING' },
          parameterValue: { value: 'x' },
        },
        'queryParameters[0]',
      ),
    (err: unknown) => err instanceof BqError && /\.name must be a string/.test(err.message),
  );
});

test('parseQueryParameter throws when parameterType is missing', () => {
  assert.throws(
    () => parseQueryParameter({ name: 'x', parameterValue: { value: '1' } }, 'queryParameters[0]'),
    (err: unknown) => err instanceof BqError && /parameterType/.test(err.message),
  );
});

test('parseQueryParameter throws when parameterType.type is not a string', () => {
  assert.throws(
    () =>
      parseQueryParameter(
        { name: 'x', parameterType: { type: 999 }, parameterValue: { value: '1' } },
        'queryParameters[0]',
      ),
    (err: unknown) =>
      err instanceof BqError && /parameterType\.type must be a string/.test(err.message),
  );
});

test('parseQueryParameter throws when ARRAY parameter has no arrayValues array', () => {
  assert.throws(
    () =>
      parseQueryParameter(
        {
          name: 'ids',
          parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
          parameterValue: { arrayValues: 'not-an-array' },
        },
        'queryParameters[0]',
      ),
    (err: unknown) => err instanceof BqError && /arrayValues must be an array/.test(err.message),
  );
});

test('parseQueryParameter throws when ARRAY arrayType is missing', () => {
  assert.throws(
    () =>
      parseQueryParameter(
        {
          name: 'ids',
          parameterType: { type: 'ARRAY' },
          parameterValue: { arrayValues: [] },
        },
        'queryParameters[0]',
      ),
    (err: unknown) => err instanceof BqError && /arrayType/.test(err.message),
  );
});

test('parseQueryParameter throws when scalar value is missing', () => {
  assert.throws(
    () =>
      parseQueryParameter(
        {
          name: 'x',
          parameterType: { type: 'INT64' },
          parameterValue: {},
        },
        'queryParameters[0]',
      ),
    (err: unknown) => err instanceof BqError && /parameterValue\.value/.test(err.message),
  );
});

test('parseQueryParameter parses a happy-path ARRAY<STRING>', () => {
  const parsed = parseQueryParameter(
    {
      name: 'ids',
      parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
      parameterValue: { arrayValues: [{ value: 'a' }, { value: 'b' }] },
    },
    'queryParameters[0]',
  );
  assert.equal(parsed.name, 'ids');
  assert.equal(parsed.arrayElementType, 'STRING');
  assert.deepEqual(parsed.arrayScalars, ['a', 'b']);
});

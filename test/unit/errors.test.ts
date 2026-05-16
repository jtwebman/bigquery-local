import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { BqError } from '../../src/util/errors.ts';
import type { BqErrorBody, BqErrorReason } from '../../src/util/errors.ts';

const reasonToStatus: ReadonlyArray<readonly [BqErrorReason, number]> = [
  ['notFound', 404],
  ['duplicate', 409],
  ['invalid', 400],
  ['accessDenied', 403],
  ['internalError', 500],
  ['quotaExceeded', 429],
  ['unsupportedFeature', 400],
];

for (const [reason, status] of reasonToStatus) {
  test(`reason "${reason}" maps to HTTP ${status}`, () => {
    const err = new BqError(reason, 'msg');
    assert.equal(err.reason, reason);
    assert.equal(err.code, status);
    const body = err.toResponseBody();
    assert.equal(body.error.code, status);
    assert.equal(body.error.errors[0]?.reason, reason);
    assert.equal(body.error.errors[0]?.message, 'msg');
    assert.equal(body.error.message, 'msg');
  });
}

test('static factories produce the matching reason and status', () => {
  assert.equal(BqError.notFound('m').reason, 'notFound');
  assert.equal(BqError.notFound('m').code, 404);
  assert.equal(BqError.duplicate('m').reason, 'duplicate');
  assert.equal(BqError.duplicate('m').code, 409);
  assert.equal(BqError.invalid('m').reason, 'invalid');
  assert.equal(BqError.invalid('m').code, 400);
  assert.equal(BqError.accessDenied('m').reason, 'accessDenied');
  assert.equal(BqError.accessDenied('m').code, 403);
  assert.equal(BqError.internalError('m').reason, 'internalError');
  assert.equal(BqError.internalError('m').code, 500);
  assert.equal(BqError.quotaExceeded('m').reason, 'quotaExceeded');
  assert.equal(BqError.quotaExceeded('m').code, 429);
  assert.equal(BqError.unsupportedFeature('m').reason, 'unsupportedFeature');
  assert.equal(BqError.unsupportedFeature('m').code, 400);
});

test('BqError is an Error subclass with name "BqError"', () => {
  const err = new BqError('notFound', 'm');
  assert.ok(err instanceof Error);
  assert.ok(err instanceof BqError);
  assert.equal(err.name, 'BqError');
  assert.equal(err.message, 'm');
});

test('response body omits "location" when not provided', () => {
  const body: BqErrorBody = new BqError('notFound', 'm').toResponseBody();
  const entry = body.error.errors[0];
  assert.ok(entry);
  assert.equal('location' in entry, false);
});

test('response body includes "location" when provided to the constructor', () => {
  const body: BqErrorBody = new BqError('invalid', 'm', 'schema.fields').toResponseBody();
  const entry = body.error.errors[0];
  assert.ok(entry);
  assert.equal(entry.location, 'schema.fields');
});

test('factory methods accept an optional location', () => {
  const err = BqError.invalid('bad', 'field.name');
  assert.equal(err.location, 'field.name');
  const entry = err.toResponseBody().error.errors[0];
  assert.equal(entry?.location, 'field.name');
});

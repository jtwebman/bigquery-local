import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { BqError } from '../../src/util/errors.ts';
import { canonicalJson, checkIfMatch, etag } from '../../src/util/etag.ts';

test('canonicalJson sorts object keys lexicographically', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: 2, b: 1 }), '{"a":2,"b":1}');
});

test('canonicalJson recurses into nested objects and arrays', () => {
  const out = canonicalJson({
    z: 'last',
    a: { y: 2, x: 1 },
    m: [3, { c: 'inner', b: 'nested' }, 'tail'],
  });
  assert.equal(out, '{"a":{"x":1,"y":2},"m":[3,{"b":"nested","c":"inner"},"tail"],"z":"last"}');
});

test('canonicalJson drops undefined keys (matching JSON.stringify)', () => {
  assert.equal(canonicalJson({ a: 1, b: undefined, c: 3 }), '{"a":1,"c":3}');
});

test('canonicalJson handles primitives and null', () => {
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson(42), '42');
  assert.equal(canonicalJson('hello'), '"hello"');
  assert.equal(canonicalJson(true), 'true');
});

test('canonicalJson handles empty containers', () => {
  assert.equal(canonicalJson({}), '{}');
  assert.equal(canonicalJson([]), '[]');
});

test('canonicalJson stringifies undefined to "null"', () => {
  // Top-level undefined would yield literally undefined from JSON.stringify;
  // we coerce to "null" so the function always returns a string.
  assert.equal(canonicalJson(undefined), 'null');
});

test('etag is stable across reordered object keys (acceptance)', () => {
  const a = { project: 'p', datasetId: 'd', location: 'US' };
  const b = { location: 'US', datasetId: 'd', project: 'p' };
  assert.equal(etag(a), etag(b));
});

test('etag is stable across reordered nested keys', () => {
  const a = { meta: { name: 'x', count: 1 }, labels: { team: 'data', env: 'dev' } };
  const b = { labels: { env: 'dev', team: 'data' }, meta: { count: 1, name: 'x' } };
  assert.equal(etag(a), etag(b));
});

test('etag changes when a value changes', () => {
  assert.notEqual(etag({ a: 1 }), etag({ a: 2 }));
});

test('etag changes when an array element is reordered', () => {
  // Arrays are positionally meaningful; reordering should change the etag.
  assert.notEqual(etag([1, 2, 3]), etag([3, 2, 1]));
});

test('etag returns a 16-character lowercase hex string', () => {
  const e = etag({ a: 1 });
  assert.equal(e.length, 16);
  assert.match(e, /^[0-9a-f]{16}$/);
});

test('checkIfMatch is a no-op when ifMatch is undefined (acceptance: success path)', () => {
  // Should not throw.
  checkIfMatch('abc123', undefined);
});

test('checkIfMatch is a no-op when ifMatch equals current etag (acceptance: success path)', () => {
  checkIfMatch('abc123', 'abc123');
});

test('checkIfMatch throws BqError.conditionNotMet on mismatch (acceptance: failure path)', () => {
  try {
    checkIfMatch('current', 'stale');
    assert.fail('expected checkIfMatch to throw');
  } catch (err) {
    assert.ok(err instanceof BqError);
    assert.equal(err.reason, 'conditionNotMet');
    assert.equal(err.code, 412);
    assert.match(err.message, /If-Match/);
  }
});

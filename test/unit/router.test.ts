import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { compileRoute, compileRoutes, matchRoute, parseQueryString } from '../../src/router.ts';
import type { Handler } from '../../src/types.ts';

const noop: Handler = () => ({ status: 200 });

test('compileRoute extracts param names from {name} placeholders', () => {
  const compiled = compileRoute({
    method: 'GET',
    path: '/projects/{p}/datasets/{d}',
    handler: noop,
  });
  assert.deepEqual(compiled.paramNames, ['p', 'd']);
});

test('compileRoute uppercases the method', () => {
  const compiled = compileRoute({ method: 'patch', path: '/x', handler: noop });
  assert.equal(compiled.method, 'PATCH');
});

test('compileRoute supports a literal path with no params', () => {
  const compiled = compileRoute({
    method: 'GET',
    path: '/discovery/v1/apis/bigquery/v2/rest',
    handler: noop,
  });
  assert.deepEqual(compiled.paramNames, []);
  assert.ok(compiled.regex.test('/discovery/v1/apis/bigquery/v2/rest'));
  assert.equal(compiled.regex.test('/discovery/v1/apis/bigquery/v2/rest/extra'), false);
});

test('compileRoute escapes regex metacharacters in literal segments', () => {
  const compiled = compileRoute({
    method: 'GET',
    path: '/projects/{p}/datasets.list',
    handler: noop,
  });
  assert.ok(compiled.regex.test('/projects/proj/datasets.list'));
  assert.equal(compiled.regex.test('/projects/proj/datasetsxlist'), false);
});

test('matchRoute matches exact path and extracts params', () => {
  const compiled = compileRoutes([
    { method: 'GET', path: '/projects/{p}/datasets/{d}', handler: noop },
  ]);
  const result = matchRoute(compiled, 'GET', '/projects/proj-1/datasets/ds_1');
  assert.ok(result);
  assert.deepEqual(result.params, { p: 'proj-1', d: 'ds_1' });
});

test('matchRoute returns null on method mismatch', () => {
  const compiled = compileRoutes([{ method: 'GET', path: '/x', handler: noop }]);
  assert.equal(matchRoute(compiled, 'POST', '/x'), null);
});

test('matchRoute returns null on path mismatch', () => {
  const compiled = compileRoutes([{ method: 'GET', path: '/x', handler: noop }]);
  assert.equal(matchRoute(compiled, 'GET', '/y'), null);
});

test('matchRoute is case-insensitive on method', () => {
  const compiled = compileRoutes([{ method: 'GET', path: '/x', handler: noop }]);
  assert.ok(matchRoute(compiled, 'get', '/x') !== null);
});

test('matchRoute decodes URL-encoded path parameters', () => {
  const compiled = compileRoutes([{ method: 'GET', path: '/x/{name}', handler: noop }]);
  const result = matchRoute(compiled, 'GET', '/x/hello%20world');
  assert.ok(result);
  assert.equal(result.params['name'], 'hello world');
});

test('matchRoute first match wins on overlap', () => {
  const compiled = compileRoutes([
    { method: 'GET', path: '/x/{a}', handler: noop },
    { method: 'GET', path: '/x/{b}', handler: noop },
  ]);
  const result = matchRoute(compiled, 'GET', '/x/y');
  assert.ok(result);
  assert.deepEqual(result.params, { a: 'y' });
});

test('matchRoute returns null for an empty route list', () => {
  assert.equal(matchRoute([], 'GET', '/x'), null);
});

test('parseQueryString returns empty for empty input', () => {
  assert.deepEqual(parseQueryString(''), {});
  assert.deepEqual(parseQueryString('?'), {});
});

test('parseQueryString handles a leading ? or none', () => {
  assert.deepEqual(parseQueryString('?a=1'), { a: '1' });
  assert.deepEqual(parseQueryString('a=1'), { a: '1' });
});

test('parseQueryString parses multiple keys', () => {
  assert.deepEqual(parseQueryString('?a=1&b=two&c='), { a: '1', b: 'two', c: '' });
});

test('parseQueryString URL-decodes values', () => {
  assert.deepEqual(parseQueryString('?q=hello%20world'), { q: 'hello world' });
});

test('parseQueryString: last value wins on repeated keys', () => {
  assert.deepEqual(parseQueryString('?a=1&a=2'), { a: '2' });
});

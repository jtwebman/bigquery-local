import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { deflateSync, gzipSync } from 'node:zlib';

import { createRouterServer as createServer } from '../../src/server.ts';
import type { RouteDefinition, Server } from '../../src/types.ts';
import { BqError } from '../../src/util/errors.ts';

interface GoogleErrorBody {
  readonly error: {
    readonly code: number;
    readonly errors: ReadonlyArray<{ readonly reason: string; readonly message: string }>;
    readonly message: string;
  };
}

const routes: RouteDefinition[] = [
  {
    method: 'GET',
    path: '/echo/{value}',
    handler: (req) => ({ status: 200, body: { value: req.params['value'] } }),
  },
  {
    method: 'POST',
    path: '/echo-body',
    handler: (req) => ({ status: 200, body: req.body }),
  },
  {
    method: 'GET',
    path: '/echo-query',
    handler: (req) => ({ status: 200, body: req.query }),
  },
  {
    method: 'GET',
    path: '/empty',
    handler: () => ({ status: 204 }),
  },
  {
    method: 'GET',
    path: '/boom',
    handler: () => {
      throw new Error('kaboom');
    },
  },
  {
    method: 'GET',
    path: '/non-error-rejection',
    handler: () => Promise.reject('plain string rejection'),
  },
  {
    method: 'GET',
    path: '/bq-error',
    handler: () => {
      throw BqError.notFound('thing not found', 'dataset.id');
    },
  },
  {
    method: 'GET',
    path: '/custom-header',
    handler: () => ({
      status: 200,
      body: { ok: true },
      headers: { 'x-custom': 'yes' },
    }),
  },
  {
    method: 'POST',
    path: '/parse',
    handler: (req) => ({
      status: 200,
      body: { contentType: req.headers['content-type'], body: req.body },
    }),
  },
];

let server: Server;

before(async () => {
  server = createServer({ routes });
  await server.listen(0);
});

after(async () => {
  await server.close();
});

test('boots, hits a registered route, and closes cleanly', async () => {
  const res = await fetch(`${server.url}/echo/hello`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { value: string };
  assert.equal(body.value, 'hello');
});

test('returns a Google-shaped 404 when no route matches', async () => {
  const res = await fetch(`${server.url}/nope`);
  assert.equal(res.status, 404);
  const body = (await res.json()) as GoogleErrorBody;
  assert.equal(body.error.code, 404);
  assert.equal(body.error.errors[0]?.reason, 'notFound');
});

test('returns 400 with reason "invalid" on malformed JSON body', async () => {
  const res = await fetch(`${server.url}/echo-body`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as GoogleErrorBody;
  assert.equal(body.error.code, 400);
  assert.equal(body.error.errors[0]?.reason, 'invalid');
});

test('parses JSON body and passes it to the handler', async () => {
  const res = await fetch(`${server.url}/echo-body`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'foo', n: 42 }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { name: string; n: number };
  assert.deepEqual(body, { name: 'foo', n: 42 });
});

test('decodes a gzip-encoded JSON body (Java client sends these)', async () => {
  const res = await fetch(`${server.url}/echo-body`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    body: gzipSync(Buffer.from(JSON.stringify({ name: 'gz', n: 7 }))),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { name: 'gz', n: 7 });
});

test('decodes a deflate-encoded JSON body', async () => {
  const res = await fetch(`${server.url}/echo-body`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-encoding': 'deflate' },
    body: deflateSync(Buffer.from(JSON.stringify({ ok: true }))),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('returns 400 when a body claims gzip but is not', async () => {
  const res = await fetch(`${server.url}/echo-body`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    body: 'not actually gzip',
  });
  assert.equal(res.status, 400);
});

test('passes through raw string when content-type is not JSON', async () => {
  const res = await fetch(`${server.url}/parse`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'hello world',
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { contentType: string; body: string };
  assert.equal(body.contentType, 'text/plain');
  assert.equal(body.body, 'hello world');
});

test('treats missing body as null', async () => {
  const res = await fetch(`${server.url}/echo-body`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text, 'null');
});

test('parses query parameters', async () => {
  const res = await fetch(`${server.url}/echo-query?a=1&b=two`);
  const body = (await res.json()) as Record<string, string>;
  assert.deepEqual(body, { a: '1', b: 'two' });
});

test('204 with no body sends an empty response', async () => {
  const res = await fetch(`${server.url}/empty`);
  assert.equal(res.status, 204);
  const text = await res.text();
  assert.equal(text, '');
});

test('handler-thrown error becomes a 500 internalError', async () => {
  const res = await fetch(`${server.url}/boom`);
  assert.equal(res.status, 500);
  const body = (await res.json()) as GoogleErrorBody;
  assert.equal(body.error.code, 500);
  assert.equal(body.error.errors[0]?.reason, 'internalError');
  assert.equal(body.error.errors[0]?.message, 'kaboom');
});

test('non-Error handler rejection also becomes a 500 with a generic message', async () => {
  const res = await fetch(`${server.url}/non-error-rejection`);
  assert.equal(res.status, 500);
  const body = (await res.json()) as GoogleErrorBody;
  assert.equal(body.error.code, 500);
  assert.equal(body.error.errors[0]?.reason, 'internalError');
  assert.equal(body.error.errors[0]?.message, 'Internal error');
});

test('thrown BqError is serialized with its reason, status, and location', async () => {
  const res = await fetch(`${server.url}/bq-error`);
  assert.equal(res.status, 404);
  const body = (await res.json()) as GoogleErrorBody;
  assert.equal(body.error.code, 404);
  assert.equal(body.error.errors[0]?.reason, 'notFound');
  assert.equal(body.error.errors[0]?.message, 'thing not found');
  assert.equal((body.error.errors[0] as { location?: string })?.location, 'dataset.id');
});

test('custom response headers are merged with content-type', async () => {
  const res = await fetch(`${server.url}/custom-header`);
  assert.equal(res.headers.get('x-custom'), 'yes');
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
});

test('listen() throws if already listening', async () => {
  await assert.rejects(() => server.listen(0), /already listening/i);
});

test('url getter throws when not listening', async () => {
  const s = createServer({});
  assert.throws(() => s.url, /not listening/i);
});

test('close() is safe when not listening', async () => {
  const s = createServer({});
  await s.close();
});

test('listen() rejects if the port is in use', async () => {
  const a = createServer({});
  const b = createServer({});
  await a.listen(0);
  const port = Number.parseInt(new URL(a.url).port, 10);
  await assert.rejects(() => b.listen(port));
  await a.close();
});

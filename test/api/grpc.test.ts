/**
 * gRPC port acceptance test.
 *
 * Boots `createGrpcServer()` on an ephemeral port and uses Node's built-in
 * `http2` client (no grpc dep) to play the role of a gRPC client. Asserts
 * that the server returns a trailers-only response with
 * `grpc-status: 12 (UNIMPLEMENTED)` — exactly what a real gRPC client
 * library expects for a synchronous error.
 *
 * This is the protocol-level acceptance for BL-019. A higher-level test
 * with the official `@google-cloud/bigquery-storage` client would pull
 * in `grpc-js`, `protobufjs`, and `google-auth-library` for one
 * assertion; the same correctness is established here directly.
 */

import { strict as assert } from 'node:assert';
import { connect, constants as h2 } from 'node:http2';
import { after, before, test } from 'node:test';

import { GRPC_STATUS_UNIMPLEMENTED, type GrpcServer, createGrpcServer } from 'bigquery-local';

let server: GrpcServer;

before(async () => {
  server = createGrpcServer();
  await server.listen(0);
});

after(async () => {
  await server.close();
});

interface GrpcResponse {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

async function sendRpc(
  path: string,
  options: { readonly contentType?: string } = {},
): Promise<GrpcResponse> {
  const client = connect(`http://${server.url}`);
  try {
    return await new Promise<GrpcResponse>((resolve, reject) => {
      const req = client.request({
        [h2.HTTP2_HEADER_METHOD]: 'POST',
        [h2.HTTP2_HEADER_PATH]: path,
        [h2.HTTP2_HEADER_SCHEME]: 'http',
        [h2.HTTP2_HEADER_AUTHORITY]: server.url,
        'content-type': options.contentType ?? 'application/grpc',
        te: 'trailers',
      });

      let responseHeaders: Record<string, string> = {};
      const chunks: Buffer[] = [];

      req.on('response', (headers) => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) {
          if (v === undefined) continue;
          out[k] = Array.isArray(v) ? v.join(',') : String(v);
        }
        responseHeaders = out;
      });
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve({ headers: responseHeaders, body: Buffer.concat(chunks) }));
      req.on('error', reject);

      // gRPC: 5-byte prefix (1 compression flag + 4-byte big-endian length)
      // followed by an (in our case, empty) protobuf payload. The contents
      // don't matter because we expect a trailers-only error response.
      const frame = Buffer.alloc(5);
      req.end(frame);
    });
  } finally {
    client.close();
  }
}

test('GRPC_STATUS_UNIMPLEMENTED equals 12 (canonical gRPC code)', () => {
  assert.equal(GRPC_STATUS_UNIMPLEMENTED, 12);
});

test('every RPC path receives a trailers-only UNIMPLEMENTED response', async () => {
  const res = await sendRpc('/google.cloud.bigquery.storage.v1.BigQueryRead/CreateReadSession');
  assert.equal(res.headers[':status'], '200');
  assert.equal(res.headers['content-type'], 'application/grpc');
  assert.equal(res.headers['grpc-status'], '12');
  assert.match(res.headers['grpc-message'] ?? '', /bigquery-local/);
  assert.equal(res.body.length, 0);
});

test('a different RPC path also gets UNIMPLEMENTED', async () => {
  const res = await sendRpc('/google.cloud.bigquery.storage.v1.BigQueryWrite/AppendRows');
  assert.equal(res.headers['grpc-status'], '12');
});

test('custom grpc-message can be configured', async () => {
  const customServer = createGrpcServer({ message: 'custom error text' });
  await customServer.listen(0);
  try {
    const client = connect(`http://${customServer.url}`);
    const headers = await new Promise<Record<string, string>>((resolve, reject) => {
      const req = client.request({ ':method': 'POST', ':path': '/Service/Method' });
      req.on('response', (h) => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(h)) {
          if (v === undefined) continue;
          out[k] = Array.isArray(v) ? v.join(',') : String(v);
        }
        resolve(out);
      });
      req.on('error', reject);
      req.end(Buffer.alloc(5));
    });
    client.close();
    assert.equal(headers['grpc-message'], 'custom error text');
  } finally {
    await customServer.close();
  }
});

test('listen() throws if already listening', async () => {
  const s = createGrpcServer();
  await s.listen(0);
  try {
    await assert.rejects(() => s.listen(0), /already listening/);
  } finally {
    await s.close();
  }
});

test('url getter throws when not listening', () => {
  const s = createGrpcServer();
  assert.throws(() => s.url, /not listening/);
});

test('close() is safe when not listening', async () => {
  const s = createGrpcServer();
  await s.close(); // no-op, must not throw
});

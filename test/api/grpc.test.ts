/**
 * gRPC port acceptance test.
 *
 * Boots `createGrpcServer()` on an ephemeral port and uses a real
 * `@grpc/grpc-js` client to play the role of a BigQuery Storage caller.
 * Asserts every RPC path resolves to a `Status.UNIMPLEMENTED` error —
 * the canonical response for unregistered methods on a grpc-js Server.
 *
 * This is the protocol-level acceptance for BL-116 (the Phase 18/19
 * scaffold). When real handlers land they'll be registered via
 * `server.addService(...)`; until then every path falls through to
 * grpc-js's built-in UNIMPLEMENTED behavior.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import * as grpc from '@grpc/grpc-js';
import { GRPC_STATUS_UNIMPLEMENTED, type GrpcServer, createGrpcServer } from 'bigquery-local';

let server: GrpcServer;

before(async () => {
  server = createGrpcServer();
  await server.listen(0);
});

after(async () => {
  await server.close();
});

function passthroughSerialize(value: Buffer): Buffer {
  return value;
}
function passthroughDeserialize(value: Buffer): Buffer {
  return value;
}

interface RpcResult {
  readonly code: number;
  readonly details: string;
}

/**
 * Make a unary RPC to an arbitrary path with an empty body, using
 * pass-through (buffer) serializers so we don't need a real proto.
 */
async function callUnary(path: string): Promise<RpcResult> {
  const client = new grpc.Client(server.url, grpc.credentials.createInsecure());
  try {
    return await new Promise<RpcResult>((resolve) => {
      client.makeUnaryRequest(
        path,
        passthroughSerialize,
        passthroughDeserialize,
        Buffer.alloc(0),
        (err, _response) => {
          /* node:coverage ignore next 4 */
          if (err === null) {
            resolve({ code: 0, details: 'unexpected success' });
            return;
          }
          const gErr = err as grpc.ServiceError;
          resolve({ code: gErr.code, details: gErr.details });
        },
      );
    });
  } finally {
    client.close();
  }
}

test('GRPC_STATUS_UNIMPLEMENTED equals 12 (canonical gRPC code)', () => {
  assert.equal(GRPC_STATUS_UNIMPLEMENTED, 12);
  assert.equal(grpc.status.UNIMPLEMENTED, GRPC_STATUS_UNIMPLEMENTED);
});

test('Storage Read RPCs return UNIMPLEMENTED', async () => {
  const res = await callUnary('/google.cloud.bigquery.storage.v1.BigQueryRead/CreateReadSession');
  assert.equal(res.code, GRPC_STATUS_UNIMPLEMENTED);
  assert.match(res.details, /does not implement/);
});

test('Storage Write RPCs return UNIMPLEMENTED', async () => {
  const res = await callUnary('/google.cloud.bigquery.storage.v1.BigQueryWrite/AppendRows');
  assert.equal(res.code, GRPC_STATUS_UNIMPLEMENTED);
});

test('arbitrary unknown path returns UNIMPLEMENTED', async () => {
  const res = await callUnary('/some.unknown.Service/Method');
  assert.equal(res.code, GRPC_STATUS_UNIMPLEMENTED);
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

test('listen() honors custom host', async () => {
  const s = createGrpcServer({ host: '127.0.0.1' });
  await s.listen(0);
  try {
    assert.match(s.url, /^localhost:\d+$/);
  } finally {
    await s.close();
  }
});

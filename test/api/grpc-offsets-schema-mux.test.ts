/**
 * BL-125 / BL-126 / BL-127 acceptance.
 *
 * BL-125 — AppendRows offset semantics:
 *   - offset == stream.offset → accept + write
 *   - offset != stream.offset → acknowledged success without writing
 *     (real BQ never errors on offset mismatch; replays and out-of-order
 *     both come back as a success response with no offset and the row
 *     silently dropped)
 *
 * BL-126 — Schema updates mid-stream:
 *   - ALTER TABLE landing between two appends → `updated_schema` on
 *     the next response. The stream keeps working without the client
 *     having to reopen.
 *
 * BL-127 — Multiplexing:
 *   - One bidirectional AppendRows call can target multiple write
 *     streams; per-stream state stays isolated.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import * as grpc from '@grpc/grpc-js';
import protobuf from 'protobufjs';

import { type GrpcServer, createGrpcServer } from '../../src/grpc.ts';
import {
  buildCreateTableSql,
  ensureDatasetSchema,
  qualifiedTableName,
} from '../../src/routes/tables.ts';
import { type Db, createDb } from '../../src/storage/db.ts';
import { ensureMetaSchema, upsertDataset, upsertTable } from '../../src/storage/meta.ts';
import type { BqField } from '../../src/storage/types.ts';
import descriptor from '../../src/grpc-gen/protos.json' with { type: 'json' };

const protoRoot = protobuf.Root.fromJSON(descriptor as protobuf.INamespace);
const AppendRowsRequest = protoRoot.lookupType(
  'google.cloud.bigquery.storage.v1.AppendRowsRequest',
);
const AppendRowsResponse = protoRoot.lookupType(
  'google.cloud.bigquery.storage.v1.AppendRowsResponse',
);
const CreateWriteStreamRequest = protoRoot.lookupType(
  'google.cloud.bigquery.storage.v1.CreateWriteStreamRequest',
);
const WriteStream = protoRoot.lookupType('google.cloud.bigquery.storage.v1.WriteStream');

const PROJECT = 'p-offsets';
const DATASET = 'ds';
const TABLE_A = 'tbl_a';
const TABLE_B = 'tbl_b';
const APPEND_PATH = '/google.cloud.bigquery.storage.v1.BigQueryWrite/AppendRows';
const CREATE_PATH = '/google.cloud.bigquery.storage.v1.BigQueryWrite/CreateWriteStream';

const baseFields: BqField[] = [
  { name: 'id', type: 'INT64', mode: 'REQUIRED' },
  { name: 'note', type: 'STRING' },
];

const baseDescriptor = {
  name: 'Row',
  field: [
    { name: 'id', number: 1, type: 3, label: 1 },
    { name: 'note', number: 2, type: 9, label: 1 },
  ],
};

const baseRowType = protobuf.Root.fromJSON({
  nested: {
    Row: { fields: { id: { type: 'int64', id: 1 }, note: { type: 'string', id: 2 } } },
  },
}).lookupType('Row');

let db: Db;
let server: GrpcServer;

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  await upsertDataset(db, { project: PROJECT, datasetId: DATASET });
  await ensureDatasetSchema(db, PROJECT, DATASET);
  for (const t of [TABLE_A, TABLE_B]) {
    await db.exec(buildCreateTableSql(PROJECT, DATASET, t, baseFields));
    await upsertTable(db, {
      project: PROJECT,
      datasetId: DATASET,
      tableId: t,
      type: 'TABLE',
      schema: { fields: baseFields },
    });
  }
  server = createGrpcServer({ db });
  await server.listen(0);
});

after(async () => {
  await server.close();
  await db.close();
});

interface AppendOutcome {
  readonly responses: ReadonlyArray<Record<string, unknown>>;
  readonly error: grpc.ServiceError | null;
}

function encodeRow(row: { id: number; note: string }): Uint8Array {
  return baseRowType.encode(baseRowType.fromObject(row)).finish();
}

/**
 * Open an AppendRows bidi call, send the given request messages in
 * order, and collect every response (including any that arrive before
 * the call ends). Resolves with the first error if the server aborts.
 */
function appendRows(requests: ReadonlyArray<object>): Promise<AppendOutcome> {
  const reqBytesList = requests.map((r) =>
    Buffer.from(AppendRowsRequest.encode(AppendRowsRequest.fromObject(r)).finish()),
  );
  const client = new grpc.Client(server.url, grpc.credentials.createInsecure());
  return new Promise<AppendOutcome>((resolve) => {
    const responses: Array<Record<string, unknown>> = [];
    const call = client.makeBidiStreamRequest(
      APPEND_PATH,
      (v: Buffer) => v,
      (v: Buffer) => v,
    );
    call.on('data', (bytes: Buffer) => {
      responses.push(
        AppendRowsResponse.toObject(AppendRowsResponse.decode(bytes as Uint8Array), {
          defaults: false,
          longs: String,
          enums: String,
          arrays: true,
          objects: true,
          bytes: Buffer,
        }) as Record<string, unknown>,
      );
    });
    call.on('error', (err: grpc.ServiceError) => {
      client.close();
      resolve({ responses, error: err });
    });
    call.on('end', () => {
      client.close();
      resolve({ responses, error: null });
    });
    for (const b of reqBytesList) call.write(b);
    call.end();
  });
}

async function unaryCall<RequestT extends object, ResponseT>(
  path: string,
  reqType: protobuf.Type,
  resType: protobuf.Type,
  request: RequestT,
): Promise<{ error: grpc.ServiceError | null; response: ResponseT | null }> {
  const reqBytes = Buffer.from(reqType.encode(reqType.fromObject(request)).finish());
  const client = new grpc.Client(server.url, grpc.credentials.createInsecure());
  return new Promise((resolve) => {
    client.makeUnaryRequest(
      path,
      (v: Buffer) => v,
      (v: Buffer) => v,
      reqBytes,
      (err, response) => {
        client.close();
        if (err !== null) {
          resolve({ error: err as grpc.ServiceError, response: null });
          return;
        }
        const decoded = resType.toObject(resType.decode(response as Uint8Array), {
          defaults: false,
          longs: String,
          enums: String,
          arrays: true,
          objects: true,
        }) as ResponseT;
        resolve({ error: null, response: decoded });
      },
    );
  });
}

async function createCommittedStream(table: string): Promise<string> {
  const parent = `projects/${PROJECT}/datasets/${DATASET}/tables/${table}`;
  const { error, response } = await unaryCall<Record<string, unknown>, { name: string }>(
    CREATE_PATH,
    CreateWriteStreamRequest,
    WriteStream,
    { parent, writeStream: { type: 'COMMITTED' } },
  );
  assert.equal(error, null);
  assert.ok(response !== null);
  return response.name;
}

async function tableRowCount(table: string): Promise<number> {
  const rows = await db.query<{ n: bigint }>(
    `SELECT COUNT(*)::BIGINT AS n FROM ${qualifiedTableName(PROJECT, DATASET, table)}`,
  );
  return Number(rows[0]?.n ?? 0n);
}

// ---------------------------------------------------------------------------
// BL-125 — offset semantics
// ---------------------------------------------------------------------------

test('AppendRows with offset == stream.offset accepts + writes (BL-125)', async () => {
  const stream = await createCommittedStream(TABLE_A);
  const initial = await tableRowCount(TABLE_A);
  const { error, responses } = await appendRows([
    {
      writeStream: stream,
      offset: { value: '0' },
      protoRows: {
        writerSchema: { protoDescriptor: baseDescriptor },
        rows: { serializedRows: [encodeRow({ id: 1, note: 'aligned' })] },
      },
    },
  ]);
  assert.equal(error, null);
  assert.equal(responses.length, 1);
  assert.equal(await tableRowCount(TABLE_A), initial + 1);
});

test('AppendRows with offset < stream.offset is treated as an idempotent replay (BL-125)', async () => {
  const stream = await createCommittedStream(TABLE_A);
  await appendRows([
    {
      writeStream: stream,
      offset: { value: '0' },
      protoRows: {
        writerSchema: { protoDescriptor: baseDescriptor },
        rows: {
          serializedRows: [
            encodeRow({ id: 10, note: 'first' }),
            encodeRow({ id: 11, note: 'second' }),
          ],
        },
      },
    },
  ]);
  const afterFirst = await tableRowCount(TABLE_A);

  // Re-send the same batch with offset=0 (replay). Real BQ acks
  // without re-writing; the row count must stay flat.
  const replay = await appendRows([
    {
      writeStream: stream,
      offset: { value: '0' },
      protoRows: {
        writerSchema: { protoDescriptor: baseDescriptor },
        rows: {
          serializedRows: [
            encodeRow({ id: 10, note: 'first' }),
            encodeRow({ id: 11, note: 'second' }),
          ],
        },
      },
    },
  ]);
  assert.equal(replay.error, null);
  assert.equal(replay.responses.length, 1);
  // Real BQ's contract: replays succeed but `appendResult.offset`
  // comes back unset (clients tell replay apart by comparing to the
  // offset they sent locally).
  const replayResult = (replay.responses[0] as { appendResult: { offset?: { value?: string } } })
    .appendResult;
  assert.equal(replayResult.offset, undefined, 'replay carries no offset');
  assert.equal(await tableRowCount(TABLE_A), afterFirst, 'replay must not write again');
});

test('AppendRows with offset > stream.offset succeeds with no offset (BL-125 — BQ parity)', async () => {
  const stream = await createCommittedStream(TABLE_A);
  const before = await tableRowCount(TABLE_A);
  const { error, responses } = await appendRows([
    {
      writeStream: stream,
      offset: { value: '99' },
      protoRows: {
        writerSchema: { protoDescriptor: baseDescriptor },
        rows: { serializedRows: [encodeRow({ id: 99, note: 'jumped' })] },
      },
    },
  ]);
  // Real BQ acknowledges out-of-order requests with success +
  // empty `appendResult` and silently drops the row. No gRPC error.
  assert.equal(error, null);
  assert.equal(responses.length, 1);
  const result = (responses[0] as { appendResult: { offset?: { value?: string } } }).appendResult;
  assert.equal(result.offset, undefined, 'out-of-order carries no offset');
  assert.equal(await tableRowCount(TABLE_A), before, 'out-of-order must not write');
});

// ---------------------------------------------------------------------------
// BL-126 — schema updates mid-stream
// ---------------------------------------------------------------------------

test('AppendRows emits updated_schema after an ALTER TABLE between batches (BL-126)', async () => {
  // Schema-change detection fires when the schema moves DURING a
  // live AppendRows call. Each new bidi call rebuilds its context
  // and treats the current schema as baseline, so we have to keep
  // one call open across the ALTER.
  const TABLE_C = 'tbl_alter';
  await db.exec(buildCreateTableSql(PROJECT, DATASET, TABLE_C, baseFields));
  await upsertTable(db, {
    project: PROJECT,
    datasetId: DATASET,
    tableId: TABLE_C,
    type: 'TABLE',
    schema: { fields: baseFields },
  });
  const stream = await createCommittedStream(TABLE_C);

  const client = new grpc.Client(server.url, grpc.credentials.createInsecure());
  try {
    const call = client.makeBidiStreamRequest(
      APPEND_PATH,
      (v: Buffer) => v,
      (v: Buffer) => v,
    );
    const responses: Record<string, unknown>[] = [];
    const responseQueue: Array<() => void> = [];
    const responseAvailable: Array<Promise<void>> = [];
    let pendingResolve: (() => void) | null = null;
    responseAvailable.push(
      new Promise<void>((resolve) => {
        pendingResolve = resolve;
      }),
    );
    call.on('data', (bytes: Buffer) => {
      responses.push(
        AppendRowsResponse.toObject(AppendRowsResponse.decode(bytes as Uint8Array), {
          defaults: false,
          longs: String,
          enums: String,
          arrays: true,
          objects: true,
          bytes: Buffer,
        }) as Record<string, unknown>,
      );
      const next = responseQueue.shift();
      if (next !== undefined) next();
      if (pendingResolve !== null) {
        pendingResolve();
        pendingResolve = null;
        responseAvailable.push(
          new Promise<void>((resolve) => {
            pendingResolve = resolve;
          }),
        );
      }
    });

    const waitForResponse = (n: number): Promise<void> =>
      new Promise<void>((resolve) => {
        if (responses.length >= n) {
          resolve();
          return;
        }
        responseQueue.push(() => {
          if (responses.length >= n) resolve();
          else responseQueue.push(() => waitForResponse(n).then(resolve));
        });
      });

    // First append — pre-alter.
    call.write(
      Buffer.from(
        AppendRowsRequest.encode(
          AppendRowsRequest.fromObject({
            writeStream: stream,
            offset: { value: '0' },
            protoRows: {
              writerSchema: { protoDescriptor: baseDescriptor },
              rows: { serializedRows: [encodeRow({ id: 1, note: 'before' })] },
            },
          }),
        ).finish(),
      ),
    );
    await waitForResponse(1);
    assert.equal(responses[0]?.['updatedSchema'], undefined, 'no schema change yet');

    // ALTER TABLE — add a column + refresh the meta entry's schema/etag
    // so the live AppendRows context notices the change.
    await db.exec(
      `ALTER TABLE ${qualifiedTableName(PROJECT, DATASET, TABLE_C)} ADD COLUMN extra VARCHAR`,
    );
    const newFields: BqField[] = [...baseFields, { name: 'extra', type: 'STRING' }];
    await upsertTable(db, {
      project: PROJECT,
      datasetId: DATASET,
      tableId: TABLE_C,
      type: 'TABLE',
      schema: { fields: newFields },
    });

    // Second append on the same stream → updated_schema in the response.
    call.write(
      Buffer.from(
        AppendRowsRequest.encode(
          AppendRowsRequest.fromObject({
            writeStream: stream,
            offset: { value: '1' },
            protoRows: {
              rows: { serializedRows: [encodeRow({ id: 2, note: 'after' })] },
            },
          }),
        ).finish(),
      ),
    );
    await waitForResponse(2);
    const resp = responses[1] as {
      updatedSchema?: { fields?: Array<{ name: string; type: string }> };
    };
    assert.ok(resp.updatedSchema !== undefined, 'response should carry updated_schema');
    const names = (resp.updatedSchema.fields ?? []).map((f) => f.name);
    assert.deepEqual(names, ['id', 'note', 'extra']);

    call.end();
    await new Promise<void>((resolve) => call.on('end', resolve));
  } finally {
    client.close();
  }
});

// ---------------------------------------------------------------------------
// BL-127 — multiplexing
// ---------------------------------------------------------------------------

test('Multiplexed AppendRows: one bidi call targets two streams (BL-127)', async () => {
  const streamA = await createCommittedStream(TABLE_A);
  const streamB = await createCommittedStream(TABLE_B);
  const aBefore = await tableRowCount(TABLE_A);
  const bBefore = await tableRowCount(TABLE_B);

  const { error, responses } = await appendRows([
    {
      writeStream: streamA,
      protoRows: {
        writerSchema: { protoDescriptor: baseDescriptor },
        rows: { serializedRows: [encodeRow({ id: 1000, note: 'A-row' })] },
      },
    },
    {
      writeStream: streamB,
      protoRows: {
        writerSchema: { protoDescriptor: baseDescriptor },
        rows: { serializedRows: [encodeRow({ id: 2000, note: 'B-row' })] },
      },
    },
    {
      // Second batch back to stream A — schema is reused per-stream.
      writeStream: streamA,
      protoRows: {
        rows: { serializedRows: [encodeRow({ id: 1001, note: 'A-row-2' })] },
      },
    },
  ]);

  assert.equal(error, null);
  assert.equal(responses.length, 3);
  // Each response echoes the targeted stream.
  const ws = responses.map((r) => (r as Record<string, unknown>)['writeStream']);
  assert.deepEqual(ws, [streamA, streamB, streamA]);

  assert.equal(await tableRowCount(TABLE_A), aBefore + 2);
  assert.equal(await tableRowCount(TABLE_B), bBefore + 1);
});

test('Multiplexed AppendRows tracks per-stream offsets independently (BL-127)', async () => {
  const streamA = await createCommittedStream(TABLE_A);
  const streamB = await createCommittedStream(TABLE_B);

  const { error, responses } = await appendRows([
    {
      writeStream: streamA,
      offset: { value: '0' },
      protoRows: {
        writerSchema: { protoDescriptor: baseDescriptor },
        rows: { serializedRows: [encodeRow({ id: 1, note: 'a1' })] },
      },
    },
    {
      writeStream: streamB,
      offset: { value: '0' },
      protoRows: {
        writerSchema: { protoDescriptor: baseDescriptor },
        rows: { serializedRows: [encodeRow({ id: 1, note: 'b1' })] },
      },
    },
    {
      writeStream: streamA,
      offset: { value: '1' },
      protoRows: {
        rows: { serializedRows: [encodeRow({ id: 2, note: 'a2' })] },
      },
    },
  ]);

  assert.equal(error, null);
  // Each batch responds with its stream's pre-append offset.
  const offsets = responses.map(
    (r) => (r as { appendResult: { offset: { value: string } } }).appendResult.offset.value,
  );
  assert.deepEqual(offsets, ['0', '0', '1']);
});

test('AppendRows requires write_stream on every message (BL-127 guard)', async () => {
  // Without a write_stream, multiplexing has no way to route the
  // message; the real BQ contract requires every message to name a
  // stream (the first one might be implicit but only when proto serializers
  // default fields). Our handler rejects to be explicit.
  const { error } = await appendRows([
    {
      protoRows: {
        writerSchema: { protoDescriptor: baseDescriptor },
        rows: { serializedRows: [encodeRow({ id: 1, note: 'nostream' })] },
      },
    },
  ]);
  assert.ok(error !== null);
  assert.equal(error.code, grpc.status.INVALID_ARGUMENT);
  assert.match(error.details, /write_stream is required/);
});

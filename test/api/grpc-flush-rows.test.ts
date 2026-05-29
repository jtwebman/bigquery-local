/**
 * BL-124 acceptance: FlushRows on BUFFERED streams.
 *
 * Verifies:
 *   - rows aren't visible until FlushRows is called
 *   - FlushRows(offset) promotes only rows below `offset`; later rows stay buffered
 *   - subsequent FlushRows picks up where the previous left off
 *   - omitting the offset flushes everything appended so far
 *   - FlushRows on COMMITTED / PENDING streams → FAILED_PRECONDITION
 *   - out-of-range offsets (past appended, behind already-flushed) → OUT_OF_RANGE
 *   - flushing an unknown stream → NOT_FOUND
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
const FlushRowsRequest = protoRoot.lookupType('google.cloud.bigquery.storage.v1.FlushRowsRequest');
const FlushRowsResponse = protoRoot.lookupType(
  'google.cloud.bigquery.storage.v1.FlushRowsResponse',
);

const PROJECT = 'p-flush';
const DATASET = 'ds';
const TABLE = 'buffered_target';
const PARENT = `projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}`;
const APPEND_PATH = '/google.cloud.bigquery.storage.v1.BigQueryWrite/AppendRows';
const CREATE_PATH = '/google.cloud.bigquery.storage.v1.BigQueryWrite/CreateWriteStream';
const FLUSH_PATH = '/google.cloud.bigquery.storage.v1.BigQueryWrite/FlushRows';

const fields: BqField[] = [
  { name: 'id', type: 'INT64', mode: 'REQUIRED' },
  { name: 'note', type: 'STRING' },
];

const writerDescriptor = {
  name: 'Row',
  field: [
    { name: 'id', number: 1, type: 3, label: 1 },
    { name: 'note', number: 2, type: 9, label: 1 },
  ],
};

const clientRowType = protobuf.Root.fromJSON({
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
  await db.exec(buildCreateTableSql(PROJECT, DATASET, TABLE, fields));
  await upsertTable(db, {
    project: PROJECT,
    datasetId: DATASET,
    tableId: TABLE,
    type: 'TABLE',
    schema: { fields },
  });
  server = createGrpcServer({ db });
  await server.listen(0);
});

after(async () => {
  await server.close();
  await db.close();
});

function unaryCall<RequestT extends object, ResponseT>(
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

async function createStream(type: 'COMMITTED' | 'PENDING' | 'BUFFERED'): Promise<string> {
  const { error, response } = await unaryCall<Record<string, unknown>, { name: string }>(
    CREATE_PATH,
    CreateWriteStreamRequest,
    WriteStream,
    { parent: PARENT, writeStream: { type } },
  );
  assert.equal(error, null);
  assert.ok(response !== null);
  return response.name;
}

function encodeRow(row: { id: number; note: string }): Uint8Array {
  return clientRowType.encode(clientRowType.fromObject(row)).finish();
}

async function appendRows(
  writeStream: string,
  rows: readonly { id: number; note: string }[],
): Promise<void> {
  const req = {
    writeStream,
    protoRows: {
      writerSchema: { protoDescriptor: writerDescriptor },
      rows: { serializedRows: rows.map(encodeRow) },
    },
  };
  const reqBytes = Buffer.from(
    AppendRowsRequest.encode(AppendRowsRequest.fromObject(req)).finish(),
  );
  const client = new grpc.Client(server.url, grpc.credentials.createInsecure());
  await new Promise<void>((resolve, reject) => {
    const call = client.makeBidiStreamRequest(
      APPEND_PATH,
      (v: Buffer) => v,
      (v: Buffer) => v,
    );
    call.on('data', (bytes: Buffer) => {
      AppendRowsResponse.decode(bytes as Uint8Array);
    });
    call.on('error', (err: grpc.ServiceError) => {
      client.close();
      reject(err);
    });
    call.on('end', () => {
      client.close();
      resolve();
    });
    call.write(reqBytes);
    call.end();
  });
}

async function tableRowCount(): Promise<number> {
  const rows = await db.query<{ n: bigint }>(
    `SELECT COUNT(*)::BIGINT AS n FROM ${qualifiedTableName(PROJECT, DATASET, TABLE)}`,
  );
  return Number(rows[0]?.n ?? 0n);
}

test('FlushRows on a BUFFERED stream promotes rows up to and including the requested offset', async () => {
  const stream = await createStream('BUFFERED');
  const initial = await tableRowCount();

  await appendRows(stream, [
    { id: 1, note: 'a' },
    { id: 2, note: 'b' },
    { id: 3, note: 'c' },
    { id: 4, note: 'd' },
  ]);
  // Nothing visible yet — BUFFERED holds everything.
  assert.equal(await tableRowCount(), initial);

  // FlushRows offset is the inclusive last row index. offset=1 makes
  // rows 0,1 visible (2 rows). Response echoes the inclusive offset.
  const r1 = await unaryCall<
    { writeStream: string; offset: { value: string } },
    { offset: string }
  >(FLUSH_PATH, FlushRowsRequest, FlushRowsResponse, {
    writeStream: stream,
    offset: { value: '1' },
  });
  assert.equal(r1.error, null);
  assert.equal(r1.response?.offset, '1');
  assert.equal(await tableRowCount(), initial + 2);

  // Second flush picks up where the first left off: offset=3 makes
  // rows 0,1,2,3 visible total (now 4 rows).
  const r2 = await unaryCall<
    { writeStream: string; offset: { value: string } },
    { offset: string }
  >(FLUSH_PATH, FlushRowsRequest, FlushRowsResponse, {
    writeStream: stream,
    offset: { value: '3' },
  });
  assert.equal(r2.error, null);
  assert.equal(r2.response?.offset, '3');
  assert.equal(await tableRowCount(), initial + 4);
});

test('FlushRows with no offset flushes everything currently buffered', async () => {
  const stream = await createStream('BUFFERED');
  const initial = await tableRowCount();
  await appendRows(stream, [
    { id: 10, note: 'x' },
    { id: 11, note: 'y' },
    { id: 12, note: 'z' },
  ]);
  const { error, response } = await unaryCall<{ writeStream: string }, { offset: string }>(
    FLUSH_PATH,
    FlushRowsRequest,
    FlushRowsResponse,
    { writeStream: stream },
  );
  assert.equal(error, null);
  // 3 rows visible → last inclusive offset = 2.
  assert.equal(response?.offset, '2');
  assert.equal(await tableRowCount(), initial + 3);
});

test('FlushRows on a COMMITTED stream → FAILED_PRECONDITION', async () => {
  const stream = await createStream('COMMITTED');
  const { error } = await unaryCall<{ writeStream: string }, { offset: string }>(
    FLUSH_PATH,
    FlushRowsRequest,
    FlushRowsResponse,
    { writeStream: stream },
  );
  assert.ok(error !== null);
  assert.equal(error.code, grpc.status.FAILED_PRECONDITION);
  assert.match(error.details, /only valid on BUFFERED streams/);
});

test('FlushRows on a PENDING stream → FAILED_PRECONDITION', async () => {
  const stream = await createStream('PENDING');
  const { error } = await unaryCall<{ writeStream: string }, { offset: string }>(
    FLUSH_PATH,
    FlushRowsRequest,
    FlushRowsResponse,
    { writeStream: stream },
  );
  assert.ok(error !== null);
  assert.equal(error.code, grpc.status.FAILED_PRECONDITION);
});

test('FlushRows with offset >= appended → OUT_OF_RANGE', async () => {
  const stream = await createStream('BUFFERED');
  await appendRows(stream, [{ id: 1, note: 'a' }]);
  const { error } = await unaryCall<
    { writeStream: string; offset: { value: string } },
    { offset: string }
  >(FLUSH_PATH, FlushRowsRequest, FlushRowsResponse, {
    writeStream: stream,
    offset: { value: '99' },
  });
  assert.ok(error !== null);
  assert.equal(error.code, grpc.status.OUT_OF_RANGE);
  assert.match(error.details, /beyond appended end/);
});

test('FlushRows with offset below already-flushed is idempotent (BL-124 + BQ parity)', async () => {
  const stream = await createStream('BUFFERED');
  const initial = await tableRowCount();
  await appendRows(stream, [
    { id: 1, note: 'a' },
    { id: 2, note: 'b' },
  ]);
  // Flush both rows (offset=1 makes rows 0,1 visible).
  await unaryCall<{ writeStream: string; offset: { value: string } }, { offset: string }>(
    FLUSH_PATH,
    FlushRowsRequest,
    FlushRowsResponse,
    { writeStream: stream, offset: { value: '1' } },
  );
  const afterFirstFlush = await tableRowCount();
  assert.equal(afterFirstFlush, initial + 2);

  // Re-request flush of an already-visible offset. Real BQ returns
  // success (echoes the current visible offset) without re-writing.
  const { error, response } = await unaryCall<
    { writeStream: string; offset: { value: string } },
    { offset: string }
  >(FLUSH_PATH, FlushRowsRequest, FlushRowsResponse, {
    writeStream: stream,
    offset: { value: '0' },
  });
  assert.equal(error, null);
  // Response echoes the current last-visible offset (1), not the request.
  assert.equal(response?.offset, '1');
  // No additional rows written — idempotent.
  assert.equal(await tableRowCount(), afterFirstFlush);
});

test('FlushRows on an unknown stream → NOT_FOUND', async () => {
  const { error } = await unaryCall<{ writeStream: string }, { offset: string }>(
    FLUSH_PATH,
    FlushRowsRequest,
    FlushRowsResponse,
    { writeStream: `${PARENT}/streams/ghost` },
  );
  assert.ok(error !== null);
  assert.equal(error.code, grpc.status.NOT_FOUND);
});

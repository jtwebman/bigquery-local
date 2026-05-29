/**
 * BL-123 acceptance: explicit application streams (PENDING / BUFFERED
 * / COMMITTED) plus FinalizeWriteStream + BatchCommitWriteStreams.
 *
 * The headline test covers the canonical PENDING workflow:
 *   1. CreateWriteStream(type=PENDING)
 *   2. AppendRows — rows are NOT visible in the table
 *   3. FinalizeWriteStream — no more appends accepted
 *   4. BatchCommitWriteStreams — rows now visible atomically
 *
 * Plus: COMMITTED streams visible immediately, append after finalize
 * fails, type=UNSPECIFIED fails, batch-commit of a non-PENDING stream
 * surfaces a per-stream error without aborting the batch.
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
const FinalizeWriteStreamRequest = protoRoot.lookupType(
  'google.cloud.bigquery.storage.v1.FinalizeWriteStreamRequest',
);
const FinalizeWriteStreamResponse = protoRoot.lookupType(
  'google.cloud.bigquery.storage.v1.FinalizeWriteStreamResponse',
);
const BatchCommitWriteStreamsRequest = protoRoot.lookupType(
  'google.cloud.bigquery.storage.v1.BatchCommitWriteStreamsRequest',
);
const BatchCommitWriteStreamsResponse = protoRoot.lookupType(
  'google.cloud.bigquery.storage.v1.BatchCommitWriteStreamsResponse',
);

const PROJECT = 'p-app';
const DATASET = 'ds';
const TABLE = 'pending_target';
const PARENT = `projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}`;
const APPEND_PATH = '/google.cloud.bigquery.storage.v1.BigQueryWrite/AppendRows';
const CREATE_PATH = '/google.cloud.bigquery.storage.v1.BigQueryWrite/CreateWriteStream';
const FINALIZE_PATH = '/google.cloud.bigquery.storage.v1.BigQueryWrite/FinalizeWriteStream';
const COMMIT_PATH = '/google.cloud.bigquery.storage.v1.BigQueryWrite/BatchCommitWriteStreams';

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
          bytes: Buffer,
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
    {
      parent: PARENT,
      writeStream: { type },
    },
  );
  assert.equal(error, null);
  assert.ok(response !== null);
  assert.ok(response.name.startsWith(`${PARENT}/streams/`));
  return response.name;
}

function encodeRow(row: { id: number; note: string }): Uint8Array {
  return clientRowType.encode(clientRowType.fromObject(row)).finish();
}

interface AppendOutcome {
  readonly responses: ReadonlyArray<Record<string, unknown>>;
  readonly error: grpc.ServiceError | null;
}

function appendRows(
  writeStream: string,
  rows: readonly { id: number; note: string }[],
  options: { includeSchema?: boolean } = {},
): Promise<AppendOutcome> {
  const includeSchema = options.includeSchema ?? true;
  const req = {
    writeStream,
    protoRows: {
      ...(includeSchema && { writerSchema: { protoDescriptor: writerDescriptor } }),
      rows: { serializedRows: rows.map(encodeRow) },
    },
  };
  const reqBytes = Buffer.from(
    AppendRowsRequest.encode(AppendRowsRequest.fromObject(req)).finish(),
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

test('PENDING stream: appends are buffered until BatchCommit', async () => {
  const initial = await tableRowCount();
  const streamName = await createStream('PENDING');

  // Append rows — should NOT be visible yet.
  const r1 = await appendRows(streamName, [
    { id: 1, note: 'pending-a' },
    { id: 2, note: 'pending-b' },
  ]);
  assert.equal(r1.error, null);
  assert.equal(r1.responses.length, 1);
  assert.equal(await tableRowCount(), initial, 'rows must not be visible before commit');

  // Finalize the stream — no more appends.
  const finalize = await unaryCall<{ name: string }, { rowCount: string }>(
    FINALIZE_PATH,
    FinalizeWriteStreamRequest,
    FinalizeWriteStreamResponse,
    { name: streamName },
  );
  assert.equal(finalize.error, null);
  assert.equal(finalize.response?.rowCount, '2');

  // Second append AFTER finalize must fail with FAILED_PRECONDITION.
  const r2 = await appendRows(streamName, [{ id: 3, note: 'too-late' }], { includeSchema: true });
  assert.ok(r2.error !== null);
  assert.equal(r2.error.code, grpc.status.FAILED_PRECONDITION);

  // BatchCommit — rows now visible.
  const commit = await unaryCall<
    { parent: string; writeStreams: string[] },
    { commitTime: object; streamErrors?: unknown[] }
  >(COMMIT_PATH, BatchCommitWriteStreamsRequest, BatchCommitWriteStreamsResponse, {
    parent: PARENT,
    writeStreams: [streamName],
  });
  assert.equal(commit.error, null);
  assert.ok(commit.response?.commitTime !== undefined);
  assert.deepEqual(commit.response?.streamErrors ?? [], [], 'no per-stream errors');
  assert.equal(await tableRowCount(), initial + 2, 'rows visible after commit');

  // Sanity: the actual values landed.
  const visible = await db.query<{ id: bigint; note: string }>(
    `SELECT id, note FROM ${qualifiedTableName(PROJECT, DATASET, TABLE)} WHERE note LIKE 'pending-%' ORDER BY id`,
  );
  assert.equal(visible.length, 2);
  assert.equal(visible[0]?.note, 'pending-a');
  assert.equal(visible[1]?.note, 'pending-b');
});

test('COMMITTED stream: rows are visible immediately on append', async () => {
  const streamName = await createStream('COMMITTED');
  const initial = await tableRowCount();
  const { error } = await appendRows(streamName, [{ id: 100, note: 'committed-a' }]);
  assert.equal(error, null);
  assert.equal(await tableRowCount(), initial + 1);
});

test('CreateWriteStream rejects TYPE_UNSPECIFIED / missing type', async () => {
  const { error } = await unaryCall<Record<string, unknown>, { name: string }>(
    CREATE_PATH,
    CreateWriteStreamRequest,
    WriteStream,
    { parent: PARENT, writeStream: {} },
  );
  assert.ok(error !== null);
  assert.equal(error.code, grpc.status.INVALID_ARGUMENT);
  assert.match(error.details, /write_stream\.type is required/);
});

test('CreateWriteStream on non-existent table → NOT_FOUND', async () => {
  const { error } = await unaryCall<Record<string, unknown>, { name: string }>(
    CREATE_PATH,
    CreateWriteStreamRequest,
    WriteStream,
    {
      parent: `projects/${PROJECT}/datasets/${DATASET}/tables/ghost`,
      writeStream: { type: 'PENDING' },
    },
  );
  assert.ok(error !== null);
  assert.equal(error.code, grpc.status.NOT_FOUND);
});

test('CreateWriteStream with a malformed parent → INVALID_ARGUMENT', async () => {
  const { error } = await unaryCall<Record<string, unknown>, { name: string }>(
    CREATE_PATH,
    CreateWriteStreamRequest,
    WriteStream,
    { parent: 'not-a-table-ref', writeStream: { type: 'PENDING' } },
  );
  assert.ok(error !== null);
  assert.equal(error.code, grpc.status.INVALID_ARGUMENT);
});

test('FinalizeWriteStream on unknown stream → NOT_FOUND', async () => {
  const { error } = await unaryCall<{ name: string }, { rowCount: string }>(
    FINALIZE_PATH,
    FinalizeWriteStreamRequest,
    FinalizeWriteStreamResponse,
    { name: `${PARENT}/streams/ghost` },
  );
  assert.ok(error !== null);
  assert.equal(error.code, grpc.status.NOT_FOUND);
});

test('BatchCommit surfaces per-stream errors instead of aborting the batch', async () => {
  // Create two streams: one valid PENDING that we finalize, one COMMITTED (commit invalid).
  const pendingStream = await createStream('PENDING');
  await appendRows(pendingStream, [{ id: 200, note: 'mixed-batch' }]);
  await unaryCall<{ name: string }, { rowCount: string }>(
    FINALIZE_PATH,
    FinalizeWriteStreamRequest,
    FinalizeWriteStreamResponse,
    { name: pendingStream },
  );
  const committedStream = await createStream('COMMITTED');

  const initial = await tableRowCount();
  const commit = await unaryCall<
    { parent: string; writeStreams: string[] },
    { commitTime: object; streamErrors?: Array<{ entity: string; errorMessage: string }> }
  >(COMMIT_PATH, BatchCommitWriteStreamsRequest, BatchCommitWriteStreamsResponse, {
    parent: PARENT,
    writeStreams: [pendingStream, committedStream, `${PARENT}/streams/ghost`],
  });
  assert.equal(commit.error, null);
  // Pending one commits cleanly (row visible); errors surface for the other two.
  assert.equal(await tableRowCount(), initial + 1);
  const errors = commit.response?.streamErrors ?? [];
  assert.equal(errors.length, 2);
  const errorEntities = new Set(errors.map((e) => e.entity));
  assert.ok(errorEntities.has(committedStream), 'COMMITTED stream rejected from batch commit');
  assert.ok(errorEntities.has(`${PARENT}/streams/ghost`), 'unknown stream surfaces as error');
});

test('BUFFERED stream: rows buffered (FlushRows comes in BL-124)', async () => {
  const streamName = await createStream('BUFFERED');
  const initial = await tableRowCount();
  const { error } = await appendRows(streamName, [{ id: 300, note: 'buffered-a' }]);
  assert.equal(error, null);
  // Buffered without FlushRows — not visible.
  assert.equal(await tableRowCount(), initial);
});

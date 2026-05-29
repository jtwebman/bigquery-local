/**
 * BL-120 acceptance: multiple parallel streams.
 *
 * Boots the gRPC server, populates a table with N rows, opens a read
 * session with `maxStreamCount > 1`, reads every stream, and verifies:
 *   - the right number of streams is created (1 ≤ S ≤ maxStreamCount)
 *   - row id values across all streams are exactly the set [1..N]
 *     with no duplicates and no missing entries
 *   - the slice sizes add up to N
 *   - empty-table sessions still get one stream that emits an empty batch
 *   - row_restriction is applied first, then the filtered count is split
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import * as grpc from '@grpc/grpc-js';
import avsc from 'avsc';
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

const root = protobuf.Root.fromJSON(descriptor as protobuf.INamespace);
const CreateReadSessionRequest = root.lookupType(
  'google.cloud.bigquery.storage.v1.CreateReadSessionRequest',
);
const ReadSession = root.lookupType('google.cloud.bigquery.storage.v1.ReadSession');
const ReadRowsRequest = root.lookupType('google.cloud.bigquery.storage.v1.ReadRowsRequest');
const ReadRowsResponse = root.lookupType('google.cloud.bigquery.storage.v1.ReadRowsResponse');

const PROJECT = 'p-multi';
const DATASET = 'ds';
const TABLE = 'big';
const CREATE_PATH = '/google.cloud.bigquery.storage.v1.BigQueryRead/CreateReadSession';
const READ_PATH = '/google.cloud.bigquery.storage.v1.BigQueryRead/ReadRows';

const ROW_COUNT = 23;

const fields: BqField[] = [
  { name: 'id', type: 'INT64', mode: 'REQUIRED' },
  { name: 'name', type: 'STRING' },
];

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
  const qualified = qualifiedTableName(PROJECT, DATASET, TABLE);
  const values = Array.from({ length: ROW_COUNT }, (_, i) => `(${i + 1}, 'row-${i + 1}')`).join(
    ', ',
  );
  await db.exec(`INSERT INTO ${qualified} VALUES ${values}`);
  server = createGrpcServer({ db });
  await server.listen(0);
});

after(async () => {
  await server.close();
  await db.close();
});

interface MultiStreamSession {
  readonly schemaJson: string;
  readonly streams: ReadonlyArray<{ name: string }>;
  readonly estimatedRowCount: string;
}

async function openSession(options: {
  maxStreamCount?: number;
  rowRestriction?: string;
  table?: string;
}): Promise<MultiStreamSession> {
  const requestBytes = Buffer.from(
    CreateReadSessionRequest.encode(
      CreateReadSessionRequest.fromObject({
        parent: `projects/${PROJECT}`,
        readSession: {
          table: options.table ?? `projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}`,
          dataFormat: 'AVRO',
          ...(options.rowRestriction !== undefined && {
            readOptions: { rowRestriction: options.rowRestriction },
          }),
        },
        ...(options.maxStreamCount !== undefined && { maxStreamCount: options.maxStreamCount }),
      }),
    ).finish(),
  );
  const client = new grpc.Client(server.url, grpc.credentials.createInsecure());
  return new Promise((resolve, reject) => {
    client.makeUnaryRequest(
      CREATE_PATH,
      (v: Buffer) => v,
      (v: Buffer) => v,
      requestBytes,
      (err, response) => {
        client.close();
        if (err !== null) {
          reject(err);
          return;
        }
        const msg = ReadSession.decode(response as Uint8Array);
        const obj = ReadSession.toObject(msg, {
          defaults: false,
          longs: String,
          enums: String,
          arrays: true,
          objects: true,
        }) as Record<string, unknown>;
        resolve({
          schemaJson: (obj['avroSchema'] as { schema: string }).schema,
          streams: obj['streams'] as ReadonlyArray<{ name: string }>,
          estimatedRowCount: (obj['estimatedRowCount'] as string) ?? '0',
        });
      },
    );
  });
}

async function readStreamIds(streamName: string, schemaJson: string): Promise<number[]> {
  const requestBytes = Buffer.from(
    ReadRowsRequest.encode(ReadRowsRequest.fromObject({ readStream: streamName })).finish(),
  );
  const avroType = avsc.Type.forSchema(JSON.parse(schemaJson));
  const ids: number[] = [];
  const client = new grpc.Client(server.url, grpc.credentials.createInsecure());
  await new Promise<void>((resolve, reject) => {
    const call = client.makeServerStreamRequest(
      READ_PATH,
      (v: Buffer) => v,
      (v: Buffer) => v,
      requestBytes,
    );
    call.on('data', (bytes: Buffer) => {
      const msg = ReadRowsResponse.decode(bytes as Uint8Array);
      const obj = ReadRowsResponse.toObject(msg, {
        defaults: false,
        longs: Number,
        enums: String,
        arrays: true,
        objects: true,
        bytes: Buffer,
      }) as { avroRows?: { serializedBinaryRows?: Buffer } };
      const payload = obj.avroRows?.serializedBinaryRows;
      if (payload === undefined || payload.length === 0) return;
      let offset = 0;
      while (offset < payload.length) {
        const { value, offset: next } = avroType.decode(payload, offset);
        const row = value as { id?: number };
        if (row?.id !== undefined) ids.push(Number(row.id));
        offset = next;
      }
    });
    call.on('error', (err) => {
      client.close();
      reject(err);
    });
    call.on('end', () => {
      client.close();
      resolve();
    });
  });
  return ids;
}

test('session with maxStreamCount=4 partitions rows into 4 disjoint slices', async () => {
  const session = await openSession({ maxStreamCount: 4 });
  assert.equal(session.streams.length, 4);
  // Unfiltered estimated row count is the full table.
  assert.equal(session.estimatedRowCount, String(ROW_COUNT));

  const allIds: number[] = [];
  for (const s of session.streams) {
    const ids = await readStreamIds(s.name, session.schemaJson);
    // Each stream should return some rows; never empty given 23 rows / 4 streams.
    assert.ok(ids.length >= 1, `stream ${s.name} returned no rows`);
    allIds.push(...ids);
  }

  // Every id 1..23 appears exactly once across all streams.
  allIds.sort((a, b) => a - b);
  assert.deepEqual(
    allIds,
    Array.from({ length: ROW_COUNT }, (_, i) => i + 1),
    'rows across streams should be the full table, no duplicates',
  );
});

test('maxStreamCount > row count caps at the actual row count', async () => {
  const session = await openSession({ maxStreamCount: 1000 });
  assert.equal(session.streams.length, ROW_COUNT);
  // Each stream should get exactly one row.
  for (const s of session.streams) {
    const ids = await readStreamIds(s.name, session.schemaJson);
    assert.equal(ids.length, 1, `stream ${s.name} should hold exactly one row`);
  }
});

test('default (no maxStreamCount) keeps a single stream', async () => {
  const session = await openSession({});
  assert.equal(session.streams.length, 1);
  const ids = await readStreamIds(session.streams[0]?.name ?? '', session.schemaJson);
  assert.equal(ids.length, ROW_COUNT);
});

test('row_restriction is applied before slicing — filtered total splits evenly', async () => {
  // Restrict to id > 18 → 5 rows (19,20,21,22,23). Ask for 3 streams.
  const session = await openSession({ maxStreamCount: 3, rowRestriction: 'id > 18' });
  assert.equal(session.streams.length, 3);
  const allIds: number[] = [];
  for (const s of session.streams) {
    allIds.push(...(await readStreamIds(s.name, session.schemaJson)));
  }
  allIds.sort((a, b) => a - b);
  assert.deepEqual(allIds, [19, 20, 21, 22, 23]);
});

test('empty table still yields one stream that delivers an empty batch + schema', async () => {
  // Create a fresh empty table on the fly.
  const emptyTableId = 'empty';
  await db.exec(buildCreateTableSql(PROJECT, DATASET, emptyTableId, fields));
  await upsertTable(db, {
    project: PROJECT,
    datasetId: DATASET,
    tableId: emptyTableId,
    type: 'TABLE',
    schema: { fields },
  });
  const session = await openSession({
    table: `projects/${PROJECT}/datasets/${DATASET}/tables/${emptyTableId}`,
    maxStreamCount: 5,
  });
  // No rows to slice, so we still emit one stream — clients need somewhere
  // to receive the schema.
  assert.equal(session.streams.length, 1);
  assert.equal(session.estimatedRowCount, '0');
  const ids = await readStreamIds(session.streams[0]?.name ?? '', session.schemaJson);
  assert.equal(ids.length, 0);
});

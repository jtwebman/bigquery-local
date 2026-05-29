/**
 * BL-119 acceptance test: ReadRows over Arrow IPC.
 *
 * Boots the gRPC server with a shared in-memory DuckDB, creates a real
 * table with a mix of BigQuery types, inserts a fixture, opens an Arrow
 * Read session, and streams `ReadRows`. The IPC bytes are decoded
 * end-to-end via `apache-arrow.RecordBatchReader` so we exercise the
 * exact path a pyarrow / arrow-cpp client would take.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import * as grpc from '@grpc/grpc-js';
import { RecordBatchReader } from 'apache-arrow';
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

const PROJECT = 'p-arrow';
const DATASET = 'ds';
const TABLE = 'mixed_arrow';
const CREATE_PATH = '/google.cloud.bigquery.storage.v1.BigQueryRead/CreateReadSession';
const READ_PATH = '/google.cloud.bigquery.storage.v1.BigQueryRead/ReadRows';

const fields: BqField[] = [
  { name: 'id', type: 'INT64', mode: 'REQUIRED' },
  { name: 'name', type: 'STRING' },
  { name: 'price', type: 'FLOAT64' },
  { name: 'placed_on', type: 'DATE' },
  { name: 'last_login', type: 'TIMESTAMP' },
  { name: 'amount', type: 'NUMERIC' },
  { name: 'tags', type: 'STRING', mode: 'REPEATED' },
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
  await db.exec(`INSERT INTO ${qualified} VALUES
    (1, 'alice', 1.5, DATE '1990-04-15', TIMESTAMPTZ '2024-01-02 03:04:05+00',
     CAST('12.5' AS DECIMAL(38,9)), ['a', 'b']),
    (2, 'bob', NULL, NULL, NULL, NULL, []),
    (3, NULL, -0.25, DATE '2000-01-01', TIMESTAMPTZ '2025-06-15 12:00:00+00',
     CAST('-99.999' AS DECIMAL(38,9)), ['x'])`);
  server = createGrpcServer({ db });
  await server.listen(0);
});

after(async () => {
  await server.close();
  await db.close();
});

async function createArrowReadSession(): Promise<Record<string, unknown>> {
  const requestBytes = Buffer.from(
    CreateReadSessionRequest.encode(
      CreateReadSessionRequest.fromObject({
        parent: `projects/${PROJECT}`,
        readSession: {
          table: `projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}`,
          dataFormat: 'ARROW',
        },
      }),
    ).finish(),
  );
  const client = new grpc.Client(server.url, grpc.credentials.createInsecure());
  return new Promise<Record<string, unknown>>((resolve, reject) => {
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
        resolve(
          ReadSession.toObject(msg, {
            defaults: false,
            longs: Number,
            enums: String,
            arrays: true,
            objects: true,
            bytes: Buffer,
          }) as Record<string, unknown>,
        );
      },
    );
  });
}

async function readAllArrowResponses(
  streamName: string,
): Promise<Array<{ schema?: Uint8Array; batch?: Uint8Array }>> {
  const requestBytes = Buffer.from(
    ReadRowsRequest.encode(ReadRowsRequest.fromObject({ readStream: streamName })).finish(),
  );
  const client = new grpc.Client(server.url, grpc.credentials.createInsecure());
  return new Promise((resolve, reject) => {
    const messages: Array<{ schema?: Uint8Array; batch?: Uint8Array }> = [];
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
      }) as {
        arrowSchema?: { serializedSchema?: Buffer };
        arrowRecordBatch?: { serializedRecordBatch?: Buffer };
      };
      messages.push({
        ...(obj.arrowSchema?.serializedSchema && { schema: obj.arrowSchema.serializedSchema }),
        ...(obj.arrowRecordBatch?.serializedRecordBatch && {
          batch: obj.arrowRecordBatch.serializedRecordBatch,
        }),
      });
    });
    call.on('error', (err) => {
      client.close();
      reject(err);
    });
    call.on('end', () => {
      client.close();
      resolve(messages);
    });
  });
}

test('Arrow CreateReadSession + ReadRows: IPC bytes decode through apache-arrow', async () => {
  const session = await createArrowReadSession();
  const streamName = (session['streams'] as Array<{ name: string }>)[0]?.name as string;
  const sessionSchemaBytes = (session['arrowSchema'] as { serializedSchema: Buffer })
    .serializedSchema;

  const responses = await readAllArrowResponses(streamName);
  assert.ok(responses.length >= 1, 'at least one ReadRows response');
  assert.ok(responses[0]?.schema !== undefined, 'first response carries the schema');

  // Concatenate [schema][batches...] + the standard end-of-stream marker so
  // apache-arrow's RecordBatchReader sees a well-formed stream.
  const parts: Uint8Array[] = [sessionSchemaBytes];
  for (const r of responses) {
    if (r.batch !== undefined) parts.push(r.batch);
  }
  // Stream EOS = 4 byte continuation marker (0xFFFFFFFF) + 4 byte zero length.
  parts.push(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]));
  const combined = Buffer.concat(parts.map((p) => Buffer.from(p)));

  const reader = RecordBatchReader.from(combined);
  const batches = [...reader];
  assert.ok(batches.length >= 1, 'at least one batch decoded');

  // Aggregate all rows.
  type Row = Record<string, unknown>;
  const rows: Row[] = [];
  for (const b of batches) {
    for (let i = 0; i < b.numRows; i++) {
      rows.push(b.get(i)?.toJSON() as Row);
    }
  }
  assert.equal(rows.length, 3);

  // Each row keyed by id for deterministic checks (DuckDB → insertion order,
  // but our test should not depend on that — sort first).
  rows.sort((a, b) => Number(a['id']) - Number(b['id']));

  const row1 = rows[0] as Row;
  assert.equal(row1['id'], 1n);
  assert.equal(row1['name'], 'alice');
  assert.equal(row1['price'], 1.5);
  // DATE → arrow's Date32 surfaces as either a JS Date or millis since
  // epoch (number) depending on the apache-arrow build.
  const placedOn = row1['placed_on'];
  const placedOnDate = placedOn instanceof Date ? placedOn : new Date(Number(placedOn));
  assert.equal(placedOnDate.toISOString().slice(0, 10), '1990-04-15');
  // TIMESTAMP → arrow Timestamp(µs, UTC) surfaces as a JS Date or as
  // millis-since-epoch (apache-arrow divides our µs storage by 1000).
  const lastLogin = row1['last_login'];
  const lastLoginDate = lastLogin instanceof Date ? lastLogin : new Date(Number(lastLogin));
  assert.equal(lastLoginDate.toISOString(), '2024-01-02T03:04:05.000Z');
  // REPEATED STRING → array
  // Arrow's List<Utf8> surfaces as a Vector; convert to a plain array.
  assert.deepEqual([...(row1['tags'] as Iterable<string>)], ['a', 'b']);

  const row2 = rows[1] as Row;
  assert.equal(row2['name'], 'bob');
  assert.equal(row2['price'], null);
  assert.equal(row2['placed_on'], null);
  assert.equal(row2['last_login'], null);
  assert.deepEqual([...(row2['tags'] as Iterable<string>)], []);

  const row3 = rows[2] as Row;
  assert.equal(row3['id'], 3n);
  assert.equal(row3['name'], null);
  assert.equal(row3['price'], -0.25);
});

test('Arrow ReadRows for an empty result still emits one response carrying the schema', async () => {
  // Create a fresh session that filters everything out — every row's id is positive.
  const session = await (async () => {
    const requestBytes = Buffer.from(
      CreateReadSessionRequest.encode(
        CreateReadSessionRequest.fromObject({
          parent: `projects/${PROJECT}`,
          readSession: {
            table: `projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}`,
            dataFormat: 'ARROW',
            readOptions: { rowRestriction: 'id < 0' },
          },
        }),
      ).finish(),
    );
    const client = new grpc.Client(server.url, grpc.credentials.createInsecure());
    return new Promise<Record<string, unknown>>((resolve, reject) => {
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
          resolve(
            ReadSession.toObject(msg, {
              defaults: false,
              longs: Number,
              enums: String,
              arrays: true,
              objects: true,
              bytes: Buffer,
            }) as Record<string, unknown>,
          );
        },
      );
    });
  })();
  const streamName = (session['streams'] as Array<{ name: string }>)[0]?.name as string;
  const responses = await readAllArrowResponses(streamName);
  assert.equal(responses.length, 1);
  assert.ok(responses[0]?.schema !== undefined);
  assert.ok(responses[0]?.batch !== undefined);
});

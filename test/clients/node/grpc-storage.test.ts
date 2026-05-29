/**
 * Node.js Storage Read + Write client integration test.
 *
 * Uses the official `@google-cloud/bigquery-storage` package as a
 * real gRPC client against our emulator. The `_default` stream write
 * + Storage Read round-trip is the end-to-end exercise: insert via
 * AppendRows, then read back via CreateReadSession + ReadRows.
 *
 * This is the test that would catch a regression where our wire shape
 * diverged from what the official client expects (descriptor encoding,
 * default values, etag handling, etc.).
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import * as grpc from '@grpc/grpc-js';
import { v1 as bigqueryStorage } from '@google-cloud/bigquery-storage';
import protobuf from 'protobufjs';

import { type GrpcServer, createGrpcServer } from '../../../src/grpc.ts';
import {
  buildCreateTableSql,
  ensureDatasetSchema,
  qualifiedTableName,
} from '../../../src/routes/tables.ts';
import { type Db, createDb } from '../../../src/storage/db.ts';
import { ensureMetaSchema, upsertDataset, upsertTable } from '../../../src/storage/meta.ts';
import type { BqField } from '../../../src/storage/types.ts';

const PROJECT = 'p-node-grpc';
const DATASET = 'ds';
const TABLE = 'node_storage';

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
  server = createGrpcServer({ db });
  await server.listen(0);
});

after(async () => {
  await server.close();
  await db.close();
});

function clientOptions(
  endpoint: string,
): ConstructorParameters<typeof bigqueryStorage.BigQueryReadClient>[0] {
  // `endpoint` is host:port; google-gax wants those split.
  const [host, port] = endpoint.split(':') as [string, string];
  return {
    apiEndpoint: host,
    port: Number(port),
    sslCreds: grpc.credentials.createInsecure(),
    projectId: PROJECT,
  };
}

test('@google-cloud/bigquery-storage BigQueryWriteClient can append rows on _default stream', async () => {
  const writeClient = new bigqueryStorage.BigQueryWriteClient(clientOptions(server.url));
  const defaultStream = `projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}/streams/_default`;

  // Build a writer schema + row encoder using protobufjs.
  const RowType = protobuf.Root.fromJSON({
    nested: {
      Row: { fields: { id: { type: 'int64', id: 1 }, name: { type: 'string', id: 2 } } },
    },
  }).lookupType('Row');

  const stream = writeClient.appendRows();
  const responses: object[] = [];
  stream.on('data', (msg: object) => responses.push(msg));
  const ended = new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    stream.on('end', resolve);
  });

  await stream.write({
    writeStream: defaultStream,
    protoRows: {
      writerSchema: {
        protoDescriptor: {
          name: 'Row',
          field: [
            { name: 'id', number: 1, type: 3, label: 1 },
            { name: 'name', number: 2, type: 9, label: 1 },
          ],
        },
      },
      rows: {
        serializedRows: [
          RowType.encode(RowType.fromObject({ id: 1, name: 'alice' })).finish(),
          RowType.encode(RowType.fromObject({ id: 2, name: 'bob' })).finish(),
        ],
      },
    },
  });
  stream.end();
  await ended;
  await writeClient.close();

  assert.equal(responses.length, 1);

  // Verify rows landed.
  const rows = await db.query<{ id: bigint; name: string }>(
    `SELECT id, name FROM ${qualifiedTableName(PROJECT, DATASET, TABLE)} ORDER BY id`,
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.name, 'alice');
  assert.equal(rows[1]?.name, 'bob');
});

test('@google-cloud/bigquery-storage BigQueryReadClient reads via Avro IPC', async () => {
  const readClient = new bigqueryStorage.BigQueryReadClient(clientOptions(server.url));
  const [session] = await readClient.createReadSession({
    parent: `projects/${PROJECT}`,
    readSession: {
      table: `projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}`,
      dataFormat: 'AVRO',
    },
  });
  const streams = session.streams ?? [];
  assert.ok(streams.length >= 1, 'at least one stream');
  assert.ok(session.avroSchema?.schema?.includes('"__root__"'));
  assert.equal(Number(session.estimatedRowCount ?? 0), 2);

  const streamName = streams[0]?.name ?? '';
  const readStream = readClient.readRows({ readStream: streamName });
  const batches: unknown[] = [];
  for await (const response of readStream as AsyncIterable<unknown>) {
    batches.push(response);
  }
  assert.ok(batches.length >= 1, 'at least one ReadRowsResponse');
  await readClient.close();
});

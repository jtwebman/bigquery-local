/**
 * BL-122 acceptance: AppendRows against the `_default` write stream.
 *
 * Boots the gRPC server backed by an in-memory DuckDB, creates a real
 * empty table, opens a bidirectional `AppendRows` stream, and writes a
 * batch of rows. Verifies:
 *   - the rows land in the table (queryable via the existing tabledata
 *     path)
 *   - the server's AppendRowsResponse carries an `appendResult.offset`
 *   - WriterSchema only needs to be sent on the first request; later
 *     requests reuse it
 *   - non-`_default` streams currently return INVALID_ARGUMENT (the
 *     "explicit streams" story is BL-123)
 *   - unknown tables return NOT_FOUND
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

const PROJECT = 'p-write';
const DATASET = 'ds';
const TABLE = 'append_target';
const APPEND_PATH = '/google.cloud.bigquery.storage.v1.BigQueryWrite/AppendRows';
const DEFAULT_STREAM = `projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}/streams/_default`;

const fields: BqField[] = [
  { name: 'id', type: 'INT64', mode: 'REQUIRED' },
  { name: 'name', type: 'STRING' },
  { name: 'active', type: 'BOOL' },
];

// Build a writer schema (DescriptorProto) for the row shape above.
const writerDescriptor = {
  name: 'Row',
  field: [
    { name: 'id', number: 1, type: 3, label: 1 }, // INT64
    { name: 'name', number: 2, type: 9, label: 1 }, // STRING
    { name: 'active', number: 3, type: 8, label: 1 }, // BOOL
  ],
};

// A protobufjs Type matching writerDescriptor — used to encode our test rows.
const clientRowType = protobuf.Root.fromJSON({
  nested: {
    Row: {
      fields: {
        id: { type: 'int64', id: 1 },
        name: { type: 'string', id: 2 },
        active: { type: 'bool', id: 3 },
      },
    },
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

function encodeRequest(value: object): Buffer {
  return Buffer.from(AppendRowsRequest.encode(AppendRowsRequest.fromObject(value)).finish());
}

function encodeRow(row: { id: number; name: string | null; active: boolean | null }): Uint8Array {
  return clientRowType.encode(clientRowType.fromObject(row)).finish();
}

interface AppendOutcome {
  readonly responses: ReadonlyArray<Record<string, unknown>>;
  readonly error: grpc.ServiceError | null;
}

function callAppendRows(requests: ReadonlyArray<object>): Promise<AppendOutcome> {
  const client = new grpc.Client(server.url, grpc.credentials.createInsecure());
  return new Promise<AppendOutcome>((resolve) => {
    const responses: Array<Record<string, unknown>> = [];
    const call = client.makeBidiStreamRequest(
      APPEND_PATH,
      (v: Buffer) => v,
      (v: Buffer) => v,
    );
    call.on('data', (bytes: Buffer) => {
      const msg = AppendRowsResponse.decode(bytes as Uint8Array);
      responses.push(
        AppendRowsResponse.toObject(msg, {
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
    for (const r of requests) call.write(encodeRequest(r));
    call.end();
  });
}

test('AppendRows _default stream writes rows that show up in the table', async () => {
  const { error, responses } = await callAppendRows([
    {
      writeStream: DEFAULT_STREAM,
      protoRows: {
        writerSchema: { protoDescriptor: writerDescriptor },
        rows: {
          serializedRows: [
            encodeRow({ id: 1, name: 'alice', active: true }),
            encodeRow({ id: 2, name: 'bob', active: false }),
          ],
        },
      },
    },
  ]);
  assert.equal(error, null);
  assert.equal(responses.length, 1);
  const result = responses[0] as {
    appendResult?: { offset?: { value?: string } };
    writeStream?: string;
  };
  assert.equal(result.writeStream, DEFAULT_STREAM);
  // First append on an empty table starts at offset 0.
  assert.equal(result.appendResult?.offset?.value, '0');

  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, name, active FROM ${qualifiedTableName(PROJECT, DATASET, TABLE)} ORDER BY id`,
  );
  assert.equal(rows.length, 2);
  assert.equal(Number(rows[0]?.['id']), 1);
  assert.equal(rows[0]?.['name'], 'alice');
  assert.equal(rows[0]?.['active'], true);
  assert.equal(rows[1]?.['name'], 'bob');
  assert.equal(rows[1]?.['active'], false);
});

test('Subsequent AppendRows requests reuse the writer schema from the first', async () => {
  // Send the schema once, then a second batch with no schema set.
  const { error, responses } = await callAppendRows([
    {
      writeStream: DEFAULT_STREAM,
      protoRows: {
        writerSchema: { protoDescriptor: writerDescriptor },
        rows: { serializedRows: [encodeRow({ id: 100, name: 'first', active: true })] },
      },
    },
    {
      writeStream: DEFAULT_STREAM,
      protoRows: {
        rows: { serializedRows: [encodeRow({ id: 101, name: 'second', active: false })] },
      },
    },
  ]);
  assert.equal(error, null);
  assert.equal(responses.length, 2);

  const rows = await db.query<Record<string, unknown>>(
    `SELECT id FROM ${qualifiedTableName(PROJECT, DATASET, TABLE)} WHERE id IN (100, 101) ORDER BY id`,
  );
  assert.equal(rows.length, 2);
});

test('AppendRows without a writer schema on the very first request → INVALID_ARGUMENT', async () => {
  const { error } = await callAppendRows([
    {
      writeStream: DEFAULT_STREAM,
      protoRows: {
        rows: { serializedRows: [encodeRow({ id: 9, name: 'no-schema', active: false })] },
      },
    },
  ]);
  assert.ok(error !== null);
  assert.equal(error.code, grpc.status.INVALID_ARGUMENT);
  assert.match(error.details, /writer_schema/);
});

test('AppendRows on an unknown application stream → NOT_FOUND', async () => {
  const { error } = await callAppendRows([
    {
      writeStream: `projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}/streams/unknown-uuid`,
      protoRows: {
        writerSchema: { protoDescriptor: writerDescriptor },
        rows: { serializedRows: [encodeRow({ id: 1, name: 'x', active: true })] },
      },
    },
  ]);
  assert.ok(error !== null);
  assert.equal(error.code, grpc.status.NOT_FOUND);
});

test('AppendRows on a non-existent table → NOT_FOUND', async () => {
  const { error } = await callAppendRows([
    {
      writeStream: `projects/${PROJECT}/datasets/${DATASET}/tables/ghost/streams/_default`,
      protoRows: {
        writerSchema: { protoDescriptor: writerDescriptor },
        rows: { serializedRows: [encodeRow({ id: 1, name: 'x', active: true })] },
      },
    },
  ]);
  assert.ok(error !== null);
  assert.equal(error.code, grpc.status.NOT_FOUND);
});

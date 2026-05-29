/**
 * BL-117 acceptance test: CreateReadSession RPC.
 *
 * Boots an HTTP+gRPC server pair backed by a shared in-memory DuckDB,
 * seeds a known table via the meta layer, and uses `@grpc/grpc-js`'s
 * `Client` (a real gRPC client) plus protobufjs-encoded request bytes
 * to call `/google.cloud.bigquery.storage.v1.BigQueryRead/CreateReadSession`.
 *
 * Verifies the response shape end-to-end:
 *   - session name follows the `projects/.../sessions/{uuid}` convention
 *   - estimatedRowCount matches the table metadata
 *   - avroSchema.schema is a parseable Avro JSON schema that matches the
 *     BQ schema, with the right Avro logical types for date/numeric/etc.
 *   - selected_fields filters down the schema
 *   - row_restriction round-trips on read_options
 *   - data_format=ARROW returns UNIMPLEMENTED (BL-119 territory)
 *   - missing tables return NOT_FOUND with a recognizable message
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
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema, upsertDataset, upsertTable } from '../../src/storage/meta.ts';
import descriptor from '../../src/grpc-gen/protos.json' with { type: 'json' };

const root = protobuf.Root.fromJSON(descriptor as protobuf.INamespace);
const CreateReadSessionRequest = root.lookupType(
  'google.cloud.bigquery.storage.v1.CreateReadSessionRequest',
);
const ReadSession = root.lookupType('google.cloud.bigquery.storage.v1.ReadSession');

const PROJECT = 'p-test';
const DATASET = 'ds';
const TABLE = 'orders';
const READ_PATH = '/google.cloud.bigquery.storage.v1.BigQueryRead/CreateReadSession';

let db: Db;
let server: GrpcServer;

const FIELDS = [
  { name: 'order_id', type: 'INT64' as const, mode: 'REQUIRED' as const },
  { name: 'customer', type: 'STRING' as const },
  { name: 'placed_on', type: 'DATE' as const },
  { name: 'amount', type: 'NUMERIC' as const },
  { name: 'tags', type: 'STRING' as const, mode: 'REPEATED' as const },
];

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  await upsertDataset(db, { project: PROJECT, datasetId: DATASET });
  await ensureDatasetSchema(db, PROJECT, DATASET);
  await db.exec(buildCreateTableSql(PROJECT, DATASET, TABLE, FIELDS));
  await upsertTable(db, {
    project: PROJECT,
    datasetId: DATASET,
    tableId: TABLE,
    type: 'TABLE',
    schema: { fields: FIELDS },
  });
  // Real BQ reports the count from the actual table, not from metadata —
  // insert exactly 42 placeholder rows to make `estimatedRowCount = 42`.
  const qualified = qualifiedTableName(PROJECT, DATASET, TABLE);
  const valuesSql = Array.from({ length: 42 }, (_, i) => `(${i + 1}, NULL, NULL, NULL, [])`).join(
    ', ',
  );
  await db.exec(`INSERT INTO ${qualified} VALUES ${valuesSql}`);
  server = createGrpcServer({ db });
  await server.listen(0);
});

after(async () => {
  await server.close();
  await db.close();
});

interface RpcOutcome {
  readonly error: grpc.ServiceError | null;
  readonly response: Record<string, unknown> | null;
}

function callCreateReadSession(requestObj: object): Promise<RpcOutcome> {
  const client = new grpc.Client(server.url, grpc.credentials.createInsecure());
  return new Promise<RpcOutcome>((resolve) => {
    const requestBytes = Buffer.from(
      CreateReadSessionRequest.encode(CreateReadSessionRequest.fromObject(requestObj)).finish(),
    );
    client.makeUnaryRequest(
      READ_PATH,
      (v: Buffer) => v,
      (v: Buffer) => v,
      requestBytes,
      (err, responseBytes) => {
        client.close();
        if (err !== null) {
          resolve({ error: err as grpc.ServiceError, response: null });
          return;
        }
        const msg = ReadSession.decode(responseBytes as Uint8Array);
        resolve({
          error: null,
          response: ReadSession.toObject(msg, {
            defaults: false,
            longs: Number,
            enums: String,
            arrays: true,
            objects: true,
          }) as Record<string, unknown>,
        });
      },
    );
  });
}

test('CreateReadSession returns Avro schema + estimated rows for an existing table', async () => {
  const { error, response } = await callCreateReadSession({
    parent: `projects/${PROJECT}`,
    readSession: {
      table: `projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}`,
      dataFormat: 'AVRO',
    },
  });
  assert.equal(error, null);
  assert.ok(response !== null);

  // name: projects/{p}/locations/.../sessions/{uuid}
  assert.match(
    response['name'] as string,
    new RegExp(`^projects/${PROJECT}/locations/[^/]+/sessions/[0-9a-f-]+$`),
  );
  assert.equal(response['table'], `projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}`);
  assert.equal(response['dataFormat'], 'AVRO');
  assert.equal(response['estimatedRowCount'], 42);

  // expireTime present and in the future
  const exp = response['expireTime'] as { seconds: number };
  assert.ok(typeof exp === 'object' && exp !== null);
  assert.ok(exp.seconds > Math.floor(Date.now() / 1000));

  // At least one ReadStream
  const streams = response['streams'] as Array<{ name: string }>;
  assert.ok(Array.isArray(streams) && streams.length >= 1);
  assert.match(streams[0]?.name ?? '', /\/streams\/\d+$/);

  // avroSchema.schema parses as JSON and has every column
  const avro = response['avroSchema'] as { schema: string };
  assert.ok(typeof avro?.schema === 'string');
  const avroSchema = JSON.parse(avro.schema) as {
    type: string;
    name: string;
    fields: Array<{ name: string; type: unknown }>;
  };
  assert.equal(avroSchema.type, 'record');
  // Real BQ uses the literal `__root__` for the top-level record name.
  assert.equal(avroSchema.name, '__root__');
  const fieldNames = avroSchema.fields.map((f) => f.name);
  assert.deepEqual(fieldNames, ['order_id', 'customer', 'placed_on', 'amount', 'tags']);

  // REQUIRED INT64 → bare "long"
  assert.equal(avroSchema.fields[0]?.type, 'long');
  // NULLABLE STRING → ["null", "string"]
  assert.deepEqual(avroSchema.fields[1]?.type, ['null', 'string']);
  // DATE → ["null", {type: "int", logicalType: "date"}]
  assert.deepEqual(avroSchema.fields[2]?.type, ['null', { type: 'int', logicalType: 'date' }]);
  // NUMERIC → ["null", {type: "bytes", logicalType: "decimal", precision: 38, scale: 9}]
  assert.deepEqual(avroSchema.fields[3]?.type, [
    'null',
    { type: 'bytes', logicalType: 'decimal', precision: 38, scale: 9 },
  ]);
  // REPEATED STRING → {type: "array", items: "string"}
  assert.deepEqual(avroSchema.fields[4]?.type, { type: 'array', items: 'string' });
});

test('CreateReadSession honors selected_fields by filtering the Avro schema', async () => {
  const { error, response } = await callCreateReadSession({
    parent: `projects/${PROJECT}`,
    readSession: {
      table: `projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}`,
      dataFormat: 'AVRO',
      readOptions: { selectedFields: ['order_id', 'amount'] },
    },
  });
  assert.equal(error, null);
  const avro = (response as { avroSchema: { schema: string } }).avroSchema;
  const avroSchema = JSON.parse(avro.schema) as { fields: Array<{ name: string }> };
  assert.deepEqual(
    avroSchema.fields.map((f) => f.name),
    ['order_id', 'amount'],
  );
  // readOptions round-trips
  const opts = (response as { readOptions: { selectedFields: string[] } }).readOptions;
  assert.deepEqual(opts.selectedFields, ['order_id', 'amount']);
});

test('CreateReadSession echoes row_restriction', async () => {
  const { response } = await callCreateReadSession({
    parent: `projects/${PROJECT}`,
    readSession: {
      table: `projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}`,
      dataFormat: 'AVRO',
      readOptions: { rowRestriction: 'amount > 100' },
    },
  });
  const opts = (response as { readOptions: { rowRestriction: string } }).readOptions;
  assert.equal(opts.rowRestriction, 'amount > 100');
});

test('CreateReadSession returns NOT_FOUND for a missing table', async () => {
  const { error } = await callCreateReadSession({
    parent: `projects/${PROJECT}`,
    readSession: {
      table: `projects/${PROJECT}/datasets/${DATASET}/tables/ghost`,
      dataFormat: 'AVRO',
    },
  });
  assert.ok(error !== null);
  assert.equal(error.code, grpc.status.NOT_FOUND);
  assert.match(error.details, /Not found/);
});

test('CreateReadSession rejects malformed table refs with INVALID_ARGUMENT', async () => {
  const { error } = await callCreateReadSession({
    parent: `projects/${PROJECT}`,
    readSession: { table: 'not-a-valid-ref', dataFormat: 'AVRO' },
  });
  assert.ok(error !== null);
  assert.equal(error.code, grpc.status.INVALID_ARGUMENT);
  assert.match(error.details, /projects\/.+\/datasets/);
});

test('CreateReadSession with an unknown data_format returns INVALID_ARGUMENT', async () => {
  // protobufjs accepts numeric enum values it doesn't recognize, lets the bytes
  // round-trip, and surfaces them as numbers on toObject — the handler then
  // rejects anything that isn't AVRO (1) or ARROW (2).
  const { error } = await callCreateReadSession({
    parent: `projects/${PROJECT}`,
    readSession: {
      table: `projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}`,
      dataFormat: 99,
    },
  });
  assert.ok(error !== null);
  assert.equal(error.code, grpc.status.INVALID_ARGUMENT);
  assert.match(error.details, /data_format must be AVRO or ARROW/);
});

test('CreateReadSession accepts tableModifiers.snapshotTime as a stub (BL-121)', async () => {
  // We don't keep versioned storage (BL-106 deferred), but the parameter
  // must round-trip on the response so clients can detect that we honored
  // their request and that subsequent reads are repeatable. Use a snapshot
  // time slightly in the past — within a single test run the data doesn't
  // change underneath us, so "snapshot" semantics are trivially satisfied.
  const seconds = Math.floor(Date.now() / 1000) - 10;
  const { error, response } = await callCreateReadSession({
    parent: `projects/${PROJECT}`,
    readSession: {
      table: `projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}`,
      dataFormat: 'AVRO',
      tableModifiers: { snapshotTime: { seconds, nanos: 0 } },
    },
  });
  assert.equal(error, null);
  assert.ok(response !== null);
  const mods = response['tableModifiers'] as { snapshotTime: { seconds: number; nanos: number } };
  assert.equal(Number(mods?.snapshotTime?.seconds), seconds);
});

test('CreateReadSession with data_format=ARROW returns an Arrow IPC schema', async () => {
  const { error, response } = await callCreateReadSession({
    parent: `projects/${PROJECT}`,
    readSession: {
      table: `projects/${PROJECT}/datasets/${DATASET}/tables/${TABLE}`,
      dataFormat: 'ARROW',
    },
  });
  assert.equal(error, null);
  assert.ok(response !== null);
  assert.equal(response['dataFormat'], 'ARROW');
  const arrow = response['arrowSchema'] as { serializedSchema: Buffer | Uint8Array };
  assert.ok(
    arrow?.serializedSchema instanceof Uint8Array || Buffer.isBuffer(arrow?.serializedSchema),
  );
  const bytes = arrow.serializedSchema as Uint8Array;
  // IPC schema message starts with the continuation marker 0xFFFFFFFF.
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xff);
  assert.equal(bytes[2], 0xff);
  assert.equal(bytes[3], 0xff);
  // avroSchema must not also be set when ARROW is requested.
  assert.equal(response['avroSchema'], undefined);
});

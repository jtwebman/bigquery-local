/**
 * Storage Write API conformance suite.
 *
 * Each fixture under `bq-write-fixtures/NNN-name.fixture.json` is a
 * sequence of typed operations against a fresh `projects/.../tables/T`.
 * The capture script runs the same sequence against real BigQuery
 * (`scripts/bq-write-replay-capture.mts`) and stores the canonicalized
 * responses in `NNN-name.captured.json`.
 *
 * The harness here replays the sequence against the local emulator
 * and diffs each response. Missing captures skip cleanly so CI stays
 * green; refresh via `npm run bq-write-replay:capture`.
 */

import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
import {
  type CapturedOp,
  type WriteFixtureCapture,
  type WriteFixtureInput,
  type WriteOpRequest,
  maskStreamName,
  sortRows,
} from './bq-write-canonicalize.ts';

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
const FlushRowsRequest = protoRoot.lookupType('google.cloud.bigquery.storage.v1.FlushRowsRequest');
const FlushRowsResponse = protoRoot.lookupType(
  'google.cloud.bigquery.storage.v1.FlushRowsResponse',
);

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bq-write-fixtures');
const APPEND_PATH = '/google.cloud.bigquery.storage.v1.BigQueryWrite/AppendRows';
const CREATE_PATH = '/google.cloud.bigquery.storage.v1.BigQueryWrite/CreateWriteStream';
const FINALIZE_PATH = '/google.cloud.bigquery.storage.v1.BigQueryWrite/FinalizeWriteStream';
const COMMIT_PATH = '/google.cloud.bigquery.storage.v1.BigQueryWrite/BatchCommitWriteStreams';
const FLUSH_PATH = '/google.cloud.bigquery.storage.v1.BigQueryWrite/FlushRows';

const PROJECT = 'bq-write-replay';
const DATASET = 'bq_write_replay';
const TABLE_PREFIX = 't_';

interface Fixture {
  readonly name: string;
  readonly input: WriteFixtureInput;
  readonly captured: WriteFixtureCapture | undefined;
}

async function loadFixtures(): Promise<readonly Fixture[]> {
  let entries: string[];
  try {
    entries = await readdir(FIXTURES_DIR);
  } catch {
    return [];
  }
  const out: Fixture[] = [];
  for (const e of entries) {
    if (!e.endsWith('.fixture.json')) continue;
    const name = e.slice(0, -'.fixture.json'.length);
    const input = JSON.parse(
      await readFile(path.join(FIXTURES_DIR, e), 'utf8'),
    ) as WriteFixtureInput;
    let captured: WriteFixtureCapture | undefined;
    try {
      const raw = await readFile(path.join(FIXTURES_DIR, `${name}.captured.json`), 'utf8');
      captured = JSON.parse(raw) as WriteFixtureCapture;
    } catch {
      captured = undefined;
    }
    out.push({ name, input, captured });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Per-fixture replay against a live emulator
// ---------------------------------------------------------------------------

/** Build a protobufjs Type matching the BQ schema for AppendRows. */
function rowTypeFor(fields: readonly BqField[]): protobuf.Type {
  const protoFields: Record<string, { type: string; id: number; rule?: 'repeated' }> = {};
  fields.forEach((f, i) => {
    const protoType = bqTypeToProtoTypeName(f);
    const entry: { type: string; id: number; rule?: 'repeated' } = { type: protoType, id: i + 1 };
    if (f.mode === 'REPEATED') entry.rule = 'repeated';
    protoFields[f.name] = entry;
  });
  return protobuf.Root.fromJSON({ nested: { Row: { fields: protoFields } } }).lookupType('Row');
}

function bqTypeToProtoTypeName(field: BqField): string {
  switch (field.type) {
    case 'INT64':
      return 'int64';
    case 'FLOAT64':
      return 'double';
    case 'BOOL':
      return 'bool';
    case 'STRING':
    case 'JSON':
    case 'GEOGRAPHY':
    case 'INTERVAL':
      return 'string';
    case 'BYTES':
      return 'bytes';
    case 'DATE':
      return 'int32';
    case 'TIME':
    case 'TIMESTAMP':
    case 'DATETIME':
      return 'int64';
    case 'NUMERIC':
    case 'BIGNUMERIC':
      return 'string';
    case 'RANGE':
      return 'string';
    case 'STRUCT':
      return 'string'; // structs aren't needed for current write fixtures
  }
}

function buildDescriptor(fields: readonly BqField[]): {
  name: string;
  field: Array<{ name: string; number: number; type: number; label: number }>;
} {
  return {
    name: 'Row',
    field: fields.map((f, i) => ({
      name: f.name,
      number: i + 1,
      type: bqTypeToFieldDescriptorType(f),
      label: f.mode === 'REPEATED' ? 3 : 1,
    })),
  };
}

function bqTypeToFieldDescriptorType(field: BqField): number {
  switch (field.type) {
    case 'INT64':
    case 'TIME':
    case 'TIMESTAMP':
    case 'DATETIME':
      return 3; // TYPE_INT64
    case 'FLOAT64':
      return 1; // TYPE_DOUBLE
    case 'BOOL':
      return 8; // TYPE_BOOL
    case 'STRING':
    case 'JSON':
    case 'GEOGRAPHY':
    case 'INTERVAL':
    case 'NUMERIC':
    case 'BIGNUMERIC':
    case 'RANGE':
    case 'STRUCT':
      return 9; // TYPE_STRING
    case 'BYTES':
      return 12; // TYPE_BYTES
    case 'DATE':
      return 5; // TYPE_INT32
  }
}

interface FixtureRunner {
  run(): Promise<CapturedOp[]>;
  close(): Promise<void>;
}

function createFixtureRunner(
  db: Db,
  server: GrpcServer,
  fixture: WriteFixtureInput,
  tableId: string,
): FixtureRunner {
  const rowType = rowTypeFor(fixture.schema);
  const descriptorObj = buildDescriptor(fixture.schema);
  const parent = `projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`;
  const streamAliases: Record<string, string> = {
    _default: `${parent}/streams/_default`,
  };
  // Lazy bidi connections keyed by `(streamNames as one set)`. For
  // simplicity each appendRows op opens its own bidi call, except
  // when a later op on the same stream needs to be on the same call
  // (BL-126 schema-update). We keep things simple: one bidi call per
  // group of consecutive appendRows ops + alterTable in between is
  // tolerated. For now: always one bidi per appendRows.

  const client = new grpc.Client(server.url, grpc.credentials.createInsecure());

  function unaryCall<RequestT extends object, ResponseT>(
    requestPath: string,
    reqType: protobuf.Type,
    resType: protobuf.Type,
    request: RequestT,
  ): Promise<{ error: grpc.ServiceError | null; response: ResponseT | null }> {
    const reqBytes = Buffer.from(reqType.encode(reqType.fromObject(request)).finish());
    return new Promise((resolve) => {
      client.makeUnaryRequest(
        requestPath,
        (v: Buffer) => v,
        (v: Buffer) => v,
        reqBytes,
        (err, response) => {
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

  async function doAppendRows(
    spec: Extract<WriteOpRequest, { op: 'appendRows' }>,
  ): Promise<CapturedOp> {
    const streamName = streamAliases[spec.stream] ?? spec.stream;
    const includeSchema = spec.includeSchema !== false;
    const req: Record<string, unknown> = {
      writeStream: streamName,
      protoRows: {
        ...(includeSchema && { writerSchema: { protoDescriptor: descriptorObj } }),
        rows: {
          serializedRows: spec.rows.map((r) => rowType.encode(rowType.fromObject(r)).finish()),
        },
      },
    };
    if (spec.offset !== undefined) {
      req['offset'] = { value: String(spec.offset) };
    }
    const reqBytes = Buffer.from(
      AppendRowsRequest.encode(AppendRowsRequest.fromObject(req)).finish(),
    );
    return new Promise<CapturedOp>((resolve) => {
      const call = client.makeBidiStreamRequest(
        APPEND_PATH,
        (v: Buffer) => v,
        (v: Buffer) => v,
      );
      let response: Record<string, unknown> | null = null;
      call.on('data', (bytes: Buffer) => {
        response = AppendRowsResponse.toObject(AppendRowsResponse.decode(bytes as Uint8Array), {
          defaults: false,
          longs: String,
          enums: String,
          arrays: true,
          objects: true,
          bytes: Buffer,
        }) as Record<string, unknown>;
      });
      call.on('error', (err: grpc.ServiceError) => {
        resolve({
          op: 'appendRows',
          errorCode: err.code ?? grpc.status.UNKNOWN,
          appendResultOffset: null,
          hasWriteStream: false,
        });
      });
      call.on('end', () => {
        if (response === null) {
          resolve({
            op: 'appendRows',
            errorCode: null,
            appendResultOffset: null,
            hasWriteStream: false,
          });
          return;
        }
        const resp = response;
        resolve({
          op: 'appendRows',
          errorCode: null,
          appendResultOffset:
            (resp['appendResult'] as { offset?: { value?: string } })?.offset?.value ?? null,
          hasWriteStream:
            typeof resp['writeStream'] === 'string' && (resp['writeStream'] as string) !== '',
        });
      });
      call.write(reqBytes);
      call.end();
    });
  }

  async function execOne(spec: WriteOpRequest): Promise<CapturedOp> {
    switch (spec.op) {
      case 'createWriteStream': {
        const { error, response } = await unaryCall<
          Record<string, unknown>,
          { name?: string; type?: string; createTime?: object }
        >(CREATE_PATH, CreateWriteStreamRequest, WriteStream, {
          parent,
          writeStream: { type: spec.type },
        });
        if (error !== null || response === null) {
          throw error ?? new Error('createWriteStream returned no response');
        }
        const aliasKey = `$${Object.keys(streamAliases).filter((k) => k.startsWith('$')).length}`;
        streamAliases[aliasKey] = response.name ?? '';
        return {
          op: 'createWriteStream',
          type: response.type ?? '',
          hasCreateTime: response.createTime !== undefined,
          maskedName: maskStreamName(response.name ?? ''),
        };
      }
      case 'appendRows':
        return doAppendRows(spec);
      case 'finalizeWriteStream': {
        const streamName = streamAliases[spec.stream] ?? spec.stream;
        const { error, response } = await unaryCall<{ name: string }, { rowCount?: string }>(
          FINALIZE_PATH,
          FinalizeWriteStreamRequest,
          FinalizeWriteStreamResponse,
          {
            name: streamName,
          },
        );
        if (error !== null) throw error;
        return { op: 'finalizeWriteStream', rowCount: response?.rowCount ?? '0' };
      }
      case 'batchCommitWriteStreams': {
        const streamList = spec.streams.map((s) => streamAliases[s] ?? s);
        const { error, response } = await unaryCall<
          { parent: string; writeStreams: string[] },
          { commitTime?: object; streamErrors?: unknown[] }
        >(COMMIT_PATH, BatchCommitWriteStreamsRequest, BatchCommitWriteStreamsResponse, {
          parent,
          writeStreams: streamList,
        });
        if (error !== null) throw error;
        return {
          op: 'batchCommitWriteStreams',
          hasCommitTime: response?.commitTime !== undefined,
          streamErrorCount: response?.streamErrors?.length ?? 0,
        };
      }
      case 'flushRows': {
        const streamName = streamAliases[spec.stream] ?? spec.stream;
        const requestObj: Record<string, unknown> = { writeStream: streamName };
        if (spec.offset !== undefined) {
          requestObj['offset'] = { value: String(spec.offset) };
        }
        const { error, response } = await unaryCall<Record<string, unknown>, { offset?: string }>(
          FLUSH_PATH,
          FlushRowsRequest,
          FlushRowsResponse,
          requestObj,
        );
        if (error !== null) throw error;
        return { op: 'flushRows', offset: response?.offset ?? '0' };
      }
      case 'alterTable': {
        const sql = spec.localSql ?? spec.sql;
        const concrete = sql.replace(/\$TABLE/g, qualifiedTableName(PROJECT, DATASET, tableId));
        await db.exec(concrete);
        // Refresh meta with the new schema discovered by DuckDB.
        const cols = await db.query<{ column_name: string; data_type: string }>(
          `SELECT column_name, data_type FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2
           ORDER BY ordinal_position`,
          [
            // datasetSchemaName replicates the routes/tables.ts mangling
            // (project__dataset). For a known dataset use the qualified form.
            `${PROJECT}__${DATASET}`,
            tableId,
          ],
        );
        // Build BQ field list from DuckDB columns — mostly a placeholder; the
        // capture script writes the canonical BQ schema, so for `selectTable`
        // we rely on the original fixture schema.
        const refreshedFields: BqField[] = cols.map((c) => ({
          name: c.column_name,
          type: duckTypeToBqRough(c.data_type),
        }));
        await upsertTable(db, {
          project: PROJECT,
          datasetId: DATASET,
          tableId,
          type: 'TABLE',
          schema: { fields: refreshedFields },
        });
        return { op: 'alterTable' };
      }
      case 'selectTable': {
        const sql = (spec.localSql ?? spec.sql).replace(
          /\$TABLE/g,
          qualifiedTableName(PROJECT, DATASET, tableId),
        );
        const rows = await db.query<Record<string, unknown>>(sql);
        return { op: 'selectTable', rows: sortRows(rows) };
      }
    }
  }

  return {
    async run() {
      const captured: CapturedOp[] = [];
      for (const op of fixture.operations) {
        captured.push(await execOne(op));
      }
      return captured;
    },
    async close() {
      client.close();
    },
  };
}

function duckTypeToBqRough(duckType: string): BqField['type'] {
  const upper = duckType.toUpperCase();
  if (upper === 'BIGINT' || upper === 'INTEGER') return 'INT64';
  if (upper === 'DOUBLE' || upper === 'FLOAT') return 'FLOAT64';
  if (upper === 'BOOLEAN') return 'BOOL';
  if (upper === 'DATE') return 'DATE';
  if (upper.startsWith('VARCHAR') || upper === 'TEXT') return 'STRING';
  if (upper === 'BLOB' || upper === 'BYTEA') return 'BYTES';
  if (upper.startsWith('TIMESTAMP')) return 'TIMESTAMP';
  if (upper.startsWith('DECIMAL')) return 'NUMERIC';
  return 'STRING';
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const fixtures = await loadFixtures();

let db: Db;
let server: GrpcServer;

describe('bq-write-replay', () => {
  before(async () => {
    db = await createDb();
    await ensureMetaSchema(db);
    await upsertDataset(db, { project: PROJECT, datasetId: DATASET });
    await ensureDatasetSchema(db, PROJECT, DATASET);
    server = createGrpcServer({ db });
    await server.listen(0);
  });

  after(async () => {
    await server.close();
    await db.close();
  });

  for (const fx of fixtures) {
    if (fx.captured === undefined) {
      test(`${fx.name} (skipped — no captured response)`, { skip: true }, () => {});
      continue;
    }
    const captured = fx.captured;
    test(fx.name, async () => {
      const tableId = `${TABLE_PREFIX}${fx.name.replace(/-/g, '_')}`;
      // Materialize a fresh table per fixture so the operation chain
      // starts from a clean state.
      await db.exec(buildCreateTableSql(PROJECT, DATASET, tableId, fx.input.schema));
      await upsertTable(db, {
        project: PROJECT,
        datasetId: DATASET,
        tableId,
        type: 'TABLE',
        schema: { fields: fx.input.schema },
      });
      const runner = createFixtureRunner(db, server, fx.input, tableId);
      try {
        const actual = await runner.run();
        assert.deepEqual(
          actual,
          captured.operations,
          `${fx.name} response sequence diverged from captured BQ`,
        );
      } finally {
        await runner.close();
      }
    });
  }

  if (fixtures.length === 0) {
    test('(no fixtures — add .fixture.json files)', () => {});
  }
});

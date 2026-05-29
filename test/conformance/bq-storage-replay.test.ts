/**
 * Real-BQ Storage Read conformance suite — exercises both `:memory:`
 * and file-backed DuckDB.
 *
 * For each `bq-storage-fixtures/NNN-name.fixture.json`:
 *   1. Spin up the gRPC server, create the dataset+table described by
 *      the fixture, insert rows via plain SQL.
 *   2. Call `CreateReadSession` + `ReadRows` against our server via
 *      a real `@grpc/grpc-js` client.
 *   3. Canonicalize the response.
 *   4. Diff against `NNN-name.captured.json` if present — that file
 *      holds the equivalent capture from real BigQuery's Storage Read.
 *
 * The whole suite runs twice — once with an in-memory DuckDB, once
 * against a file-backed DuckDB that's **closed and reopened** between
 * fixture-setup and the actual reads. The reopen exercises persistence
 * (WAL replay, extension state, table catalog round-trip), which
 * `:memory:` runs can't catch.
 *
 * Fixtures without a captured sibling are reported as "skipped" so
 * CI stays green; the user runs `npm run bq-storage-replay:capture`
 * to refresh / fill in captures (which costs real BQ bytes and needs
 * Application Default Credentials).
 */

import { strict as assert } from 'node:assert';
import { rm } from 'node:fs/promises';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as grpc from '@grpc/grpc-js';
import { RecordBatchReader } from 'apache-arrow';
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
import {
  type CanonicalCapture,
  canonicalizeCreateReadSession,
  canonicalizeReadRowsBatch,
  decodeAndSortRows,
  flattenReadRows,
} from './bq-storage-canonicalize.ts';

const root = protobuf.Root.fromJSON(descriptor as protobuf.INamespace);
const CreateReadSessionRequest = root.lookupType(
  'google.cloud.bigquery.storage.v1.CreateReadSessionRequest',
);
const ReadSession = root.lookupType('google.cloud.bigquery.storage.v1.ReadSession');
const ReadRowsRequest = root.lookupType('google.cloud.bigquery.storage.v1.ReadRowsRequest');
const ReadRowsResponse = root.lookupType('google.cloud.bigquery.storage.v1.ReadRowsResponse');

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bq-storage-fixtures');
const CREATE_PATH = '/google.cloud.bigquery.storage.v1.BigQueryRead/CreateReadSession';
const READ_PATH = '/google.cloud.bigquery.storage.v1.BigQueryRead/ReadRows';

interface FixtureInput {
  readonly description?: string;
  readonly schema: readonly BqField[];
  /** SQL run against real BigQuery during capture. */
  readonly insertSql: string;
  /**
   * Optional override run against the local DuckDB-backed emulator
   * when BQ-canonical syntax (`NUMERIC '...'`, `b'...'` BYTES literals,
   * `TIMESTAMPTZ '...'`, …) doesn't parse in DuckDB or hits a smaller
   * default precision. Falls back to `insertSql` when absent.
   */
  readonly localInsertSql?: string;
  readonly createReadSession: {
    readonly dataFormat?: 'AVRO' | 'ARROW';
    readonly selectedFields?: readonly string[];
    readonly rowRestriction?: string;
    readonly maxStreamCount?: number;
  };
}

interface Fixture {
  readonly name: string;
  readonly input: FixtureInput;
  readonly captured: CanonicalCapture | undefined;
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
    const input = JSON.parse(await readFile(path.join(FIXTURES_DIR, e), 'utf8')) as FixtureInput;
    let captured: CanonicalCapture | undefined;
    try {
      const raw = await readFile(path.join(FIXTURES_DIR, `${name}.captured.json`), 'utf8');
      captured = JSON.parse(raw) as CanonicalCapture;
    } catch {
      captured = undefined;
    }
    out.push({ name, input, captured });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// These match `scripts/bq-storage-replay-capture.mts` exactly so the
// fixture's `table` field round-trips identically (modulo project mask).
const PROJECT = 'bq-storage-replay';
const DATASET = 'bq_storage_replay';
const TABLE_PREFIX = 't_';

// Shared state across the two parameterized suites — assigned by each
// suite's `before` hook. Tests reference these through closures.
let db: Db;
let server: GrpcServer;

async function setupFixtureTable(name: string, fixture: FixtureInput): Promise<string> {
  // Same id the capture script picks: `t_<name with dashes→underscores>`.
  const tableId = `${TABLE_PREFIX}${name.replace(/-/g, '_')}`;
  await db.exec(buildCreateTableSql(PROJECT, DATASET, tableId, fixture.schema));
  await upsertTable(db, {
    project: PROJECT,
    datasetId: DATASET,
    tableId,
    type: 'TABLE',
    schema: { fields: fixture.schema },
  });
  // Insert via plain SQL so fixtures can use type-specific syntax
  // (DATE 'yyyy-mm-dd', TIMESTAMPTZ '...', etc). `localInsertSql` lets
  // a fixture provide a DuckDB-compatible variant when BQ's syntax
  // doesn't parse here.
  const sql = fixture.localInsertSql ?? fixture.insertSql;
  await db.exec(sql.replace(/\$TABLE/g, qualifiedTableName(PROJECT, DATASET, tableId)));
  return tableId;
}

async function callCreateReadSession(
  tableRef: string,
  options: FixtureInput['createReadSession'],
): Promise<Record<string, unknown>> {
  const requestBytes = Buffer.from(
    CreateReadSessionRequest.encode(
      CreateReadSessionRequest.fromObject({
        parent: `projects/${PROJECT}`,
        readSession: {
          table: tableRef,
          dataFormat: options.dataFormat ?? 'AVRO',
          readOptions: {
            ...(options.selectedFields ? { selectedFields: [...options.selectedFields] } : {}),
            ...(options.rowRestriction ? { rowRestriction: options.rowRestriction } : {}),
          },
        },
        ...(options.maxStreamCount !== undefined && { maxStreamCount: options.maxStreamCount }),
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
            longs: String,
            enums: String,
            arrays: true,
            objects: true,
            bytes: String,
          }) as Record<string, unknown>,
        );
      },
    );
  });
}

async function callReadRowsAll(
  streamNames: readonly string[],
): Promise<Array<Record<string, unknown>>> {
  const messages: Array<Record<string, unknown>> = [];
  for (const streamName of streamNames) {
    const requestBytes = Buffer.from(
      ReadRowsRequest.encode(ReadRowsRequest.fromObject({ readStream: streamName })).finish(),
    );
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
        messages.push(
          ReadRowsResponse.toObject(msg, {
            defaults: false,
            longs: String,
            enums: String,
            arrays: true,
            objects: true,
            bytes: String,
          }) as Record<string, unknown>,
        );
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
  }
  return messages;
}

const fixtures = await loadFixtures();

type Mode = 'memory' | 'file';

/**
 * Create a Db for the requested storage mode. File mode goes through
 * a close→reopen cycle after fixture tables are materialized so the
 * tests exercise persistence (WAL replay + catalog round-trip), not
 * just same-process file I/O.
 */
async function setupModeDb(mode: Mode): Promise<{ db: Db; cleanup: () => Promise<void> }> {
  if (mode === 'memory') {
    const memDb = await createDb();
    return { db: memDb, cleanup: async () => {} };
  }
  const filePath = path.join(tmpdir(), `bq-storage-replay-${process.pid}-${Date.now()}.duckdb`);
  let fileDb = await createDb({ path: filePath });
  await ensureMetaSchema(fileDb);
  await upsertDataset(fileDb, { project: PROJECT, datasetId: DATASET });
  await ensureDatasetSchema(fileDb, PROJECT, DATASET);
  // Materialize every fixture's table + rows BEFORE the close→reopen,
  // so the reopen actually has to recover persisted state.
  for (const fx of fixtures) {
    db = fileDb;
    await setupFixtureTable(fx.name, fx.input);
  }
  await fileDb.close();
  fileDb = await createDb({ path: filePath });
  return {
    db: fileDb,
    cleanup: async () => {
      await rm(filePath, { force: true });
      await rm(`${filePath}.wal`, { force: true });
    },
  };
}

function runReplaySuite(mode: Mode): void {
  describe(`bq-storage-replay (${mode})`, () => {
    let cleanupDb: () => Promise<void>;

    before(async () => {
      const opened = await setupModeDb(mode);
      db = opened.db;
      cleanupDb = opened.cleanup;
      if (mode === 'memory') {
        await ensureMetaSchema(db);
        await upsertDataset(db, { project: PROJECT, datasetId: DATASET });
        await ensureDatasetSchema(db, PROJECT, DATASET);
      }
      server = createGrpcServer({ db });
      await server.listen(0);
    });

    after(async () => {
      await server.close();
      await db.close();
      await cleanupDb();
    });

    for (const fx of fixtures) {
      if (fx.captured === undefined) {
        test(`${fx.name} (skipped — no captured response)`, { skip: true }, () => {});
        continue;
      }
      const captured = fx.captured;
      test(fx.name, async () => {
        const tableId =
          mode === 'memory'
            ? await setupFixtureTable(fx.name, fx.input)
            : `${TABLE_PREFIX}${fx.name.replace(/-/g, '_')}`;
        const tableRef = `projects/${PROJECT}/datasets/${DATASET}/tables/${tableId}`;
        const sessionResponse = await callCreateReadSession(tableRef, fx.input.createReadSession);
        const actualSession = canonicalizeCreateReadSession(
          sessionResponse as Parameters<typeof canonicalizeCreateReadSession>[0],
        );
        assert.deepEqual(
          actualSession,
          captured.createReadSession,
          'createReadSession diverged from captured BQ response',
        );

        const streams = (sessionResponse['streams'] as Array<{ name: string }>) ?? [];
        const responses = await callReadRowsAll(streams.map((s) => s.name));
        const actualBatches = responses.map((m) =>
          canonicalizeReadRowsBatch(m as Parameters<typeof canonicalizeReadRowsBatch>[0]),
        );

        const actualFlat = flattenReadRows(actualBatches);
        const expectedFlat = flattenReadRows(captured.readRows);

        // Both engines are free to return rows in different storage orders.
        // Decode + sort each side using the (agreed-on) schema, then compare
        // structurally. Both Avro and Arrow encodings are value-deterministic,
        // so identical decoded values re-encode to identical bytes.
        if (captured.createReadSession.dataFormat === 'AVRO') {
          const avroType = avsc.Type.forSchema(JSON.parse(captured.createReadSession.avroSchema));
          const decoder = { decode: avroType.decode.bind(avroType) };
          const actualRows = decodeAndSortRows(decoder, actualFlat.serializedBinaryRowsBase64);
          const expectedRows = decodeAndSortRows(decoder, expectedFlat.serializedBinaryRowsBase64);
          assert.deepEqual(actualRows, expectedRows, 'decoded row values diverged from BQ capture');
        } else {
          // ARROW: decode each side with its own schema (the captured BQ schema for
          // the captured batches; our own session schema for our own batches) —
          // Arrow IPC encoding isn't byte-deterministic across implementations but
          // value-equivalent schemas decode to value-equivalent rows.
          const actualSchemaB64 = (sessionResponse['arrowSchema'] as { serializedSchema: string })
            .serializedSchema;
          const actualSchema = Buffer.from(actualSchemaB64, 'base64');
          const expectedSchema = Buffer.from(captured._arrowSchemaBase64 ?? '', 'base64');
          const actualRows = decodeArrowRows(
            actualSchema,
            actualFlat.serializedRecordBatchesBase64,
          );
          const expectedRows = decodeArrowRows(
            expectedSchema,
            expectedFlat.serializedRecordBatchesBase64,
          );
          assert.deepEqual(actualRows, expectedRows, 'decoded Arrow rows diverged from BQ capture');
        }
        // First message in BQ's stream always carries the schema; ours should too.
        assert.equal(
          actualFlat.schemaInFirst,
          expectedFlat.schemaInFirst,
          'schema attachment on first batch diverged',
        );
      });
    }
  });
}

runReplaySuite('memory');
runReplaySuite('file');

function decodeArrowRows(schemaBytes: Buffer, batchesBase64: string): readonly unknown[] {
  const batchBytes = Buffer.from(batchesBase64, 'base64');
  if (batchBytes.length === 0) return [];
  const eos = Buffer.from([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);
  const stream = Buffer.concat([schemaBytes, batchBytes, eos]);
  const reader = RecordBatchReader.from(stream);
  const out: unknown[] = [];
  for (const batch of reader) {
    for (let i = 0; i < batch.numRows; i++) {
      out.push(normalizeArrowValue(batch.get(i)?.toJSON() ?? null));
    }
  }
  out.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return out;
}

function normalizeArrowValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return { __bytes: v.toString('base64') };
  if (v instanceof Uint8Array) return { __bytes: Buffer.from(v).toString('base64') };
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return String(v);
  if (Array.isArray(v)) return v.map(normalizeArrowValue);
  if (typeof v === 'object') {
    // apache-arrow vectors are iterable; flatten any Vector-like.
    if (typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
      try {
        return [...(v as Iterable<unknown>)].map(normalizeArrowValue);
      } catch {
        // fall through
      }
    }
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = normalizeArrowValue(obj[k]);
    }
    return out;
  }
  return v;
}

if (fixtures.length === 0) {
  test('bq-storage-replay: (no fixtures — add .fixture.json files)', () => {});
}

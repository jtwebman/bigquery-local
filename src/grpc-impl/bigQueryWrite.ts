/**
 * BigQueryWrite gRPC service handlers (Phase 19).
 *
 * BL-122 — `_default` stream: each AppendRows batch INSERTs straight
 *   into the destination table (at-least-once).
 *
 * BL-123 — Explicit application streams. `CreateWriteStream` mints a
 *   stream with one of three types:
 *     - COMMITTED  → like default but with offset tracking; data
 *                    visible immediately.
 *     - BUFFERED   → rows go to an in-memory buffer; `FlushRows`
 *                    promotes them (BL-124).
 *     - PENDING    → rows buffer; `BatchCommitWriteStreams` flushes the
 *                    whole buffer to the table after the stream is
 *                    `FinalizeWriteStream`'d. This is the "atomic
 *                    multi-batch commit" lifecycle real BQ users lean
 *                    on for transactional ingestion.
 *
 * `FlushRows` stays unregistered → grpc-js UNIMPLEMENTED until BL-124.
 * `GetWriteStream` similarly defers — clients rarely need it.
 */

import { randomUUID } from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import type protobuf from 'protobufjs';

import { qualifiedTableName } from '../routes/tables.ts';
import type { Db } from '../storage/db.ts';
import { getTable } from '../storage/meta.ts';
import { type BqField, bqInsertExpression, bqValueToDuck } from '../storage/types.ts';
import { compileWriterSchema, protoRowToValues } from './protoRows.ts';
import {
  AppendRowsRequest,
  AppendRowsResponse,
  BatchCommitWriteStreamsRequest,
  BatchCommitWriteStreamsResponse,
  CreateWriteStreamRequest,
  FinalizeWriteStreamRequest,
  FinalizeWriteStreamResponse,
  FlushRowsRequest,
  FlushRowsResponse,
  WRITE_PATH,
  WriteStream,
} from './protos.ts';
import {
  type WriteStreamRuntime,
  type WriteStreamStore,
  type WriteStreamType,
  createWriteStreamStore,
  parseStreamName,
} from './writeStreamStore.ts';

const DEFAULT_STREAM_SUFFIX = '/streams/_default';
const PARENT_TABLE_RE = /^projects\/([^/]+)\/datasets\/([^/]+)\/tables\/([^/]+)$/;

interface AppendRowsInput {
  writeStream?: string;
  offset?: { value?: number | string };
  protoRows?: {
    writerSchema?: { protoDescriptor?: unknown };
    rows?: { serializedRows?: Array<Uint8Array | Buffer | string> };
  };
  arrowRows?: { writerSchema?: unknown; rows?: { serializedRecordBatch?: Uint8Array | Buffer } };
  traceId?: string;
}

interface CreateWriteStreamInput {
  parent?: string;
  writeStream?: { type?: string | number };
}

interface FinalizeWriteStreamInput {
  name?: string;
}

interface BatchCommitWriteStreamsInput {
  parent?: string;
  writeStreams?: readonly string[];
}

interface FlushRowsInput {
  writeStream?: string;
  offset?: { value?: number | string };
}

// ---------------------------------------------------------------------------
// ser/de helpers
// ---------------------------------------------------------------------------

function serializeMessage(type: protobuf.Type, value: object): Buffer {
  return Buffer.from(type.encode(type.fromObject(value)).finish());
}

function deserializeMessage<T>(type: protobuf.Type, bytes: Buffer): T {
  const decoded = type.decode(bytes);
  return type.toObject(decoded, {
    defaults: false,
    arrays: true,
    objects: true,
    longs: String,
    enums: String,
    bytes: Buffer,
  }) as T;
}

function bqError(code: grpc.status, details: string): grpc.ServiceError {
  return Object.assign(new Error(details), {
    code,
    details,
    metadata: new grpc.Metadata(),
  });
}

function normalizeStreamType(raw: unknown): WriteStreamType {
  if (raw === 'COMMITTED' || raw === 1) return 'COMMITTED';
  if (raw === 'PENDING' || raw === 2) return 'PENDING';
  if (raw === 'BUFFERED' || raw === 3) return 'BUFFERED';
  // TYPE_UNSPECIFIED (0/undefined) → real BQ rejects; mirror that.
  throw bqError(
    grpc.status.INVALID_ARGUMENT,
    `write_stream.type is required (COMMITTED | PENDING | BUFFERED)`,
  );
}

// ---------------------------------------------------------------------------
// CreateWriteStream
// ---------------------------------------------------------------------------

function createWriteStreamHandler(
  db: Db,
  streams: WriteStreamStore,
): grpc.handleUnaryCall<CreateWriteStreamInput, object> {
  return (call, callback): void => {
    void (async (): Promise<void> => {
      try {
        const parent = call.request.parent ?? '';
        const match = PARENT_TABLE_RE.exec(parent);
        if (match === null) {
          callback(
            bqError(
              grpc.status.INVALID_ARGUMENT,
              `parent must be projects/.../datasets/.../tables/...; got "${parent}"`,
            ),
            null,
          );
          return;
        }
        const [, project, datasetId, tableId] = match as unknown as [
          string,
          string,
          string,
          string,
        ];

        const type = normalizeStreamType(call.request.writeStream?.type);

        const meta = await getTable(db, project, datasetId, tableId);
        if (meta === null) {
          callback(
            bqError(grpc.status.NOT_FOUND, `Not found: Table ${project}:${datasetId}.${tableId}`),
            null,
          );
          return;
        }
        const fields = (meta.schema as { fields?: readonly BqField[] } | undefined)?.fields ?? [];

        const streamId = randomUUID();
        const name = `${parent}/streams/${streamId}`;
        const createMs = Date.now();
        streams.create({ name, project, datasetId, tableId, fields, type, createMs });

        callback(null, {
          name,
          type,
          createTime: {
            seconds: Math.floor(createMs / 1000),
            nanos: (createMs % 1000) * 1_000_000,
          },
          location: 'us',
        });
      } catch (err) {
        callback(err as grpc.ServiceError, null);
      }
    })();
  };
}

// ---------------------------------------------------------------------------
// AppendRows — supports `_default` AND explicit streams (BL-122 + BL-123)
// ---------------------------------------------------------------------------

interface AppendContext {
  readonly kind: 'default' | 'explicit';
  /** Live table metadata at context-build time. Fields mutate as
   *  ALTER TABLE landings happen (BL-126), so AppendRows re-syncs
   *  on each request via the etag below. */
  project: string;
  datasetId: string;
  tableId: string;
  fields: readonly BqField[];
  /** Table etag we last saw when refreshing schema. When the meta
   *  layer reports a different etag, we re-fetch + emit
   *  `updated_schema` on the next AppendRows response (BL-126). */
  tableEtag: string;
  readonly name: string;
  /** Compiled writer-schema Type, locked when the first proto-rows arrive. */
  protoType: protobuf.Type | null;
  insertSql: string | null;
  /** Present iff `kind === 'explicit'`. */
  runtime?: WriteStreamRuntime;
}

async function buildContext(
  db: Db,
  streams: WriteStreamStore,
  writeStream: string,
): Promise<AppendContext> {
  if (writeStream.endsWith(DEFAULT_STREAM_SUFFIX)) {
    const parent = writeStream.slice(0, -DEFAULT_STREAM_SUFFIX.length);
    const match = PARENT_TABLE_RE.exec(parent);
    if (match === null) {
      throw bqError(
        grpc.status.INVALID_ARGUMENT,
        `write_stream must be projects/.../datasets/.../tables/.../streams/_default or ../streams/{id}; got "${writeStream}"`,
      );
    }
    const [, project, datasetId, tableId] = match as unknown as [string, string, string, string];
    const meta = await getTable(db, project, datasetId, tableId);
    if (meta === null) {
      throw bqError(grpc.status.NOT_FOUND, `Not found: Table ${project}:${datasetId}.${tableId}`);
    }
    const fields = (meta.schema as { fields?: readonly BqField[] } | undefined)?.fields ?? [];
    return {
      kind: 'default',
      project,
      datasetId,
      tableId,
      fields,
      tableEtag: meta.etag,
      name: writeStream,
      protoType: null,
      insertSql: null,
    };
  }

  const parsed = parseStreamName(writeStream);
  if (parsed === null) {
    throw bqError(
      grpc.status.INVALID_ARGUMENT,
      `write_stream must be projects/.../datasets/.../tables/.../streams/{_default|<id>}; got "${writeStream}"`,
    );
  }
  const runtime = streams.get(writeStream);
  if (runtime === undefined) {
    throw bqError(grpc.status.NOT_FOUND, `Write stream "${writeStream}" not found`);
  }
  if (runtime.state !== 'ACTIVE') {
    throw bqError(
      grpc.status.FAILED_PRECONDITION,
      `Write stream "${writeStream}" is ${runtime.state}, not ACTIVE`,
    );
  }
  // Look up etag for schema-change detection.
  const meta = await getTable(db, runtime.project, runtime.datasetId, runtime.tableId);
  const tableEtag = meta?.etag ?? '';
  return {
    kind: 'explicit',
    project: runtime.project,
    datasetId: runtime.datasetId,
    tableId: runtime.tableId,
    fields: runtime.fields,
    tableEtag,
    name: writeStream,
    protoType: null,
    insertSql: null,
    runtime,
  };
}

/**
 * Re-check the destination table's etag. If the schema changed since
 * the context was built (ALTER TABLE … ADD COLUMN, schema refresh
 * via the metadata API, etc.), refresh `fields` + invalidate cached
 * SQL so the next INSERT picks up the new columns. Returns the new
 * field list when an update happened (caller emits `updated_schema`),
 * or `null` when nothing changed.
 */
async function refreshSchemaIfChanged(
  db: Db,
  ctx: AppendContext,
): Promise<readonly BqField[] | null> {
  const meta = await getTable(db, ctx.project, ctx.datasetId, ctx.tableId);
  if (meta === null || meta.etag === ctx.tableEtag) return null;
  const fields = (meta.schema as { fields?: readonly BqField[] } | undefined)?.fields ?? [];
  ctx.fields = fields;
  ctx.tableEtag = meta.etag;
  ctx.insertSql = null; // column list changed; rebuild on next INSERT
  if (ctx.kind === 'explicit' && ctx.runtime !== undefined) {
    // Stream's view of the schema follows the table.
    (ctx.runtime as { fields: readonly BqField[] }).fields = fields;
  }
  return fields;
}

function buildInsertSql(
  ctx: Pick<AppendContext, 'project' | 'datasetId' | 'tableId' | 'fields'>,
): string {
  const cols = ctx.fields.map((f) => `"${f.name.replace(/"/g, '""')}"`);
  const placeholders = ctx.fields.map((f, i) => bqInsertExpression(i + 1, f));
  const table = qualifiedTableName(ctx.project, ctx.datasetId, ctx.tableId);
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
}

function rowToDuckValues(row: Record<string, unknown>, fields: readonly BqField[]): unknown[] {
  const wire = protoRowToValues(row, fields);
  return fields.map((f, i) => bqValueToDuck(wire[i], f));
}

async function appendOneRequest(db: Db, ctx: AppendContext, req: AppendRowsInput): Promise<number> {
  const protoRows = req.protoRows;
  if (protoRows === undefined) {
    if (req.arrowRows !== undefined) {
      throw bqError(
        grpc.status.UNIMPLEMENTED,
        'arrow_rows on AppendRows is not yet implemented; use proto_rows',
      );
    }
    return 0;
  }

  const writerSchema = protoRows.writerSchema;
  if (writerSchema?.protoDescriptor !== undefined) {
    ctx.protoType = compileWriterSchema(
      writerSchema.protoDescriptor as Parameters<typeof compileWriterSchema>[0],
    );
  }
  if (ctx.protoType === null) {
    throw bqError(
      grpc.status.INVALID_ARGUMENT,
      'First AppendRows request must include proto_rows.writer_schema.proto_descriptor',
    );
  }

  const rows = protoRows.rows?.serializedRows ?? [];
  if (rows.length === 0) return 0;

  const protoType = ctx.protoType;
  const decodedRows = rows.map((raw) => {
    const bytes =
      typeof raw === 'string' ? Buffer.from(raw, 'base64') : Buffer.from(raw as Uint8Array);
    const message = protoType.decode(bytes);
    const decoded = protoType.toObject(message, {
      defaults: false,
      arrays: true,
      objects: true,
      longs: String,
      enums: String,
      bytes: Buffer,
    }) as Record<string, unknown>;
    return rowToDuckValues(decoded, ctx.fields);
  });

  if (ctx.kind === 'explicit' && ctx.runtime?.type !== 'COMMITTED') {
    // PENDING / BUFFERED: buffer the rows; visibility happens on
    // FlushRows (BL-124) or BatchCommitWriteStreams (BL-123).
    ctx.runtime!.buffer.push(...decodedRows);
    return rows.length;
  }

  // COMMITTED stream OR `_default` stream → immediate INSERT.
  if (ctx.insertSql === null) {
    ctx.insertSql = buildInsertSql(ctx);
  }
  const stmt = db.prepare(ctx.insertSql);
  for (const params of decodedRows) {
    await stmt.exec(params);
  }
  return rows.length;
}

function appendRowsHandler(
  db: Db,
  streams: WriteStreamStore,
): grpc.handleBidiStreamingCall<AppendRowsInput, object> {
  return (call): void => {
    // BL-127 multiplexing: one bidirectional AppendRows call can target
    // multiple write streams (different `write_stream` per message).
    // Keep a per-stream context map; build lazily on first sight.
    const contexts = new Map<string, AppendContext>();
    let pending: Promise<void> = Promise.resolve();
    let closed = false;

    function fail(err: grpc.ServiceError): void {
      if (closed) return;
      closed = true;
      call.emit('error', err);
    }

    call.on('data', (req: AppendRowsInput) => {
      if (closed) return;
      const writeStream = req.writeStream ?? '';
      pending = pending.then(async () => {
        if (closed) return;
        try {
          if (writeStream === '') {
            throw bqError(
              grpc.status.INVALID_ARGUMENT,
              'AppendRowsRequest.write_stream is required on every message',
            );
          }
          let ctx = contexts.get(writeStream);
          if (ctx === undefined) {
            ctx = await buildContext(db, streams, writeStream);
            contexts.set(writeStream, ctx);
          }

          // BL-126: detect schema changes since the last append on this
          // stream. If the table's etag moved, emit `updated_schema` on
          // this response (real BQ does the same — it's how clients
          // discover an ALTER TABLE on a live write).
          const newFields = await refreshSchemaIfChanged(db, ctx);

          // BL-125 offset semantics: `req.offset` is an Int64Value
          // wrapper (unset → at-least-once, current behavior). For
          // explicit streams we enforce against the stream's running
          // offset.
          const requestedOffset =
            req.offset?.value === undefined || req.offset?.value === null
              ? null
              : Number(req.offset.value);
          const isExplicit = ctx.kind === 'explicit';
          const startOffset = isExplicit
            ? (ctx.runtime as WriteStreamRuntime).offset
            : await currentRowCount(db, ctx);

          // Real BQ's contract for offset mismatches is "acknowledge
          // without writing" — replays AND out-of-order both come back
          // with a success response whose `appendResult` carries no
          // offset, and the row is silently dropped. No top-level gRPC
          // error in either case. (Clients tell replay vs. out-of-order
          // apart by tracking expected offsets locally.)
          if (isExplicit && requestedOffset !== null) {
            const here = (ctx.runtime as WriteStreamRuntime).offset;
            if (requestedOffset !== here) {
              if (!closed) {
                const response: Record<string, unknown> = {
                  appendResult: {},
                  writeStream,
                };
                if (newFields !== null) {
                  response['updatedSchema'] = { fields: newFields };
                }
                call.write(response);
              }
              return;
            }
          }

          const written = await appendOneRequest(db, ctx, req);
          if (isExplicit) {
            const runtime = ctx.runtime as WriteStreamRuntime;
            runtime.offset += written;
            // COMMITTED streams write immediately, so visible offset
            // tracks `offset` exactly. BUFFERED / PENDING leave
            // `flushedOffset` behind until FlushRows / BatchCommit.
            if (runtime.type === 'COMMITTED') {
              runtime.flushedOffset = runtime.offset;
            }
          }
          if (!closed) {
            const response: Record<string, unknown> = {
              appendResult: { offset: { value: String(startOffset) } },
              writeStream,
            };
            if (newFields !== null) {
              response['updatedSchema'] = { fields: newFields };
            }
            call.write(response);
          }
        } catch (err) {
          fail(err as grpc.ServiceError);
        }
      });
    });

    call.on('end', () => {
      void pending.then(() => {
        if (!closed) call.end();
      });
    });

    /* node:coverage ignore next 3 */
    call.on('error', () => {
      closed = true;
    });
  };
}

async function currentRowCount(db: Db, ctx: AppendContext): Promise<number> {
  const rows = await db.query<{ n: bigint }>(
    `SELECT COUNT(*)::BIGINT AS n FROM ${qualifiedTableName(ctx.project, ctx.datasetId, ctx.tableId)}`,
  );
  return Number(rows[0]?.n ?? 0n);
}

// ---------------------------------------------------------------------------
// FinalizeWriteStream — marks an explicit stream FINALIZED.
// ---------------------------------------------------------------------------

function finalizeWriteStreamHandler(
  streams: WriteStreamStore,
): grpc.handleUnaryCall<FinalizeWriteStreamInput, object> {
  return (call, callback): void => {
    const name = call.request.name ?? '';
    const runtime = streams.get(name);
    if (runtime === undefined) {
      callback(bqError(grpc.status.NOT_FOUND, `Write stream "${name}" not found`), null);
      return;
    }
    if (runtime.state === 'COMMITTED') {
      callback(
        bqError(grpc.status.FAILED_PRECONDITION, `Stream "${name}" is already committed`),
        null,
      );
      return;
    }
    runtime.state = 'FINALIZED';
    runtime.finalizedMs = Date.now();
    callback(null, { rowCount: String(runtime.offset) });
  };
}

// ---------------------------------------------------------------------------
// BatchCommitWriteStreams — flushes PENDING-stream buffers atomically
// ---------------------------------------------------------------------------

function batchCommitWriteStreamsHandler(
  db: Db,
  streams: WriteStreamStore,
): grpc.handleUnaryCall<BatchCommitWriteStreamsInput, object> {
  return (call, callback): void => {
    void (async (): Promise<void> => {
      try {
        const names = call.request.writeStreams ?? [];
        const streamErrors: Array<{ entity: string; errorMessage: string }> = [];
        const targets: WriteStreamRuntime[] = [];
        for (const name of names) {
          const runtime = streams.get(name);
          if (runtime === undefined) {
            streamErrors.push({ entity: name, errorMessage: 'Stream not found' });
            continue;
          }
          if (runtime.type !== 'PENDING') {
            streamErrors.push({
              entity: name,
              errorMessage: `Stream is ${runtime.type}, only PENDING streams can be committed`,
            });
            continue;
          }
          if (runtime.state !== 'FINALIZED') {
            streamErrors.push({
              entity: name,
              errorMessage: `Stream must be FINALIZED before commit (current: ${runtime.state})`,
            });
            continue;
          }
          targets.push(runtime);
        }

        // Real BQ commits the listed streams atomically. We approximate
        // with a per-stream transaction — DuckDB doesn't span multiple
        // INSERTs across "tables" with one BEGIN/COMMIT in our binding,
        // but flushing a single buffer in one prepared loop is close
        // enough for the emulator.
        const commitMs = Date.now();
        for (const runtime of targets) {
          if (runtime.buffer.length > 0) {
            const sql = buildInsertSql(runtime);
            const stmt = db.prepare(sql);
            for (const params of runtime.buffer) {
              await stmt.exec(params);
            }
          }
          runtime.buffer = [];
          runtime.flushedOffset = runtime.offset;
          runtime.state = 'COMMITTED';
          runtime.committedMs = commitMs;
        }

        const response: Record<string, unknown> = {
          commitTime: {
            seconds: Math.floor(commitMs / 1000),
            nanos: (commitMs % 1000) * 1_000_000,
          },
        };
        if (streamErrors.length > 0) {
          response['streamErrors'] = streamErrors;
        }
        callback(null, response);
      } catch (err) {
        /* node:coverage ignore next 5 */
        callback(
          bqError(grpc.status.INTERNAL, err instanceof Error ? err.message : String(err)),
          null,
        );
      }
    })();
  };
}

// ---------------------------------------------------------------------------
// FlushRows — promote buffered rows on a BUFFERED stream up to `offset`.
// ---------------------------------------------------------------------------

function flushRowsHandler(
  db: Db,
  streams: WriteStreamStore,
): grpc.handleUnaryCall<FlushRowsInput, object> {
  return (call, callback): void => {
    void (async (): Promise<void> => {
      try {
        const name = call.request.writeStream ?? '';
        const runtime = streams.get(name);
        if (runtime === undefined) {
          callback(bqError(grpc.status.NOT_FOUND, `Write stream "${name}" not found`), null);
          return;
        }
        if (runtime.type !== 'BUFFERED') {
          callback(
            bqError(
              grpc.status.FAILED_PRECONDITION,
              `FlushRows is only valid on BUFFERED streams; "${name}" is ${runtime.type}`,
            ),
            null,
          );
          return;
        }
        if (runtime.state === 'COMMITTED') {
          /* node:coverage ignore next 5 */
          callback(
            bqError(grpc.status.FAILED_PRECONDITION, `Stream "${name}" is already committed`),
            null,
          );
          return;
        }

        // `offset` is an Int64Value (wrapped int64). Per the BQ contract,
        // it's the *inclusive last row index* to flush — FlushRows(offset=2)
        // makes rows 0, 1, 2 visible (3 rows). Unset → flush everything
        // buffered so far. `flushedOffset` is the count of rows already
        // visible, so the valid request range is
        // `[flushedOffset - 1, runtime.offset - 1]`.
        const rawOffset = call.request.offset?.value;
        const requestedInclusive =
          rawOffset === undefined || rawOffset === null ? runtime.offset - 1 : Number(rawOffset);
        const targetCount = requestedInclusive + 1; // exclusive count of visible rows

        if (requestedInclusive >= runtime.offset) {
          callback(
            bqError(
              grpc.status.OUT_OF_RANGE,
              `FlushRows offset ${requestedInclusive} is beyond appended end (rows 0..${runtime.offset - 1})`,
            ),
            null,
          );
          return;
        }
        if (targetCount < runtime.flushedOffset) {
          // Already-flushed → idempotent. Return the last-visible offset
          // (count-1 in inclusive form, which is what real BQ echoes).
          callback(null, { offset: String(runtime.flushedOffset - 1) });
          return;
        }

        const toFlush = targetCount - runtime.flushedOffset;
        if (toFlush > 0) {
          const sql = buildInsertSql(runtime);
          const stmt = db.prepare(sql);
          for (let i = 0; i < toFlush; i++) {
            await stmt.exec(runtime.buffer[i] as unknown[]);
          }
          runtime.buffer = runtime.buffer.slice(toFlush);
          runtime.flushedOffset = targetCount;
        }

        // Response echoes the inclusive last-flushed row index.
        callback(null, { offset: String(runtime.flushedOffset - 1) });
      } catch (err) {
        /* node:coverage ignore next 5 */
        callback(
          bqError(grpc.status.INTERNAL, err instanceof Error ? err.message : String(err)),
          null,
        );
      }
    })();
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerBigQueryWrite(server: grpc.Server, db: Db): void {
  const streams = createWriteStreamStore();
  server.register(
    WRITE_PATH('CreateWriteStream'),
    createWriteStreamHandler(db, streams),
    (value: object) => serializeMessage(WriteStream, value),
    (bytes: Buffer) => deserializeMessage<CreateWriteStreamInput>(CreateWriteStreamRequest, bytes),
    'unary',
  );
  server.register(
    WRITE_PATH('AppendRows'),
    appendRowsHandler(db, streams),
    (value: object) => serializeMessage(AppendRowsResponse, value),
    (bytes: Buffer) => deserializeMessage<AppendRowsInput>(AppendRowsRequest, bytes),
    'bidi',
  );
  server.register(
    WRITE_PATH('FinalizeWriteStream'),
    finalizeWriteStreamHandler(streams),
    (value: object) => serializeMessage(FinalizeWriteStreamResponse, value),
    (bytes: Buffer) =>
      deserializeMessage<FinalizeWriteStreamInput>(FinalizeWriteStreamRequest, bytes),
    'unary',
  );
  server.register(
    WRITE_PATH('BatchCommitWriteStreams'),
    batchCommitWriteStreamsHandler(db, streams),
    (value: object) => serializeMessage(BatchCommitWriteStreamsResponse, value),
    (bytes: Buffer) =>
      deserializeMessage<BatchCommitWriteStreamsInput>(BatchCommitWriteStreamsRequest, bytes),
    'unary',
  );
  server.register(
    WRITE_PATH('FlushRows'),
    flushRowsHandler(db, streams),
    (value: object) => serializeMessage(FlushRowsResponse, value),
    (bytes: Buffer) => deserializeMessage<FlushRowsInput>(FlushRowsRequest, bytes),
    'unary',
  );
}

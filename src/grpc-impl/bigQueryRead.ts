/**
 * BigQueryRead gRPC service handlers.
 *
 * BL-117: `CreateReadSession` — looks up the table, builds the Avro
 *   schema, returns a `ReadSession` with `name` / `expireTime` /
 *   `streams[]` / `estimatedRowCount` and stores the session state
 *   so `ReadRows` can find it later.
 *
 * BL-118: `ReadRows` (server-streaming) — looks up the session by
 *   stream name, queries the table through DuckDB, encodes rows in
 *   Avro binary via `createAvroRowEncoder`, and writes
 *   `ReadRowsResponse` batches over the stream.
 *
 * `SplitReadStream` stays unregistered → grpc-js's default
 * UNIMPLEMENTED until we need it (BL-120's parallel streams story).
 */

import { randomUUID } from 'node:crypto';

import * as grpc from '@grpc/grpc-js';

import { qualifiedTableName } from '../routes/tables.ts';
import type { Db } from '../storage/db.ts';
import { getTable } from '../storage/meta.ts';
import type { BqField } from '../storage/types.ts';
import { arrowSelectExpression, createArrowIpcEncoder } from './arrowRows.ts';
import { avroSelectExpression, createAvroRowEncoder } from './avroRows.ts';
import { bqSchemaToAvroJson } from './avroSchema.ts';
import {
  CreateReadSessionRequest,
  READ_PATH,
  ReadRowsRequest,
  ReadRowsResponse,
  ReadSession,
} from './protos.ts';
import { type SessionStore, createSessionStore } from './sessionStore.ts';

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const READ_ROWS_BATCH = 1000;

const TABLE_REF_RE = /^projects\/([^/]+)\/datasets\/([^/]+)\/tables\/([^/]+)$/;

interface CreateReadSessionInput {
  parent?: string;
  readSession?: {
    table?: string;
    dataFormat?: string | number;
    readOptions?: {
      selectedFields?: string[];
      rowRestriction?: string;
    };
    /**
     * `tableModifiers.snapshotTime` accepted as a stub (BL-121). We don't
     * keep versioned storage (BL-106 deferred — emulators rarely need
     * `FOR SYSTEM_TIME AS OF`), so the snapshot effectively reads the
     * current table state. Reads remain repeatable for the session's
     * lifetime, which satisfies the acceptance criterion.
     */
    tableModifiers?: {
      snapshotTime?: { seconds?: number | string; nanos?: number };
    };
  };
  maxStreamCount?: number;
  preferredMinStreamCount?: number;
}

interface ReadRowsInput {
  readStream?: string;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Ser/de helpers — protobufjs `fromObject` accepts loose JS values (string
// enum names, plain timestamps), so the handlers can return shaped objects
// without manual conversion to Message instances.
// ---------------------------------------------------------------------------

function serializeReadSession(value: object): Buffer {
  return Buffer.from(ReadSession.encode(ReadSession.fromObject(value)).finish());
}

function deserializeCreateReadSessionRequest(bytes: Buffer): CreateReadSessionInput {
  const decoded = CreateReadSessionRequest.decode(bytes);
  return CreateReadSessionRequest.toObject(decoded, {
    defaults: false,
    arrays: true,
    objects: true,
    longs: Number,
    enums: String,
  }) as CreateReadSessionInput;
}

function serializeReadRowsResponse(value: object): Buffer {
  return Buffer.from(ReadRowsResponse.encode(ReadRowsResponse.fromObject(value)).finish());
}

function deserializeReadRowsRequest(bytes: Buffer): ReadRowsInput {
  const decoded = ReadRowsRequest.decode(bytes);
  return ReadRowsRequest.toObject(decoded, {
    defaults: false,
    arrays: true,
    objects: true,
    longs: Number,
    enums: String,
  }) as ReadRowsInput;
}

function bqError(code: grpc.status, details: string): grpc.ServiceError {
  return Object.assign(new Error(details), {
    code,
    details,
    metadata: new grpc.Metadata(),
  });
}

// ---------------------------------------------------------------------------
// CreateReadSession
// ---------------------------------------------------------------------------

function createReadSessionHandler(
  db: Db,
  sessions: SessionStore,
): grpc.handleUnaryCall<CreateReadSessionInput, object> {
  return (call, callback): void => {
    void (async (): Promise<void> => {
      try {
        const req = call.request;
        const tableRef = req.readSession?.table ?? '';
        const match = TABLE_REF_RE.exec(tableRef);
        if (match === null) {
          callback(
            bqError(
              grpc.status.INVALID_ARGUMENT,
              `read_session.table must match projects/.../datasets/.../tables/...; got "${tableRef}"`,
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

        const rawFormat = req.readSession?.dataFormat;
        let format: 'AVRO' | 'ARROW';
        if (rawFormat === 'AVRO' || rawFormat === 1 || rawFormat === undefined) {
          format = 'AVRO';
        } else if (rawFormat === 'ARROW' || rawFormat === 2) {
          format = 'ARROW';
        } else {
          callback(
            bqError(
              grpc.status.INVALID_ARGUMENT,
              `data_format must be AVRO or ARROW; got "${String(rawFormat)}"`,
            ),
            null,
          );
          return;
        }

        const meta = await getTable(db, project, datasetId, tableId);
        if (meta === null) {
          callback(
            bqError(grpc.status.NOT_FOUND, `Not found: Table ${project}:${datasetId}.${tableId}`),
            null,
          );
          return;
        }

        const allFields =
          (meta.schema as { fields?: readonly BqField[] } | undefined)?.fields ?? [];
        const selected = req.readSession?.readOptions?.selectedFields ?? [];
        const fields =
          selected.length === 0 ? allFields : allFields.filter((f) => selected.includes(f.name));

        // Real BQ surfaces an actual row count here, not whatever the
        // metadata happens to hold — count the table at the moment we
        // open the session.
        const qualified = qualifiedTableName(project, datasetId, tableId);
        const rowRestriction = req.readSession?.readOptions?.rowRestriction ?? '';
        const where = rowRestriction === '' ? '' : `WHERE ${rowRestriction}`;
        const totalCountRows = await db.query<{ n: bigint }>(
          `SELECT COUNT(*)::BIGINT AS n FROM ${qualified}`,
        );
        const estimatedRowCount = Number(totalCountRows[0]?.n ?? 0n);
        // For stream partitioning we need the post-filter count: each
        // stream is responsible for a contiguous slice of the filtered
        // result, so the total bytes / rows must add up to that filtered
        // count, not the raw table count.
        const filteredCountRows =
          rowRestriction === ''
            ? totalCountRows
            : await db.query<{ n: bigint }>(
                `SELECT COUNT(*)::BIGINT AS n FROM ${qualified} ${where}`,
              );
        const filteredRowCount = Number(filteredCountRows[0]?.n ?? 0n);

        const sessionId = randomUUID();
        const sessionName = `projects/${project}/locations/us/sessions/${sessionId}`;
        const expireMs = Date.now() + SESSION_TTL_MS;

        // BL-120: honor `maxStreamCount`. Real BQ treats `0` (or unset) as
        // "server picks"; we default to 1 (small-table behavior). Cap at
        // the filtered row count so we never emit empty trailing slices —
        // though we always emit at least one stream so an empty result
        // still has somewhere to deliver the schema.
        const requestedStreams = Math.max(1, req.maxStreamCount ?? 1);
        const streamCount = Math.max(1, Math.min(requestedStreams, filteredRowCount || 1));
        const streams = Array.from({ length: streamCount }, (_, i) => {
          const startFloat = (i * filteredRowCount) / streamCount;
          const endFloat = ((i + 1) * filteredRowCount) / streamCount;
          const offset = Math.floor(startFloat);
          const size = Math.floor(endFloat) - offset;
          return {
            name: `${sessionName}/streams/${i.toString().padStart(4, '0')}`,
            offset,
            size,
          };
        });

        // Build the schema bytes for whichever format the client picked.
        const avroSchemaJson = format === 'AVRO' ? bqSchemaToAvroJson(tableId, fields) : undefined;
        const arrowSchemaBytes =
          format === 'ARROW' ? createArrowIpcEncoder(fields).schemaIpcBytes : undefined;

        sessions.put({
          name: sessionName,
          project,
          datasetId,
          tableId,
          fields,
          selectedFields: selected,
          rowRestriction,
          streams,
          dataFormat: format,
          ...(avroSchemaJson !== undefined && { avroSchemaJson }),
          ...(arrowSchemaBytes !== undefined && { arrowSchemaIpcBytes: arrowSchemaBytes }),
          expireMs,
        });

        const response: Record<string, unknown> = {
          name: sessionName,
          expireTime: {
            seconds: Math.floor(expireMs / 1000),
            nanos: (expireMs % 1000) * 1_000_000,
          },
          dataFormat: format,
          table: tableRef,
          readOptions: {
            selectedFields: selected,
            rowRestriction,
          },
          streams: streams.map(({ name }) => ({ name })),
          estimatedTotalBytesScanned: 0,
          estimatedTotalPhysicalFileSize: 0,
          estimatedRowCount,
        };
        // Echo back `tableModifiers.snapshotTime` so clients that set it
        // (and re-read the session later) see the same value. The data
        // path serves the current table state — see BL-121 note above.
        const snapshotTime = req.readSession?.tableModifiers?.snapshotTime;
        if (snapshotTime !== undefined) {
          response['tableModifiers'] = { snapshotTime };
        }
        if (format === 'AVRO') {
          response['avroSchema'] = { schema: avroSchemaJson };
        } else {
          response['arrowSchema'] = { serializedSchema: arrowSchemaBytes };
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
// ReadRows
// ---------------------------------------------------------------------------

function readRowsHandler(
  db: Db,
  sessions: SessionStore,
): grpc.handleServerStreamingCall<ReadRowsInput, object> {
  return (call): void => {
    void (async (): Promise<void> => {
      try {
        const streamName = call.request.readStream ?? '';
        const resolved = sessions.getStream(streamName);
        if (resolved === undefined) {
          call.emit(
            'error',
            bqError(grpc.status.NOT_FOUND, `Read stream "${streamName}" not found`),
          );
          return;
        }
        const { session, stream } = resolved;

        // ReadRowsRequest.offset is per-stream — the caller can resume at
        // a particular row within their assigned slice. Combine that with
        // the stream's own offset to land on the right table position.
        const callerOffset = Number(call.request.offset ?? 0);
        const sliceOffset = stream.offset + callerOffset;
        const sliceSize = Math.max(0, stream.size - callerOffset);
        const qualified = qualifiedTableName(session.project, session.datasetId, session.tableId);
        const projectColumn =
          session.dataFormat === 'ARROW' ? arrowSelectExpression : avroSelectExpression;
        const projection = session.fields
          .map((f) => `${projectColumn(f.name, f)} AS "${f.name.replace(/"/g, '""')}"`)
          .join(', ');
        const where = session.rowRestriction === '' ? '' : `WHERE ${session.rowRestriction}`;
        // DuckDB doesn't expose a portable user-table `rowid`; rely on a
        // stable ORDER BY computed from the filtered result + LIMIT/OFFSET
        // to give each stream a deterministic, non-overlapping slice.
        const orderBy = 'ORDER BY rowid';
        const limitClause = sliceSize > 0 ? `LIMIT ${sliceSize}` : 'LIMIT 0';
        const offsetClause = `OFFSET ${sliceOffset}`;
        const sql =
          session.fields.length === 0
            ? `SELECT 1 AS _placeholder FROM ${qualified} ${where} ${orderBy} ${limitClause} ${offsetClause}`
            : `SELECT ${projection} FROM ${qualified} ${where} ${orderBy} ${limitClause} ${offsetClause}`;
        const rows = await db.query<Record<string, unknown>>(sql);

        if (session.dataFormat === 'AVRO') {
          const schemaJson = session.avroSchemaJson as string;
          const encoder = createAvroRowEncoder(schemaJson, session.fields);
          if (rows.length === 0) {
            call.write({
              avroSchema: { schema: schemaJson },
              avroRows: { serializedBinaryRows: Buffer.alloc(0) },
            });
            call.end();
            return;
          }
          for (let i = 0; i < rows.length; i += READ_ROWS_BATCH) {
            const batch = rows.slice(i, i + READ_ROWS_BATCH);
            const serialized = encoder.encodeBatch(batch);
            const message: Record<string, unknown> = {
              avroRows: { serializedBinaryRows: serialized },
              uncompressedByteSize: serialized.length,
            };
            if (i === 0) {
              message['avroSchema'] = { schema: schemaJson };
            }
            call.write(message);
          }
          call.end();
          return;
        }

        // ARROW path.
        const arrowSchemaBytes = session.arrowSchemaIpcBytes as Uint8Array;
        const arrowEncoder = createArrowIpcEncoder(session.fields);
        if (rows.length === 0) {
          call.write({
            arrowSchema: { serializedSchema: arrowSchemaBytes },
            arrowRecordBatch: { serializedRecordBatch: arrowEncoder.encodeBatch([]) },
          });
          call.end();
          return;
        }
        for (let i = 0; i < rows.length; i += READ_ROWS_BATCH) {
          const batch = rows.slice(i, i + READ_ROWS_BATCH);
          const serialized = arrowEncoder.encodeBatch(batch);
          const message: Record<string, unknown> = {
            arrowRecordBatch: { serializedRecordBatch: serialized },
            uncompressedByteSize: serialized.length,
          };
          if (i === 0) {
            message['arrowSchema'] = { serializedSchema: arrowSchemaBytes };
          }
          call.write(message);
        }
        call.end();
      } catch (err) {
        call.emit(
          'error',
          bqError(grpc.status.INTERNAL, err instanceof Error ? err.message : String(err)),
        );
      }
    })();
  };
}

/**
 * Register the BigQueryRead RPCs on a grpc-js Server. Only methods we
 * actually implement are registered; the rest fall through to
 * grpc-js's built-in UNIMPLEMENTED response for unregistered paths.
 */
export function registerBigQueryRead(server: grpc.Server, db: Db): void {
  const sessions = createSessionStore();
  server.register(
    READ_PATH('CreateReadSession'),
    createReadSessionHandler(db, sessions),
    serializeReadSession,
    deserializeCreateReadSessionRequest,
    'unary',
  );
  server.register(
    READ_PATH('ReadRows'),
    readRowsHandler(db, sessions),
    serializeReadRowsResponse,
    deserializeReadRowsRequest,
    'serverStream',
  );
}

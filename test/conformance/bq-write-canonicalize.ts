/**
 * Canonicalization for the Storage Write API replay suite.
 *
 * Each fixture is a *sequence* of operations against the Write API.
 * The canonicalizer normalizes per-response details that legitimately
 * vary (stream UUIDs, project names, commit timestamps, server-side
 * `entity` paths) so the captured-vs-emulator diff focuses on the
 * shapes and types that *should* match.
 */

import type { BqField } from '../../src/storage/types.ts';

export type WriteStreamType = 'COMMITTED' | 'PENDING' | 'BUFFERED';

export type WriteOpRequest =
  | {
      readonly op: 'createWriteStream';
      readonly type: WriteStreamType;
    }
  | {
      readonly op: 'appendRows';
      /** Stream alias from a prior `createWriteStream` (e.g. `$0`), or
       *  the literal `_default` for the default stream. */
      readonly stream: string;
      readonly rows: readonly Record<string, unknown>[];
      /** Optional offset on the request (Int64Value). Unset → at-least-once. */
      readonly offset?: number;
      /** First message on a bidi stream must carry the writer schema;
       *  later ones reuse it. Default true → include schema. */
      readonly includeSchema?: boolean;
    }
  | {
      readonly op: 'finalizeWriteStream';
      readonly stream: string;
    }
  | {
      readonly op: 'batchCommitWriteStreams';
      readonly streams: readonly string[];
    }
  | {
      readonly op: 'flushRows';
      readonly stream: string;
      readonly offset?: number;
    }
  | {
      /** Out-of-band DDL — the capture script runs it via SQL on the
       *  real table; the local harness runs it on DuckDB. Lets us
       *  exercise BL-126 (schema updates mid-stream). */
      readonly op: 'alterTable';
      readonly sql: string;
      readonly localSql?: string;
    }
  | {
      /** Query the table directly (post-write) so the fixture can
       *  assert the rows that ended up visible. SQL is `SELECT …` and
       *  is run via the existing meta-layer `db.query`. Returns rows
       *  as canonical objects (sorted by JSON.stringify). */
      readonly op: 'selectTable';
      readonly sql: string;
      readonly localSql?: string;
    };

export interface WriteFixtureInput {
  readonly description?: string;
  readonly schema: readonly BqField[];
  /** Optional ALTER schema after a midstream change so the local
   *  harness knows what columns to project (currently informational
   *  — the fixture's alterTable op rewrites the table). */
  readonly operations: readonly WriteOpRequest[];
}

// ---------------------------------------------------------------------------
// Captured response shapes (after canonicalization)
// ---------------------------------------------------------------------------

export interface CapturedCreateWriteStream {
  readonly op: 'createWriteStream';
  /** Either `COMMITTED` | `PENDING` | `BUFFERED` (or the unspecified
   *  marker if the server didn't fill it). */
  readonly type: string;
  /** True iff a non-empty `createTime` was returned. We don't compare
   *  the exact timestamp — wall-clock-derived. */
  readonly hasCreateTime: boolean;
  /** Project segment is masked to `<PROJECT>`; the rest is preserved
   *  so we still verify the resource-name shape. */
  readonly maskedName: string;
}

export interface CapturedAppendRows {
  readonly op: 'appendRows';
  /** `null` when no error; otherwise the gRPC status code (mirrors
   *  `grpc.status.*`). */
  readonly errorCode: number | null;
  /** Captured iff `errorCode === null`. */
  readonly appendResultOffset: string | null;
  /** True iff the response carried a non-empty `write_stream` echo. */
  readonly hasWriteStream: boolean;
  // Note: `updated_schema` is intentionally dropped from the canonical
  // comparison. Real BQ emits an (often empty) updatedSchema on every
  // first-response-per-bidi as a "schema sync ping"; our emulator only
  // emits it when the etag actually changes. The schema-update path is
  // covered by the dedicated unit test in
  // `test/api/grpc-offsets-schema-mux.test.ts`.
}

export interface CapturedFinalizeWriteStream {
  readonly op: 'finalizeWriteStream';
  readonly rowCount: string;
}

export interface CapturedBatchCommitWriteStreams {
  readonly op: 'batchCommitWriteStreams';
  readonly hasCommitTime: boolean;
  /** Number of streams that errored out; the error messages themselves
   *  vary across implementations so we count not match. */
  readonly streamErrorCount: number;
}

export interface CapturedFlushRows {
  readonly op: 'flushRows';
  readonly offset: string;
}

export interface CapturedAlterTable {
  readonly op: 'alterTable';
}

export interface CapturedSelectTable {
  readonly op: 'selectTable';
  /** Decoded rows, normalized + sorted by JSON.stringify so engine
   *  storage order doesn't matter (mirrors the Read replay strategy). */
  readonly rows: readonly Record<string, unknown>[];
}

export type CapturedOp =
  | CapturedCreateWriteStream
  | CapturedAppendRows
  | CapturedFinalizeWriteStream
  | CapturedBatchCommitWriteStreams
  | CapturedFlushRows
  | CapturedAlterTable
  | CapturedSelectTable;

export interface WriteFixtureCapture {
  readonly operations: readonly CapturedOp[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STREAM_NAME_RE = /^projects\/[^/]+\/datasets\/([^/]+)\/tables\/([^/]+)\/streams\/(.+)$/;
const TABLE_UUID_SUFFIX_RE = /_[0-9a-f]{8}$/;

export function maskStreamName(name: string): string {
  const match = STREAM_NAME_RE.exec(name);
  if (match === null) return name;
  const [, dataset, table, streamId] = match as unknown as [string, string, string, string];
  // Capture script suffixes table ids with an 8-hex-char UUID slice so
  // re-runs don't collide. Strip the suffix in canonical form so the
  // local harness (which uses unsuffixed names) can compare equal.
  const maskedTable = table.replace(TABLE_UUID_SUFFIX_RE, '');
  const maskedStream = streamId === '_default' ? '_default' : '<STREAM_ID>';
  return `projects/<PROJECT>/datasets/${dataset}/tables/${maskedTable}/streams/${maskedStream}`;
}

export function canonicalizeRowValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return { __bytes: v.toString('base64') };
  if (v instanceof Uint8Array) return { __bytes: Buffer.from(v).toString('base64') };
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') {
    // Normalize bigints that fit in JS safe-integer range to Number
    // — that's how the @google-cloud/bigquery client returns INT64
    // values, so DuckDB's bigint-flavored result needs to align.
    const asNumber = Number(v);
    if (Number.isSafeInteger(asNumber) && BigInt(asNumber) === v) return asNumber;
    return String(v);
  }
  if (Array.isArray(v)) return v.map(canonicalizeRowValue);
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = canonicalizeRowValue(obj[k]);
    }
    return out;
  }
  return v;
}

export function sortRows(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows]
    .map((r) => canonicalizeRowValue(r) as Record<string, unknown>)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

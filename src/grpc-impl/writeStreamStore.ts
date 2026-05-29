/**
 * In-memory state for the Storage Write API's explicit ("application")
 * streams.
 *
 * Stream lifecycle (BQ Storage Write semantics, simplified for the
 * emulator):
 *   ACTIVE
 *     │  client appends rows via AppendRows
 *     │
 *     ├─ COMMITTED type → each successful append immediately INSERTs
 *     │  into the target table (exactly-once with offset enforcement,
 *     │  the offset bits in BL-125).
 *     │
 *     ├─ BUFFERED type → rows go to an in-memory buffer; client uses
 *     │  FlushRows (BL-124) to promote buffered rows to visible.
 *     │
 *     └─ PENDING type → rows buffer until BatchCommitWriteStreams
 *        flushes the entire buffer atomically.
 *   FINALIZED
 *     │  client called FinalizeWriteStream — no more appends accepted.
 *     │  Buffered data stays in the buffer pending commit (PENDING/
 *     │  BUFFERED). COMMITTED streams just mark done.
 *   COMMITTED  (PENDING streams only, after BatchCommitWriteStreams)
 *     │  buffer flushed to the table, buffer cleared, terminal state.
 *
 * Streams are process-scoped — no persistence, no cross-restart
 * recovery. That's fine for emulator usage.
 */

import type { BqField } from '../storage/types.ts';

export type WriteStreamType = 'COMMITTED' | 'BUFFERED' | 'PENDING';
export type WriteStreamState = 'ACTIVE' | 'FINALIZED' | 'COMMITTED';

export interface WriteStreamMeta {
  readonly name: string;
  readonly project: string;
  readonly datasetId: string;
  readonly tableId: string;
  readonly fields: readonly BqField[];
  readonly type: WriteStreamType;
  readonly createMs: number;
}

export interface WriteStreamRuntime extends Omit<WriteStreamMeta, 'fields'> {
  /** Mutable — tracks the destination table's current schema. The
   *  AppendRows handler refreshes this from the meta layer when an
   *  ALTER TABLE landing changes the table's etag (BL-126). */
  fields: readonly BqField[];
  state: WriteStreamState;
  /** Total rows appended so far (regardless of visibility). */
  offset: number;
  /** Highest offset whose rows are visible in the destination table.
   *  BUFFERED → moves on `FlushRows`. PENDING → jumps to `offset` at
   *  `BatchCommitWriteStreams`. COMMITTED → tracks `offset` directly
   *  since each append is immediate. The in-memory `buffer` holds the
   *  rows in `[flushedOffset, offset)`. */
  flushedOffset: number;
  /** Buffered rows pending flush/commit. Each entry is the ordered
   *  parameter list for the table's INSERT placeholders. */
  buffer: unknown[][];
  /** Wall-clock millis when the stream was finalized; null until then. */
  finalizedMs: number | null;
  /** Wall-clock millis when a PENDING stream was committed; null until then. */
  committedMs: number | null;
}

const STREAM_NAME_RE = /^projects\/([^/]+)\/datasets\/([^/]+)\/tables\/([^/]+)\/streams\/([^/]+)$/;

export function parseStreamName(name: string): {
  readonly project: string;
  readonly datasetId: string;
  readonly tableId: string;
  readonly streamId: string;
} | null {
  const match = STREAM_NAME_RE.exec(name);
  if (match === null) return null;
  const [, project, datasetId, tableId, streamId] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  return { project, datasetId, tableId, streamId };
}

export interface WriteStreamStore {
  create(meta: WriteStreamMeta): WriteStreamRuntime;
  get(name: string): WriteStreamRuntime | undefined;
  /** Drop a stream once it's been committed or abandoned. */
  remove(name: string): boolean;
}

export function createWriteStreamStore(): WriteStreamStore {
  const streams = new Map<string, WriteStreamRuntime>();
  return {
    create(meta) {
      const runtime: WriteStreamRuntime = {
        ...meta,
        state: 'ACTIVE',
        offset: 0,
        flushedOffset: 0,
        buffer: [],
        finalizedMs: null,
        committedMs: null,
      };
      streams.set(meta.name, runtime);
      return runtime;
    },
    get(name) {
      return streams.get(name);
    },
    remove(name) {
      return streams.delete(name);
    },
  };
}

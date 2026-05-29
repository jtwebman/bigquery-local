/**
 * In-memory ReadSession store for the BigQuery Storage Read API.
 *
 * A session is created by `CreateReadSession`, lives in this Map keyed
 * by session name, and is looked up by `ReadRows` / `SplitReadStream`
 * via a stream name (`{sessionName}/streams/{i}`). Sessions are
 * intentionally process-scoped — emulators don't persist them and we
 * don't actively GC; an entry just lingers until the process exits.
 *
 * The real BigQuery Storage Read API gives sessions a TTL of ~6h and
 * tracks them through Spanner; for a local emulator the simpler model
 * is fine and matches goccy's behavior.
 */

import type { BqField } from '../storage/types.ts';

export type SessionDataFormat = 'AVRO' | 'ARROW';

export interface SessionState {
  /** Full session resource name: `projects/.../sessions/{uuid}`. */
  readonly name: string;
  readonly project: string;
  readonly datasetId: string;
  readonly tableId: string;
  /** Fields the client is allowed to read — already filtered by `selected_fields`. */
  readonly fields: readonly BqField[];
  /** Echoed back on responses; not yet applied to the data path. */
  readonly selectedFields: readonly string[];
  /** SQL row filter applied at read time. */
  readonly rowRestriction: string;
  /** Stream slices assigned to this session. Each entry corresponds to one
   *  ReadStream and carries the row offset + size the stream is responsible
   *  for. `size === null` means "from offset to the end of the table". */
  readonly streams: ReadonlyArray<{
    readonly name: string;
    readonly offset: number;
    readonly size: number;
  }>;
  /** The format chosen at CreateReadSession time; ReadRows respects it. */
  readonly dataFormat: SessionDataFormat;
  /** Set when `dataFormat === 'AVRO'`. */
  readonly avroSchemaJson?: string;
  /** Set when `dataFormat === 'ARROW'`. */
  readonly arrowSchemaIpcBytes?: Uint8Array;
  /** Wall-clock millis when this session should be considered expired. */
  readonly expireMs: number;
}

const STREAM_RE = /^(projects\/[^/]+\/locations\/[^/]+\/sessions\/[0-9a-f-]+)\/streams\/\d+$/;

export interface SessionStore {
  put(state: SessionState): void;
  getByName(sessionName: string): SessionState | undefined;
  /** Resolves a stream resource name to the owning session AND the stream
   *  metadata (offset/size) so callers don't have to scan again. */
  getStream(
    streamName: string,
  ):
    | { readonly session: SessionState; readonly stream: SessionState['streams'][number] }
    | undefined;
}

export function createSessionStore(): SessionStore {
  const sessions = new Map<string, SessionState>();
  return {
    put(state) {
      sessions.set(state.name, state);
    },
    getByName(name) {
      return sessions.get(name);
    },
    getStream(streamName) {
      const match = STREAM_RE.exec(streamName);
      if (match === null) return undefined;
      const session = sessions.get(match[1] as string);
      if (session === undefined) return undefined;
      const stream = session.streams.find((s) => s.name === streamName);
      if (stream === undefined) return undefined;
      return { session, stream };
    },
  };
}

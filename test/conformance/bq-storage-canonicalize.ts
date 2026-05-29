/**
 * Canonicalization for the gRPC Storage Read replay suite.
 *
 * The pieces of the response that don't carry meaningful information
 * are normalized so a real-BQ capture and an emulator response can be
 * compared structurally:
 *
 *   - session names contain a fresh UUID → `<SESSION_ID>` placeholder
 *   - stream names contain the same UUID + an index → `<STREAM_NAME_N>`
 *   - `expireTime` is dropped (depends on capture wall-clock)
 *   - `table` resource name's project segment → `<PROJECT>` placeholder
 *   - the Avro schema string is re-emitted with stable key ordering
 *     so whitespace / field-property-ordering differences don't fail
 *     the byte comparison
 *
 * Everything else (data format, `estimatedRowCount`, stream count,
 * Avro record name, field list, `readOptions`) round-trips
 * byte-for-byte and any divergence is a real fidelity bug.
 */

export interface CanonicalCreateReadSessionResponse {
  /** Empty string for ARROW sessions. */
  readonly avroSchema: string;
  /**
   * Whether an Arrow schema is present. The raw IPC bytes have legitimate
   * encoding flexibility (FlatBuffer field ordering, dictionary indexing
   * choices, …) so byte comparison is too strict. Row decoding implicitly
   * verifies that both sides' schemas describe the same logical types.
   */
  readonly hasArrowSchema: boolean;
  readonly dataFormat: string;
  readonly estimatedRowCount: string;
  /**
   * Stream count is NOT part of the structural comparison — BQ applies a
   * small-table heuristic and may return fewer streams than the caller
   * asked for. The row-set comparison still verifies every row reaches
   * exactly one stream, which is the actual correctness invariant.
   */
  readonly hasStreams: boolean;
  readonly table: string;
  readonly readOptions: {
    readonly selectedFields: readonly string[];
    readonly rowRestriction: string;
  };
}

export interface CanonicalReadRowsBatch {
  readonly rowCount: string;
  readonly uncompressedByteSize: string;
  /** AVRO row block (empty when ARROW). */
  readonly serializedBinaryRowsBase64: string;
  /** ARROW record batch bytes (empty when AVRO). */
  readonly serializedRecordBatchBase64: string;
  /** True iff the message included `avroSchema`. */
  readonly hasAvroSchema: boolean;
  /** True iff the message included `arrowSchema`. */
  readonly hasArrowSchema: boolean;
}

export interface CanonicalCapture {
  readonly createReadSession: CanonicalCreateReadSessionResponse;
  readonly readRows: ReadonlyArray<CanonicalReadRowsBatch>;
  /**
   * Raw Arrow IPC schema bytes from the capture, kept so the test harness
   * can decode the captured `serialized_record_batch` blocks. Not part of
   * the comparison — Arrow IPC encoding is value-equivalent but not
   * byte-deterministic across implementations.
   */
  readonly _arrowSchemaBase64?: string;
}

function canonicalAvroSchema(schemaJson: string): string {
  return JSON.stringify(sortKeys(JSON.parse(schemaJson)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = sortKeys(obj[k]);
    }
    return out;
  }
  return value;
}

function maskProject(tableRef: string): string {
  // "projects/<X>/datasets/<Y>/tables/<Z>" → "projects/<PROJECT>/datasets/<Y>/tables/<Z>"
  return tableRef.replace(/^projects\/[^/]+\//, 'projects/<PROJECT>/');
}

interface RawReadSession {
  readonly name?: string;
  readonly avroSchema?: { readonly schema?: string };
  readonly arrowSchema?: { readonly serializedSchema?: Uint8Array | Buffer | string };
  readonly dataFormat?: string | number;
  readonly table?: string;
  readonly readOptions?: {
    readonly selectedFields?: readonly string[];
    readonly rowRestriction?: string;
  };
  readonly streams?: ReadonlyArray<{ readonly name?: string }>;
  readonly estimatedRowCount?: number | string;
}

export function canonicalizeCreateReadSession(
  raw: RawReadSession,
): CanonicalCreateReadSessionResponse {
  const schema = raw.avroSchema?.schema ?? '';
  return {
    avroSchema: schema === '' ? '' : canonicalAvroSchema(schema),
    hasArrowSchema: raw.arrowSchema?.serializedSchema !== undefined,
    dataFormat:
      typeof raw.dataFormat === 'number'
        ? formatNameFor(raw.dataFormat)
        : (raw.dataFormat ?? 'AVRO'),
    estimatedRowCount: String(raw.estimatedRowCount ?? 0),
    hasStreams: (raw.streams?.length ?? 0) > 0,
    table: maskProject(raw.table ?? ''),
    readOptions: {
      selectedFields: raw.readOptions?.selectedFields ?? [],
      rowRestriction: raw.readOptions?.rowRestriction ?? '',
    },
  };
}

function formatNameFor(value: number): string {
  switch (value) {
    case 1:
      return 'AVRO';
    case 2:
      return 'ARROW';
    default:
      return 'DATA_FORMAT_UNSPECIFIED';
  }
}

interface RawReadRowsResponse {
  readonly avroRows?: {
    readonly serializedBinaryRows?: Uint8Array | Buffer | string;
    readonly rowCount?: number | string;
  };
  readonly arrowRecordBatch?: {
    readonly serializedRecordBatch?: Uint8Array | Buffer | string;
    readonly rowCount?: number | string;
  };
  readonly avroSchema?: { readonly schema?: string };
  readonly arrowSchema?: { readonly serializedSchema?: Uint8Array | Buffer | string };
  readonly rowCount?: number | string;
  readonly uncompressedByteSize?: number | string;
}

function bytesToBase64(bytes: Uint8Array | Buffer | string): string {
  if (typeof bytes === 'string') {
    // Real-BQ client sometimes hands back base64 strings when the message
    // is converted with `bytes: String` — keep them as-is.
    return bytes;
  }
  return Buffer.from(bytes).toString('base64');
}

export function canonicalizeReadRowsBatch(raw: RawReadRowsResponse): CanonicalReadRowsBatch {
  const avroInner = raw.avroRows ?? {};
  const arrowInner = raw.arrowRecordBatch ?? {};
  const avroBytes = avroInner.serializedBinaryRows;
  const arrowBytes = arrowInner.serializedRecordBatch;
  const bytesLen = (avroBytes?.length ?? 0) + (arrowBytes?.length ?? 0);
  return {
    rowCount: String(avroInner.rowCount ?? arrowInner.rowCount ?? raw.rowCount ?? 0),
    uncompressedByteSize: String(raw.uncompressedByteSize ?? bytesLen),
    serializedBinaryRowsBase64: avroBytes === undefined ? '' : bytesToBase64(avroBytes),
    serializedRecordBatchBase64: arrowBytes === undefined ? '' : bytesToBase64(arrowBytes),
    hasAvroSchema: raw.avroSchema?.schema !== undefined,
    hasArrowSchema: raw.arrowSchema?.serializedSchema !== undefined,
  };
}

/**
 * Concatenate every batch's binary rows into a single buffer so the
 * comparison doesn't depend on how the server chose to chunk them.
 * Returns both the Avro and Arrow concatenations — the test harness
 * picks whichever the session's dataFormat dictated.
 */
export function flattenReadRows(batches: ReadonlyArray<CanonicalReadRowsBatch>): {
  readonly serializedBinaryRowsBase64: string;
  readonly serializedRecordBatchesBase64: string;
  readonly schemaInFirst: boolean;
} {
  let combinedAvro = Buffer.alloc(0);
  const arrowBatches: Buffer[] = [];
  for (const b of batches) {
    if (b.serializedBinaryRowsBase64 !== '') {
      combinedAvro = Buffer.concat([
        combinedAvro,
        Buffer.from(b.serializedBinaryRowsBase64, 'base64'),
      ]);
    }
    if (b.serializedRecordBatchBase64 !== '') {
      arrowBatches.push(Buffer.from(b.serializedRecordBatchBase64, 'base64'));
    }
  }
  return {
    serializedBinaryRowsBase64: combinedAvro.toString('base64'),
    serializedRecordBatchesBase64: Buffer.concat(arrowBatches).toString('base64'),
    schemaInFirst: batches[0]?.hasAvroSchema === true || batches[0]?.hasArrowSchema === true,
  };
}

/**
 * Real BQ and DuckDB are both free to return rows in different storage
 * orders, so a raw byte comparison would be order-dependent. Instead,
 * decode each row using the Avro schema both sides agree on, normalize
 * Buffer/named-record artifacts, sort lexicographically by JSON, and
 * compare structurally. Identical values against the same schema would
 * re-encode to identical bytes — this comparison still proves "same
 * rows" without depending on engine storage order.
 *
 * Requires `avsc` so the canonicalizer stays the only side that needs
 * an Avro decoder. We accept `avsc.Type` (or a factory) injected by
 * the test harness to avoid pulling the dep into the canonicalizer's
 * own unit test (which doesn't need to actually decode anything).
 */
export interface AvroDecoder {
  decode(buf: Buffer, offset: number): { value: unknown; offset: number };
}

export function decodeAndSortRows(decoder: AvroDecoder, base64Bytes: string): readonly unknown[] {
  const bytes = Buffer.from(base64Bytes, 'base64');
  const rows: unknown[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const { value, offset: next } = decoder.decode(bytes, offset);
    rows.push(canonicalizeRowValue(value));
    if (next === offset) break; // safety: avoid infinite loop on bad input
    offset = next;
  }
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return rows;
}

function canonicalizeRowValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return { __bytes: v.toString('base64') };
  if (v instanceof Uint8Array) return { __bytes: Buffer.from(v).toString('base64') };
  if (typeof v === 'bigint') return String(v);
  if (Array.isArray(v)) return v.map(canonicalizeRowValue);
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // Strip avsc's record-prototype tag (it's enumerable as a class
    // instance, but `Object.keys` only walks own properties).
    for (const k of Object.keys(obj).sort()) {
      out[k] = canonicalizeRowValue(obj[k]);
    }
    return out;
  }
  return v;
}

/**
 * DuckDB row → Apache Arrow IPC encoder for the Storage Read API's
 * ARROW data format (BL-119).
 *
 * Two responsibilities:
 *   1. `arrowSelectExpression(column, field)` — SQL projection cast
 *      that lines a DuckDB result up with `apache-arrow`'s Vector
 *      builders. Most types share the same projection as the Avro
 *      path; DATETIME differs (Arrow wants µs since epoch, Avro wants
 *      an ISO string).
 *   2. `createArrowIpcWriter(schema, fields)` — builds Arrow
 *      `RecordBatch` instances from DuckDB rows, serializes them as
 *      individual IPC messages, and exposes the schema-only IPC bytes
 *      for the first `CreateReadSession` response.
 *
 * The Storage Read API expects ONE IPC message per `serialized_*`
 * field (schema bytes for the session; one batch message per
 * `ReadRowsResponse`). `apache-arrow`'s public writer emits a full
 * stream; we slice out individual messages via `Message.decode` to
 * read `bodyLength` and compute exact message boundaries.
 */

import {
  Field,
  Message,
  RecordBatch,
  type Schema,
  Struct,
  Table,
  Timestamp,
  makeData,
  tableToIPC,
  vectorFromArray,
} from 'apache-arrow';

import { quoteIdent } from '../routes/tables.ts';
import { bqSchemaToArrowSchema } from './arrowSchema.ts';
import type { BqField } from '../storage/types.ts';

/** SQL projection for one column when the destination is Arrow IPC. */
export function arrowSelectExpression(column: string, field: BqField): string {
  const ident = quoteIdent(column);
  if (field.mode === 'REPEATED') return ident;
  switch (field.type) {
    case 'TIME':
      return `(date_part('hour', ${ident})::BIGINT * 3600000000 + date_part('minute', ${ident})::BIGINT * 60000000 + date_part('microsecond', ${ident})::BIGINT)`;
    case 'GEOGRAPHY':
      return `replace(ST_AsText(${ident}), ' (', '(')`;
    case 'NUMERIC':
    case 'BIGNUMERIC':
      return `${ident}::VARCHAR`;
    case 'TIMESTAMP':
    case 'DATETIME':
      // Arrow encodes both as int64 µs since epoch (TIMESTAMP gets UTC tz
      // on the type, DATETIME has no tz). `epoch_us` returns BIGINT.
      return `epoch_us(${ident})::BIGINT`;
    case 'DATE':
      return `date_diff('day', DATE '1970-01-01', ${ident})::INTEGER`;
    default:
      return ident;
  }
}

// ---------------------------------------------------------------------------
// Decimal helpers (mirrors avroRows.ts; kept independent because Arrow's
// Decimal vector wants a typed array, not raw bytes).
// ---------------------------------------------------------------------------

function decimalStringToUnscaled(decimal: string, scale: number): bigint {
  const negative = decimal.startsWith('-');
  const abs = negative ? decimal.slice(1) : decimal;
  const [intPart, fracPart = ''] = abs.split('.');
  const padded = fracPart.padEnd(scale, '0').slice(0, scale);
  const combined = `${intPart ?? '0'}${padded}`;
  const bi = BigInt(combined);
  return negative ? -bi : bi;
}

/**
 * Arrow's `Decimal` vector expects the unscaled value as a fixed-width
 * little-endian sequence of 32-bit chunks (4 for Decimal128, 8 for
 * Decimal256). Passing a Uint8Array doesn't work — apache-arrow spreads
 * one byte per uint32 slot. Use Uint32Array directly.
 */
function decimalToLeUint32(value: bigint, n32: number): Uint32Array {
  const out = new Uint32Array(n32);
  const mod = 1n << BigInt(n32 * 32);
  let n = value < 0n ? mod + value : value;
  for (let i = 0; i < n32; i++) {
    out[i] = Number(n & 0xffffffffn);
    n >>= 32n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-field DuckDB value → Arrow JS value converter
// ---------------------------------------------------------------------------

interface ColumnConverter {
  readonly field: BqField;
  toArrowValues(rows: ReadonlyArray<Record<string, unknown>>): unknown[];
}

function scalarFor(field: BqField, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (field.type) {
    case 'STRING':
    case 'JSON':
    case 'GEOGRAPHY':
    case 'INTERVAL':
    case 'RANGE':
      return typeof value === 'string' ? value : String(value);
    case 'BYTES':
      return value instanceof Uint8Array ? value : Buffer.from(value as Uint8Array);
    case 'INT64':
      return typeof value === 'bigint' ? value : BigInt(String(value));
    case 'FLOAT64':
      return Number(value);
    case 'BOOL':
      return Boolean(value);
    case 'DATE':
      // apache-arrow's Date32(DAY) vector expects JS Date, not raw days —
      // pass an integer and it silently stores 0. Construct a UTC Date.
      return new Date(Number(value) * 86_400_000);
    case 'TIME':
      // apache-arrow's Time vector wants bigint at the microsecond unit;
      // mixing Number with null triggers a JS "Cannot convert N to BigInt".
      return typeof value === 'bigint' ? value : BigInt(String(value));
    case 'TIMESTAMP':
    case 'DATETIME':
      // We hand apache-arrow the raw int64 µs since epoch through a custom
      // BigInt64Array builder (see buildTimestampData); per-row converter
      // returns a bigint so the columnar path can pack it directly.
      return typeof value === 'bigint' ? value : BigInt(String(value));
    case 'NUMERIC':
      return decimalToLeUint32(decimalStringToUnscaled(String(value), 9), 4);
    case 'BIGNUMERIC':
      return decimalToLeUint32(decimalStringToUnscaled(String(value), 38), 8);
    case 'STRUCT': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Expected object for STRUCT field "${field.name}"`);
      }
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const sub of field.fields ?? []) {
        out[sub.name] = scalarFor(sub, obj[sub.name]);
      }
      return out;
    }
  }
}

function buildConverter(field: BqField): ColumnConverter {
  return {
    field,
    toArrowValues(rows) {
      if (field.mode === 'REPEATED') {
        return rows.map((row) => {
          const v = row[field.name];
          if (v === null || v === undefined) return [];
          if (!Array.isArray(v)) {
            throw new Error(`Expected array for REPEATED field "${field.name}"`);
          }
          const innerField: BqField = { ...field, mode: 'NULLABLE' };
          return v.map((item) => scalarFor(innerField, item));
        });
      }
      return rows.map((row) => scalarFor(field, row[field.name]));
    },
  };
}

// ---------------------------------------------------------------------------
// IPC framing helpers — split apache-arrow's stream output into individual
// messages so we can hand BQ Storage one schema message and one batch
// message per RPC response, the way the proto expects.
// ---------------------------------------------------------------------------

function align8(n: number): number {
  return (n + 7) & ~7;
}

function splitIpcMessages(ipc: Uint8Array): Uint8Array[] {
  const messages: Uint8Array[] = [];
  let offset = 0;
  while (offset + 8 <= ipc.length) {
    const view = new DataView(ipc.buffer, ipc.byteOffset + offset, ipc.length - offset);
    const cont = view.getUint32(0, true);
    if (cont !== 0xffffffff) {
      throw new Error(`Expected IPC continuation marker at offset ${offset}`);
    }
    const metaLen = view.getUint32(4, true);
    if (metaLen === 0) {
      // End-of-stream marker.
      break;
    }
    const flatbuf = ipc.subarray(offset + 8, offset + 8 + metaLen);
    const message = Message.decode(flatbuf);
    const bodyLen = Number(message.bodyLength);
    const totalLen = 8 + metaLen + align8(bodyLen);
    messages.push(ipc.subarray(offset, offset + totalLen));
    offset += totalLen;
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Public encoder
// ---------------------------------------------------------------------------

export interface ArrowIpcEncoder {
  readonly schema: Schema;
  /** IPC schema-only message bytes (for `ReadSession.arrow_schema`). */
  readonly schemaIpcBytes: Uint8Array;
  /** Encode one batch of DuckDB rows → IPC RecordBatch message bytes. */
  encodeBatch(rows: ReadonlyArray<Record<string, unknown>>): Uint8Array;
}

export function createArrowIpcEncoder(fields: readonly BqField[]): ArrowIpcEncoder {
  const schema = bqSchemaToArrowSchema(fields);
  const converters = fields.map(buildConverter);

  function buildBatch(rows: ReadonlyArray<Record<string, unknown>>): RecordBatch {
    const childData = schema.fields.map((arrowField, i) => {
      const converter = converters[i];
      /* node:coverage ignore next 4 */
      if (converter === undefined) {
        throw new Error(`Missing converter for column ${arrowField.name}`);
      }
      const values = converter.toArrowValues(rows);
      // Timestamp(µs) needs hand-built Data: vectorFromArray treats input
      // numbers as JS millis-since-epoch and multiplies by 1000, which
      // would encode nanoseconds when we mean microseconds.
      if (arrowField.type instanceof Timestamp) {
        return buildTimestampData(arrowField.type, values as Array<bigint | null>);
      }
      const vector = vectorFromArray(values as never, arrowField.type);
      const data = vector.data[0];
      /* node:coverage ignore next 4 */
      if (data === undefined) {
        throw new Error(`vectorFromArray returned no data for ${arrowField.name}`);
      }
      return data;
    });
    const structData = makeData({
      type: new Struct(schema.fields as Field[]),
      length: rows.length,
      children: childData,
    });
    return new RecordBatch(schema, structData);
  }

  function buildTimestampData(type: Timestamp, values: Array<bigint | null>) {
    const len = values.length;
    const data = new BigInt64Array(len);
    const nullBitmap = new Uint8Array(Math.ceil(len / 8));
    let nullCount = 0;
    for (let i = 0; i < len; i++) {
      const v = values[i];
      if (v === null || v === undefined) {
        nullCount++;
      } else {
        data[i] = v;
        const byteIdx = i >> 3;
        // biome-ignore lint/style/noNonNullAssertion: bitmap is sized for len
        nullBitmap[byteIdx] = (nullBitmap[byteIdx] ?? 0) | (1 << (i & 7));
      }
    }
    return makeData({ type, length: len, nullCount, data, nullBitmap });
  }

  function ipcBytesFor(rows: ReadonlyArray<Record<string, unknown>>): {
    schema: Uint8Array;
    batch: Uint8Array;
  } {
    const batch = buildBatch(rows);
    const table = new Table([batch]);
    const ipc = tableToIPC(table, 'stream');
    const messages = splitIpcMessages(ipc);
    /* node:coverage ignore next 4 */
    if (messages.length < 2) {
      throw new Error(`Expected schema + batch in IPC stream; got ${messages.length} messages`);
    }
    return { schema: messages[0] as Uint8Array, batch: messages[1] as Uint8Array };
  }

  // Schema-only IPC: emit a single empty batch and keep just the schema bytes.
  const empty = ipcBytesFor([]);

  return {
    schema,
    schemaIpcBytes: empty.schema,
    encodeBatch(rows) {
      if (rows.length === 0) {
        return ipcBytesFor([]).batch;
      }
      return ipcBytesFor(rows).batch;
    },
  };
}

/**
 * DuckDB row → Avro binary block encoder for the Storage Read API.
 *
 * Two responsibilities, kept in one file because they're tightly coupled:
 *   1. `avroSelectExpression(column, field)` — the SQL projection cast
 *      that gets DuckDB to hand back a value we can convert to Avro.
 *      Diverges from `bqSelectExpression` because the BQ-wire form
 *      (base64 BYTES, "HH:MM:SS" TIME) is the wrong shape for Avro.
 *   2. `createAvroRowEncoder(schemaJson, fields)` — wraps `avsc`'s
 *      `Type.forSchema` with a per-field `duckValue -> avroValue`
 *      converter that handles DATE/TIME/TIMESTAMP/NUMERIC logical
 *      types and STRUCT/REPEATED nesting.
 */

import avsc from 'avsc';

import { quoteIdent } from '../routes/tables.ts';
import type { BqField, BqType } from '../storage/types.ts';

/**
 * The SQL projection for one column when the destination is Avro
 * binary. Different from `bqSelectExpression` because Avro wants raw
 * bytes for BYTES (not base64), microseconds for TIME (not the
 * `HH:MM:SS` string), and full-precision strings for NUMERIC.
 */
export function avroSelectExpression(column: string, field: BqField): string {
  const ident = quoteIdent(column);
  if (field.mode === 'REPEATED') return ident;
  switch (field.type) {
    case 'TIME':
      // `epoch_us(t)` doesn't exist for TIME; the canonical extract is
      // hour*3600e6 + minute*60e6 + second*1e6 + microsecond.
      return `(date_part('hour', ${ident})::BIGINT * 3600000000 + date_part('minute', ${ident})::BIGINT * 60000000 + date_part('microsecond', ${ident})::BIGINT)`;
    case 'GEOGRAPHY':
      return `replace(ST_AsText(${ident}), ' (', '(')`;
    case 'NUMERIC':
    case 'BIGNUMERIC':
      return `${ident}::VARCHAR`;
    case 'TIMESTAMP':
      return `epoch_us(${ident})::BIGINT`;
    case 'DATETIME':
      // BQ encodes DATETIME as an ISO string in Avro (not micros). Use
      // strftime with up to microsecond precision; the `%f` directive is
      // microseconds in DuckDB.
      return `strftime(${ident}, '%Y-%m-%dT%H:%M:%S.%f')`;
    case 'DATE':
      // Days since epoch as an int.
      return `date_diff('day', DATE '1970-01-01', ${ident})::INTEGER`;
    default:
      return ident;
  }
}

/**
 * Two's-complement big-endian encoding of a JS bigint at a fixed byte
 * width. Avro's decimal logical type spec allows "shortest possible
 * bytes," but real BQ pads to the precision-implied storage width
 * (NUMERIC → 16 bytes, BIGNUMERIC → 32 bytes), so match that.
 */
function bigIntToTwosComplementBytes(value: bigint, byteWidth: number): Buffer {
  const mod = 1n << BigInt(byteWidth * 8);
  const unsigned = value < 0n ? mod + value : value;
  const hex = unsigned.toString(16).padStart(byteWidth * 2, '0');
  return Buffer.from(hex, 'hex');
}

/** Byte widths real BQ uses for the decimal Avro logical type. */
const NUMERIC_WIDTH = 16;
const BIGNUMERIC_WIDTH = 32;

/** Parse a decimal string ("123.45") into an unscaled bigint at the given scale. */
function decimalStringToUnscaled(decimal: string, scale: number): bigint {
  const negative = decimal.startsWith('-');
  const abs = negative ? decimal.slice(1) : decimal;
  const [intPart, fracPart = ''] = abs.split('.');
  const padded = fracPart.padEnd(scale, '0').slice(0, scale);
  const combined = `${intPart ?? '0'}${padded}`;
  // Drop a leading "+" or other garbage by trusting that intPart already only
  // contains digits — `Number.parseInt` would lose precision so use BigInt.
  const bi = BigInt(combined);
  return negative ? -bi : bi;
}

interface FieldConverter {
  readonly name: string;
  /** Convert a DuckDB-returned JS value to the JS form `avsc` expects. */
  convert(value: unknown): unknown;
}

function scalarConverter(type: BqType): (value: unknown) => unknown {
  switch (type) {
    case 'STRING':
    case 'JSON':
    case 'GEOGRAPHY':
    case 'INTERVAL':
      return (v) => (typeof v === 'string' ? v : String(v));
    case 'BYTES':
      return (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v as Uint8Array));
    case 'INT64':
      // avsc's default LongType only accepts JS numbers (the safe-integer
      // range). Convert from DuckDB's bigint here. Past 2^53 we'd need to
      // wire a custom AbstractLongType — fine for the emulator's typical
      // workloads, callers needing big int64s can ask later.
      return (v) => Number(v);
    case 'FLOAT64':
      return (v) => Number(v);
    case 'BOOL':
      return (v) => Boolean(v);
    case 'DATE':
      // We projected to "days since 1970-01-01" as INTEGER; avsc wants a number.
      return (v) => Number(v);
    case 'TIMESTAMP':
      // Projected to micros since epoch as BIGINT; convert to Number.
      // 2^53 µs = year 2255 — comfortably outside the BQ-relevant range.
      return (v) => Number(v);
    case 'DATETIME':
      // Projected to an ISO string by `avroSelectExpression`; pass through.
      return (v) => (typeof v === 'string' ? v : String(v));
    case 'TIME':
      // Micros since midnight: max 86.4e9, well within safe-integer range.
      return (v) => Number(v);
    case 'NUMERIC':
      // Avro decimal(38,9): unscaled bigint × 10^9 → fixed 16-byte
      // two's-complement bytes (real BQ pads to the storage width).
      return (v) =>
        bigIntToTwosComplementBytes(decimalStringToUnscaled(String(v), 9), NUMERIC_WIDTH);
    case 'BIGNUMERIC':
      return (v) =>
        bigIntToTwosComplementBytes(decimalStringToUnscaled(String(v), 38), BIGNUMERIC_WIDTH);
    case 'RANGE':
      return (v) => (typeof v === 'string' ? v : JSON.stringify(v));
    case 'STRUCT':
      // Handled by buildConverter, not here.
      throw new Error('STRUCT scalar converter requested — internal error');
  }
}

function buildConverter(field: BqField): FieldConverter {
  const inner = field.type === 'STRUCT' ? buildStructConverter(field) : scalarConverter(field.type);

  if (field.mode === 'REPEATED') {
    return {
      name: field.name,
      convert(value) {
        if (value === null || value === undefined) return [];
        if (!Array.isArray(value)) {
          throw new Error(`Expected array for REPEATED field "${field.name}"`);
        }
        return value.map((item) => inner(item));
      },
    };
  }
  if (field.mode === 'REQUIRED') {
    return { name: field.name, convert: inner };
  }
  // NULLABLE: schema is union [null, T]. avsc accepts either the raw value
  // or `{ <typeName>: value }` for the typed branch. The raw value works for
  // unambiguous unions like [null, T].
  return {
    name: field.name,
    convert(value) {
      if (value === null || value === undefined) return null;
      return inner(value);
    },
  };
}

function buildStructConverter(field: BqField): (value: unknown) => unknown {
  const subs = (field.fields ?? []).map(buildConverter);
  return (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Expected object for STRUCT field "${field.name}"`);
    }
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const sub of subs) {
      out[sub.name] = sub.convert(obj[sub.name]);
    }
    return out;
  };
}

export interface AvroRowEncoder {
  /** Encode one DuckDB row into Avro binary bytes. */
  encodeRow(row: Record<string, unknown>): Buffer;
  /** Encode a batch into a single concatenated buffer (the BQ Storage
   * `AvroRows.serialized_binary_rows` format). */
  encodeBatch(rows: ReadonlyArray<Record<string, unknown>>): Buffer;
}

export function createAvroRowEncoder(
  schemaJson: string,
  fields: readonly BqField[],
): AvroRowEncoder {
  const type = avsc.Type.forSchema(JSON.parse(schemaJson), {
    // BL-117's Avro schema doesn't use named logical types beyond what
    // avsc handles natively (date / time-micros / timestamp-micros /
    // decimal). We don't need custom logical-type classes here because we
    // hand avsc already-converted JS values (numbers / bigints / buffers).
    logicalTypes: {},
  });
  const converters = fields.map(buildConverter);

  function rowToAvro(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const c of converters) {
      out[c.name] = c.convert(row[c.name]);
    }
    return out;
  }

  return {
    encodeRow(row) {
      return type.toBuffer(rowToAvro(row));
    },
    encodeBatch(rows) {
      if (rows.length === 0) return Buffer.alloc(0);
      const parts = rows.map((r) => type.toBuffer(rowToAvro(r)));
      return Buffer.concat(parts);
    },
  };
}

/**
 * BigQuery TableSchema → Apache Arrow Schema converter for the
 * Storage Read API's ARROW data format (BL-119).
 *
 * The mapping follows what real BQ Storage Read emits — verified by
 * the bq-storage-replay fixtures. In particular:
 *   - INT64 → Int64
 *   - FLOAT64 → Float64
 *   - BOOL → Bool
 *   - STRING / JSON / GEOGRAPHY / INTERVAL → Utf8
 *   - BYTES → Binary
 *   - DATE → Date32 (days)
 *   - TIME → Time64(microseconds)
 *   - TIMESTAMP → Timestamp(microseconds, "UTC")
 *   - DATETIME → Timestamp(microseconds, null)  -- "local" timestamp
 *   - NUMERIC → Decimal128(38, 9)
 *   - BIGNUMERIC → Decimal256(76, 38)
 *   - STRUCT → Struct
 *   - REPEATED → List<T>
 *   - NULLABLE → field's nullable flag (no Avro-style union)
 */

import {
  Binary,
  Bool,
  type DataType,
  DateUnit,
  Date_,
  Decimal,
  Field,
  Float64,
  Int64,
  List,
  Schema,
  Struct,
  Time,
  TimeUnit,
  Timestamp,
  Utf8,
} from 'apache-arrow';

import type { BqField, BqType } from '../storage/types.ts';

function baseArrowType(field: BqField): DataType {
  switch (field.type) {
    case 'STRING':
    case 'JSON':
    case 'GEOGRAPHY':
    case 'INTERVAL':
      return new Utf8();
    case 'BYTES':
      return new Binary();
    case 'INT64':
      return new Int64();
    case 'FLOAT64':
      return new Float64();
    case 'BOOL':
      return new Bool();
    case 'DATE':
      return new Date_(DateUnit.DAY);
    case 'TIME':
      return new Time(TimeUnit.MICROSECOND, 64);
    case 'TIMESTAMP':
      return new Timestamp(TimeUnit.MICROSECOND, 'UTC');
    case 'DATETIME':
      // No time zone = "local" timestamp, matching BQ's DATETIME semantics.
      return new Timestamp(TimeUnit.MICROSECOND, null);
    case 'NUMERIC':
      return new Decimal(9, 38, 128);
    case 'BIGNUMERIC':
      return new Decimal(38, 76, 256);
    case 'RANGE':
      // BQ's Arrow encoding for RANGE is not documented; fall back to a
      // string representation (matches our Avro choice). Refine when a
      // real-BQ capture says otherwise.
      return new Utf8();
    case 'STRUCT':
      return new Struct((field.fields ?? []).map(toArrowField));
  }
}

function toArrowField(field: BqField): Field {
  if (field.mode === 'REPEATED') {
    const inner = baseArrowType(field);
    // Arrow List wraps an "item" field whose nullable flag matches the
    // element nullability. BQ REPEATED items are non-null per spec.
    const itemField = new Field('item', inner, false);
    return new Field(field.name, new List(itemField), false);
  }
  const nullable = field.mode !== 'REQUIRED';
  return new Field(field.name, baseArrowType(field), nullable);
}

export function bqSchemaToArrowSchema(fields: readonly BqField[]): Schema {
  return new Schema(fields.map(toArrowField));
}

/** Re-export the union of supported types so callers can switch on it. */
export type SupportedBqType = BqType;

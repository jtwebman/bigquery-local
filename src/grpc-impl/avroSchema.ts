/**
 * BigQuery TableSchema → Avro JSON schema converter, scoped to what
 * the Storage Read API returns in `ReadSession.avroSchema.schema`.
 *
 * BQ Avro encoding (per the public docs / production traces):
 *   - Top-level is an Avro record named after the table.
 *   - REPEATED columns wrap in `{type: "array", items: ...}`.
 *   - NULLABLE columns become `["null", T]` unions (default `null`).
 *   - REQUIRED columns are the bare type.
 *   - Logical types: timestamp-micros, date, time-micros,
 *     local-timestamp-micros (DATETIME), decimal (NUMERIC/BIGNUMERIC).
 */

import type { BqField } from '../storage/types.ts';

type AvroType = string | AvroPrimitive | AvroRecord | AvroArray | AvroUnion | AvroLogical;

interface AvroPrimitive {
  type: string;
}

interface AvroRecord {
  type: 'record';
  name: string;
  fields: AvroFieldEntry[];
}

interface AvroArray {
  type: 'array';
  items: AvroType;
}

type AvroUnion = AvroType[];

interface AvroLogical {
  type: string;
  logicalType?: string;
  precision?: number;
  scale?: number;
  /** BQ-only marker for JSON columns. */
  sqlType?: string;
}

interface AvroFieldEntry {
  name: string;
  type: AvroType;
  default?: null;
}

/**
 * Counter for nested-struct record names. Real BQ uses `__s_0`,
 * `__s_1`, … in encounter order — passed by reference between calls
 * so a single root walk shares one numbering.
 */
interface StructCounter {
  count: number;
}

function baseAvroType(field: BqField, c: StructCounter): AvroType {
  switch (field.type) {
    case 'STRING':
    case 'GEOGRAPHY':
    case 'INTERVAL':
      return 'string';
    case 'JSON':
      // BQ tags JSON columns with a `sqlType` marker on the Avro string.
      return { type: 'string', sqlType: 'JSON' };
    case 'BYTES':
      return 'bytes';
    case 'INT64':
      return 'long';
    case 'FLOAT64':
      return 'double';
    case 'BOOL':
      return 'boolean';
    case 'NUMERIC':
      return { type: 'bytes', logicalType: 'decimal', precision: 38, scale: 9 };
    case 'BIGNUMERIC':
      // Real BQ emits precision=77 in the Avro schema (storage precision —
      // 77 digits fit in 256-bit two's-complement, even though BQ docs
      // describe the *user-visible* precision as 76).
      return { type: 'bytes', logicalType: 'decimal', precision: 77, scale: 38 };
    case 'TIMESTAMP':
      return { type: 'long', logicalType: 'timestamp-micros' };
    case 'DATETIME':
      // BQ encodes DATETIME as an Avro string (ISO `YYYY-MM-DDTHH:MM:SS[.ffffff]`)
      // with a custom `datetime` logical type, not as the standard
      // `local-timestamp-micros` long.
      return { type: 'string', logicalType: 'datetime' };
    case 'DATE':
      return { type: 'int', logicalType: 'date' };
    case 'TIME':
      return { type: 'long', logicalType: 'time-micros' };
    case 'STRUCT': {
      const name = `__s_${c.count}`;
      c.count += 1;
      return {
        type: 'record',
        name,
        fields: (field.fields ?? []).map((f) => toAvroField(f, c)),
      };
    }
    case 'RANGE':
      return 'string';
  }
}

function toAvroField(field: BqField, c: StructCounter): AvroFieldEntry {
  const base = baseAvroType(field, c);
  if (field.mode === 'REPEATED') {
    return { name: field.name, type: { type: 'array', items: base } };
  }
  if (field.mode === 'REQUIRED') {
    return { name: field.name, type: base };
  }
  // Real BQ Storage Read does *not* emit `default: null` on NULLABLE
  // unions, even though the Avro spec lets it. Stay on the same side.
  return { name: field.name, type: ['null', base] };
}

/**
 * Build the Avro JSON-schema string the Storage Read API returns in
 * `ReadSession.avroSchema.schema` for a given BQ table.
 *
 * Real BQ always uses the literal record name `__root__` at the top
 * level and `__s_0`, `__s_1`, … for nested STRUCT records — matched
 * here so the byte-for-byte conformance suite passes.
 */
export function bqSchemaToAvroJson(_tableName: string, fields: readonly BqField[]): string {
  const c: StructCounter = { count: 0 };
  const record: AvroRecord = {
    type: 'record',
    name: '__root__',
    fields: fields.map((f) => toAvroField(f, c)),
  };
  return JSON.stringify(record);
}

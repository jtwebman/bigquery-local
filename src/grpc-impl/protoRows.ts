/**
 * Storage Write API: `AppendRowsRequest.proto_rows` decoder.
 *
 * Clients send a `WriterSchema.proto_descriptor` (a `DescriptorProto`)
 * on the first message of an `AppendRows` stream, then one or more
 * `serialized_rows[]` byte buffers that decode against that descriptor.
 * This module turns the descriptor into a runtime `protobufjs.Type`
 * we can call `decode()` on, plus a per-field converter from the
 * proto-decoded JS value to the form `bqValueToDuck` expects.
 *
 * Supported FieldDescriptorProto types for BL-122 (default stream
 * happy path): all scalar types plus repeated. Logical-type wrinkles
 * (TIMESTAMP-as-int64-micros, DATE-as-int32-days, NUMERIC-as-bytes,
 * STRUCT/message) work as long as the wire format is the canonical BQ
 * Storage Write encoding.
 */

import protobuf from 'protobufjs';

import type { BqField, BqType } from '../storage/types.ts';

/**
 * FieldDescriptorProto.Type → protobufjs type-name. The proto enum
 * arrives as either a numeric tag (1..18) or the symbolic name
 * (`TYPE_INT64`, …) depending on the request decoder's `enums`
 * option, so handle both forms.
 */
const TYPE_BY_NUMBER: Readonly<Record<number, string>> = {
  1: 'double',
  2: 'float',
  3: 'int64',
  4: 'uint64',
  5: 'int32',
  6: 'fixed64',
  7: 'fixed32',
  8: 'bool',
  9: 'string',
  12: 'bytes',
  13: 'uint32',
  15: 'sfixed32',
  16: 'sfixed64',
  17: 'sint32',
  18: 'sint64',
};

const TYPE_BY_NAME: Readonly<Record<string, string>> = {
  TYPE_DOUBLE: 'double',
  TYPE_FLOAT: 'float',
  TYPE_INT64: 'int64',
  TYPE_UINT64: 'uint64',
  TYPE_INT32: 'int32',
  TYPE_FIXED64: 'fixed64',
  TYPE_FIXED32: 'fixed32',
  TYPE_BOOL: 'bool',
  TYPE_STRING: 'string',
  TYPE_BYTES: 'bytes',
  TYPE_UINT32: 'uint32',
  TYPE_SFIXED32: 'sfixed32',
  TYPE_SFIXED64: 'sfixed64',
  TYPE_SINT32: 'sint32',
  TYPE_SINT64: 'sint64',
};

const LABEL_REPEATED_VALUES = new Set<number | string>([3, 'LABEL_REPEATED']);

function protoTypeName(type: number | string, typeName: string | undefined): string {
  if (typeof type === 'number') {
    if (type === 11) return typeName ?? 'bytes'; // MESSAGE
    if (type === 14) return typeName ?? 'int32'; // ENUM
    const mapped = TYPE_BY_NUMBER[type];
    if (mapped !== undefined) return mapped;
    throw new Error(`Unsupported FieldDescriptorProto.Type ${type}`);
  }
  if (type === 'TYPE_MESSAGE') return typeName ?? 'bytes';
  if (type === 'TYPE_ENUM') return typeName ?? 'int32';
  const mapped = TYPE_BY_NAME[type];
  if (mapped !== undefined) return mapped;
  throw new Error(`Unsupported FieldDescriptorProto.Type ${type}`);
}

interface RawFieldDescriptor {
  name?: string;
  number?: number;
  type?: number | string;
  typeName?: string;
  label?: number | string;
}

interface RawNestedDescriptor {
  name?: string;
  field?: readonly RawFieldDescriptor[];
  nestedType?: readonly RawNestedDescriptor[];
}

interface ProtoNamespace {
  [name: string]: {
    fields: Record<string, { type: string; id: number; rule?: 'repeated' | 'required' }>;
    nested?: ProtoNamespace;
  };
}

function descriptorToJsonNamespace(desc: RawNestedDescriptor): ProtoNamespace {
  const name = desc.name ?? 'Row';
  const fields: Record<string, { type: string; id: number; rule?: 'repeated' | 'required' }> = {};
  for (const f of desc.field ?? []) {
    if (f.name === undefined || f.number === undefined || f.type === undefined) {
      throw new Error('FieldDescriptorProto missing name/number/type');
    }
    const entry: { type: string; id: number; rule?: 'repeated' | 'required' } = {
      type: protoTypeName(f.type, f.typeName),
      id: f.number,
    };
    if (f.label !== undefined && LABEL_REPEATED_VALUES.has(f.label)) {
      entry.rule = 'repeated';
    }
    fields[f.name] = entry;
  }
  const out: ProtoNamespace = { [name]: { fields } };
  if (desc.nestedType !== undefined && desc.nestedType.length > 0) {
    let nested: ProtoNamespace = {};
    for (const n of desc.nestedType) {
      Object.assign(nested, descriptorToJsonNamespace(n));
    }
    out[name] = { ...out[name], fields, nested } as ProtoNamespace[string];
  }
  return out;
}

/**
 * Compile a `DescriptorProto` (the writer schema) into a protobufjs
 * Type that we can call `decode()` on for each `serialized_rows[i]`.
 */
export function compileWriterSchema(descriptor: RawNestedDescriptor): protobuf.Type {
  const name = descriptor.name ?? 'Row';
  const root = protobuf.Root.fromJSON({ nested: descriptorToJsonNamespace(descriptor) });
  return root.lookupType(name);
}

/** Convert a single decoded proto field value to the BQ-wire shape
 *  `bqValueToDuck` expects. Operates per-field — REPEATED handled by
 *  the caller (it just maps over the array). */
function protoToBqValue(value: unknown, field: BqField): unknown {
  if (value === null || value === undefined) return null;
  switch (field.type) {
    case 'STRING':
    case 'JSON':
    case 'GEOGRAPHY':
    case 'INTERVAL':
      return typeof value === 'string' ? value : String(value);
    case 'BYTES':
      // proto bytes are decoded as Uint8Array; BQ wire is base64.
      if (typeof value === 'string') return value;
      return Buffer.from(value as Uint8Array).toString('base64');
    case 'INT64': {
      // protobufjs decodes int64 as Long (a {low, high, unsigned} object)
      // unless configured otherwise. Convert to a decimal string.
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'bigint') return String(value);
      return String((value as { toString(): string }).toString());
    }
    case 'FLOAT64':
      return Number(value);
    case 'BOOL':
      return value === true || value === 'true';
    case 'NUMERIC':
    case 'BIGNUMERIC':
      // BQ Storage Write encodes NUMERIC as a proto string (or bytes
      // with decimal encoding — we accept either).
      return typeof value === 'string' ? value : String(value);
    case 'TIMESTAMP':
    case 'DATETIME':
      // proto int64 µs since epoch → BQ wire micros-as-decimal-string.
      return typeof value === 'string' ? value : String(value);
    case 'DATE': {
      // proto int32 days since epoch → BQ wire `YYYY-MM-DD` string.
      const days = Number(value);
      return new Date(days * 86_400_000).toISOString().slice(0, 10);
    }
    case 'TIME':
      // proto int64 µs since midnight → BQ wire `HH:MM:SS.SSSSSS`.
      return microsToTimeString(value);
    case 'STRUCT': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`STRUCT field "${field.name}" expects an object`);
      }
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const sub of field.fields ?? []) {
        out[sub.name] = convertField(obj[sub.name], sub);
      }
      return out;
    }
    case 'RANGE':
      return typeof value === 'string' ? value : JSON.stringify(value);
  }
}

function microsToTimeString(value: unknown): string {
  const micros = Number(typeof value === 'string' ? value : (value as number | bigint));
  const totalSec = Math.floor(micros / 1_000_000);
  const us = micros - totalSec * 1_000_000;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const hh = h.toString().padStart(2, '0');
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  if (us === 0) return `${hh}:${mm}:${ss}`;
  return `${hh}:${mm}:${ss}.${us.toString().padStart(6, '0')}`;
}

/** Handle REPEATED + scalar conversion for one field. */
export function convertField(value: unknown, field: BqField): unknown {
  if (value === null || value === undefined) return null;
  if (field.mode === 'REPEATED') {
    if (!Array.isArray(value)) {
      throw new Error(`REPEATED field "${field.name}" expects array, got ${typeof value}`);
    }
    const innerField: BqField = { ...field, mode: 'NULLABLE' };
    return value.map((item) => protoToBqValue(item, innerField));
  }
  return protoToBqValue(value, field);
}

/**
 * Convert a whole decoded proto message (one row) into the values
 * array passed as ordered SQL parameters to the table's INSERT.
 */
export function protoRowToValues(
  row: Record<string, unknown>,
  fields: readonly BqField[],
): unknown[] {
  return fields.map((f) => convertField(row[f.name], f));
}

// Re-export the runtime BqType union so callers can type-check.
export type { BqType };

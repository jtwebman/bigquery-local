/**
 * BigQuery ↔ DuckDB type translation.
 *
 * Three layers, used by every route that touches user data:
 *
 *   1. `bqTypeToDuck(field)`             — DuckDB column type expression for
 *                                          `CREATE TABLE` / `ALTER TABLE`.
 *   2. `bqInsertExpression(n, field)`    — SQL placeholder + the casts /
 *                                          conversions needed to bind a JS
 *                                          value into the column. Examples:
 *                                          `$1`, `$1::DATE`, `from_base64($1)`,
 *                                          `$1::JSON::INTEGER[]`.
 *      `bqSelectExpression(col, field)`  — SQL projection wrapper for reads
 *                                          (e.g. `to_base64("v")` for BYTES).
 *   3. `bqValueToDuck(v, field)` /
 *      `duckValueToBq(v, field)`         — JS value encoding/decoding.
 *
 * Row-level wrappers (`bqRowToDuck`, `duckRowToBq`) just iterate the schema.
 * The inverse `duckTypeToBq(type, name)` synthesizes a `BqField` from a
 * DuckDB type string and is used when emitting result schemas for ad-hoc
 * SQL queries.
 *
 * **BQ wire-format conventions** for values flowing in/out:
 *   - INT64           string (e.g. `"123"`) — JSON loses precision past 2^53
 *   - FLOAT64         number
 *   - BOOL            boolean
 *   - STRING          string
 *   - BYTES           base64-encoded string
 *   - NUMERIC/BIGNUMERIC  decimal string (e.g. `"123.456"`)
 *   - TIMESTAMP       ISO-8601 string (e.g. `"2026-05-16T10:11:12Z"`)
 *   - DATETIME        ISO-8601 without TZ (e.g. `"2026-05-16T10:11:12"`)
 *   - DATE            `"YYYY-MM-DD"`
 *   - TIME            `"HH:MM:SS[.SSSSSS]"`
 *   - JSON            any JSON value (object / array / scalar)
 *   - GEOGRAPHY       WKT string (no `ST_*` in v0)
 *   - REPEATED mode   array of T-typed values
 *   - STRUCT          object with field names as keys
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BqMode = 'NULLABLE' | 'REQUIRED' | 'REPEATED';

export type BqType =
  | 'STRING'
  | 'BYTES'
  | 'INT64'
  | 'FLOAT64'
  | 'BOOL'
  | 'NUMERIC'
  | 'BIGNUMERIC'
  | 'TIMESTAMP'
  | 'DATETIME'
  | 'DATE'
  | 'TIME'
  | 'JSON'
  | 'GEOGRAPHY'
  | 'STRUCT';

export interface BqField {
  readonly name: string;
  readonly type: BqType;
  readonly mode?: BqMode;
  readonly description?: string;
  readonly fields?: readonly BqField[];
}

const TYPE_ALIASES: Readonly<Record<string, BqType>> = {
  STRING: 'STRING',
  BYTES: 'BYTES',
  INT64: 'INT64',
  INTEGER: 'INT64',
  FLOAT64: 'FLOAT64',
  FLOAT: 'FLOAT64',
  BOOL: 'BOOL',
  BOOLEAN: 'BOOL',
  NUMERIC: 'NUMERIC',
  BIGNUMERIC: 'BIGNUMERIC',
  TIMESTAMP: 'TIMESTAMP',
  DATETIME: 'DATETIME',
  DATE: 'DATE',
  TIME: 'TIME',
  JSON: 'JSON',
  GEOGRAPHY: 'GEOGRAPHY',
  STRUCT: 'STRUCT',
  RECORD: 'STRUCT',
};

/** Normalize BigQuery type aliases (e.g. `INTEGER` → `INT64`). */
export function normalizeBqType(raw: string): BqType {
  const upper = raw.toUpperCase();
  const mapped = TYPE_ALIASES[upper];
  if (mapped === undefined) {
    throw new Error(`Unknown BigQuery type "${raw}".`);
  }
  return mapped;
}

/**
 * Map the internal standard-SQL type name to the legacy wire name BQ's
 * REST API actually returns in tables/jobs/getQueryResults responses.
 *
 * The Go client (cloud.google.com/go/bigquery) parses value strings with
 * a switch on the legacy constants only (`INTEGER`, `FLOAT`, `BOOLEAN`,
 * `RECORD`), so emitting the standard names here would break it. Python
 * and Node normalize both forms.
 */
export function bqTypeToWire(type: BqType): string {
  switch (type) {
    case 'INT64':
      return 'INTEGER';
    case 'FLOAT64':
      return 'FLOAT';
    case 'BOOL':
      return 'BOOLEAN';
    case 'STRUCT':
      return 'RECORD';
    default:
      return type;
  }
}

/**
 * BigQuery `data_type` string for a field, as it appears in
 * `INFORMATION_SCHEMA.COLUMNS.data_type`. STRUCT fields render with their
 * full child list (`STRUCT<city STRING, zip STRING>`); REPEATED mode wraps
 * the base type as `ARRAY<…>`.
 */
export function renderBqType(field: BqField): string {
  const base = renderBaseBqType(field);
  return field.mode === 'REPEATED' ? `ARRAY<${base}>` : base;
}

function renderBaseBqType(field: BqField): string {
  if (field.type !== 'STRUCT') return field.type;
  const children = field.fields ?? [];
  if (children.length === 0) return 'STRUCT';
  const inner = children.map((f) => `${f.name} ${renderBqType(f)}`).join(', ');
  return `STRUCT<${inner}>`;
}

// ---------------------------------------------------------------------------
// DuckDB column type for CREATE TABLE / ALTER TABLE
// ---------------------------------------------------------------------------

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function baseDuckType(field: BqField): string {
  switch (field.type) {
    case 'STRING':
      return 'VARCHAR';
    case 'BYTES':
      return 'BLOB';
    case 'INT64':
      return 'BIGINT';
    case 'FLOAT64':
      return 'DOUBLE';
    case 'BOOL':
      return 'BOOLEAN';
    case 'NUMERIC':
      return 'DECIMAL(38, 9)';
    case 'BIGNUMERIC':
      // DuckDB DECIMAL caps at 38 precision; store as VARCHAR to round-trip
      // the full BIGNUMERIC range losslessly.
      return 'VARCHAR';
    case 'TIMESTAMP':
      return 'TIMESTAMP WITH TIME ZONE';
    case 'DATETIME':
      return 'TIMESTAMP';
    case 'DATE':
      return 'DATE';
    case 'TIME':
      return 'TIME';
    case 'JSON':
      return 'JSON';
    case 'GEOGRAPHY':
      // WKT in VARCHAR until BL-128+ wires the spatial extension.
      return 'VARCHAR';
    case 'STRUCT': {
      if (field.fields === undefined || field.fields.length === 0) {
        throw new Error(`STRUCT field "${field.name}" requires a non-empty fields list.`);
      }
      const inner = field.fields.map((f) => `${quoteIdent(f.name)} ${bqTypeToDuck(f)}`).join(', ');
      return `STRUCT(${inner})`;
    }
  }
}

/** DuckDB column type for `CREATE TABLE` / `ALTER TABLE`. REPEATED mode
 * appends `[]` (DuckDB LIST). */
export function bqTypeToDuck(field: BqField): string {
  const base = baseDuckType(field);
  return field.mode === 'REPEATED' ? `${base}[]` : base;
}

// ---------------------------------------------------------------------------
// INSERT placeholder + casts
// ---------------------------------------------------------------------------

function baseInsertExpr(ordinal: number, field: BqField): string {
  const p = `$${ordinal}`;
  switch (field.type) {
    case 'STRING':
    case 'BIGNUMERIC':
    case 'GEOGRAPHY':
      return p;
    case 'BYTES':
      // We bind base64-encoded strings; from_base64() turns them into BLOB.
      return `from_base64(${p})`;
    case 'INT64':
      // JS bigint binds as HUGEINT; explicit cast to BIGINT.
      return `${p}::BIGINT`;
    case 'FLOAT64':
      return `${p}::DOUBLE`;
    case 'BOOL':
      return p;
    case 'NUMERIC':
      return `${p}::DECIMAL(38, 9)`;
    case 'TIMESTAMP':
      return `${p}::TIMESTAMPTZ`;
    case 'DATETIME':
      return `${p}::TIMESTAMP`;
    case 'DATE':
      return `${p}::DATE`;
    case 'TIME':
      return `${p}::TIME`;
    case 'JSON':
      return `${p}::JSON`;
    case 'STRUCT':
      // Bound as a JSON-encoded string; DuckDB casts it to the STRUCT type.
      return `${p}::JSON::${baseDuckType(field)}`;
  }
}

/** SQL expression for binding parameter `$ordinal` as this field's column
 * type. Includes casts (`::DATE`, `::TIMESTAMPTZ`, etc.) and conversion
 * functions (`from_base64`) where needed. REPEATED arrays bind as
 * JSON-encoded strings and cast to `T[]`. */
export function bqInsertExpression(ordinal: number, field: BqField): string {
  if (field.mode === 'REPEATED') {
    // The base type already handles its own casting/conversion for a single
    // value; for the REPEATED case we always go through JSON, so use the
    // base DuckDB type for the final cast.
    return `$${ordinal}::JSON::${baseDuckType(field)}[]`;
  }
  return baseInsertExpr(ordinal, field);
}

// ---------------------------------------------------------------------------
// SELECT projection
// ---------------------------------------------------------------------------

/** SQL projection expression for reading a column back out. Wraps the
 * column in `to_base64()` for BYTES (so we get a wire-format string), and
 * leaves everything else as-is — `getRowObjectsJS()` returns sensible JS
 * forms for the rest, which `duckValueToBq` then normalizes. */
export function bqSelectExpression(column: string, field: BqField): string {
  const ident = quoteIdent(column);
  if (field.mode === 'REPEATED') return ident;
  if (field.type === 'BYTES') return `to_base64(${ident})`;
  if (field.type === 'TIME') return `${ident}::VARCHAR`;
  return ident;
}

// ---------------------------------------------------------------------------
// Value encoding (BQ wire → DuckDB bind value)
// ---------------------------------------------------------------------------

export function bqValueToDuck(value: unknown, field: BqField): unknown {
  if (value === null || value === undefined) return null;
  if (field.mode === 'REPEATED') {
    if (!Array.isArray(value)) {
      throw new Error(`Expected array for REPEATED field "${field.name}".`);
    }
    // Encode each item via the JSON-safe encoder so we can JSON-stringify the
    // whole list. Using bqValueToDuckLeaf here would (a) return bigints for
    // INT64 (unserializable) and (b) double-stringify STRUCT elements.
    const innerField: BqField = { ...field, mode: 'NULLABLE' };
    return JSON.stringify(value.map((item) => structuredEncodeForJson(item, innerField)));
  }
  return bqValueToDuckLeaf(value, field);
}

function bqValueToDuckLeaf(value: unknown, field: BqField): unknown {
  if (value === null || value === undefined) return null;
  switch (field.type) {
    case 'STRING':
    case 'BIGNUMERIC':
    case 'GEOGRAPHY':
    case 'NUMERIC':
    case 'DATE':
    case 'TIME':
    case 'DATETIME':
    case 'TIMESTAMP':
      // Bind as string; DuckDB casts in SQL.
      return String(value);
    case 'BYTES':
      // Already a base64 string in BQ wire; SQL wraps with from_base64().
      return String(value);
    case 'INT64':
      return typeof value === 'bigint' ? value : BigInt(String(value));
    case 'FLOAT64':
      return Number(value);
    case 'BOOL':
      // `Boolean("false")` is `true` because non-empty strings are
      // truthy; honor CSV / BQ-wire conventions where boolean values
      // arrive as the literal strings "true" / "false" (case-insensitive).
      if (typeof value === 'string') {
        const lower = value.toLowerCase();
        if (lower === 'true') return true;
        if (lower === 'false') return false;
      }
      return Boolean(value);
    case 'JSON':
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'STRUCT': {
      // Encode each field, JSON-stringify the whole object. SQL casts to STRUCT.
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Expected object for STRUCT field "${field.name}".`);
      }
      if (field.fields === undefined) {
        throw new Error(`STRUCT field "${field.name}" requires a non-empty fields list.`);
      }
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const f of field.fields) {
        const v = obj[f.name];
        out[f.name] = v === undefined ? null : structuredEncodeForJson(v, f);
      }
      return JSON.stringify(out);
    }
  }
}

/** Same as bqValueToDuck but for use inside a JSON-encoded structure
 * (REPEATED items, STRUCT field values). The values returned go through
 * JSON.stringify by the caller, so we produce JSON-friendly forms
 * (strings, numbers, booleans, nested arrays/objects). */
function structuredEncodeForJson(value: unknown, field: BqField): unknown {
  if (value === null || value === undefined) return null;
  if (field.mode === 'REPEATED') {
    if (!Array.isArray(value)) {
      throw new Error(`Expected array for REPEATED field "${field.name}".`);
    }
    const innerField: BqField = { ...field, mode: 'NULLABLE' };
    return value.map((item) => structuredEncodeForJson(item, innerField));
  }
  switch (field.type) {
    case 'STRING':
    case 'BIGNUMERIC':
    case 'GEOGRAPHY':
    case 'NUMERIC':
    case 'DATE':
    case 'TIME':
    case 'DATETIME':
    case 'TIMESTAMP':
    case 'BYTES':
      return String(value);
    case 'INT64':
      // Inside JSON we lose bigint, so keep as decimal string.
      return typeof value === 'bigint' ? value.toString(10) : String(value);
    case 'FLOAT64':
      return Number(value);
    case 'BOOL':
      return Boolean(value);
    case 'JSON':
      return typeof value === 'string' ? JSON.parse(value) : value;
    case 'STRUCT': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Expected object for STRUCT field "${field.name}".`);
      }
      if (field.fields === undefined) {
        throw new Error(`STRUCT field "${field.name}" requires a non-empty fields list.`);
      }
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const f of field.fields) {
        const v = obj[f.name];
        out[f.name] = v === undefined ? null : structuredEncodeForJson(v, f);
      }
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Value decoding (DuckDB getRowObjectsJS → BQ wire)
// ---------------------------------------------------------------------------

/**
 * BigQuery wire encoding: every `rows[i].f[j].v` is a JSON value, but for
 * scalars BQ always uses a string (so INT64 / FLOAT64 / BOOL / NUMERIC /
 * TIMESTAMP / etc. survive precision loss in JSON). NULL is JSON null.
 * Arrays and structs wrap each element / field in the same `{v}` / `{f}`
 * envelope recursively.
 *
 * Refs:
 *  - https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query#response-body
 *  - https://cloud.google.com/bigquery/docs/reference/standard-sql/data-types
 *  - Discovery doc `TableCell.v: any` + Int64Value pattern used across the
 *    same response.
 */
export function duckValueToBq(value: unknown, field: BqField): unknown {
  if (value === null || value === undefined) return null;
  if (field.mode === 'REPEATED') {
    if (!Array.isArray(value)) {
      throw new Error(`Expected array from DuckDB for REPEATED field "${field.name}".`);
    }
    // Each array element is itself an `{ "v": ... }` cell — same envelope
    // as top-level row cells. Element NULLs render as `{"v": null}`.
    const innerField: BqField = { ...field, mode: 'NULLABLE' };
    return value.map((item) => ({ v: duckValueToBq(item, innerField) }));
  }
  switch (field.type) {
    case 'STRING':
    case 'BIGNUMERIC':
    case 'GEOGRAPHY':
      return typeof value === 'string' ? value : String(value);
    case 'BYTES':
      // `to_base64()` in SELECT means we get a string back already.
      return typeof value === 'string'
        ? value
        : Buffer.from(value as Uint8Array).toString('base64');
    case 'INT64':
      return typeof value === 'bigint' ? value.toString(10) : String(value);
    case 'FLOAT64':
      return floatToWire(value);
    case 'BOOL':
      // BQ wire format encodes booleans as the literal strings "true" /
      // "false" — not JSON booleans. The client libs depend on this.
      return value ? 'true' : 'false';
    case 'NUMERIC':
      // DuckDB returns DECIMAL as a number (small) or a stringFromDecimal-style
      // string; getRowObjectsJS coerces to number when it fits, string when not.
      return typeof value === 'number' ? trimDecimal(value.toString()) : String(value);
    case 'TIMESTAMP':
      // BQ's modern default (when the client sets `useInt64Timestamp=true`,
      // which the @google-cloud/bigquery client does by default) is
      // microseconds-since-epoch as a decimal Int64Value string. This is
      // also lossless across the 1µs precision DuckDB stores.
      return timestampToWireMicros(value);
    case 'DATETIME':
      // DATETIME has no zone; canonical form is `YYYY-MM-DDTHH:MM:SS[.f]`.
      return datetimeToWire(value);
    case 'DATE':
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      return String(value);
    case 'TIME':
      // DuckDB returns TIME as a string already (no native JS type). BQ
      // canonical is `HH:MM:SS[.ffffff]` — coerce defensively.
      return timeToWire(value);
    case 'JSON':
      // DuckDB JSON columns come back as parsed values OR JSON strings;
      // normalize to a string so callers get consistent BQ wire format.
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'STRUCT': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Expected object from DuckDB for STRUCT field "${field.name}".`);
      }
      if (field.fields === undefined) {
        throw new Error(`STRUCT field "${field.name}" requires a non-empty fields list.`);
      }
      // BQ STRUCT wire shape: `{ "f": [ {"v": …}, {"v": …} ] }` (same
      // envelope as the top-level row). Sub-field order follows the schema.
      const obj = value as Record<string, unknown>;
      const cells = field.fields.map((f) => ({ v: duckValueToBq(obj[f.name], f) }));
      return { f: cells };
    }
  }
}

function floatToWire(value: unknown): string {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Number.POSITIVE_INFINITY) return 'Infinity';
    if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
    // Integer-valued floats need a `.0` suffix so the wire stays
    // distinguishable from INT64 (which is also a decimal string but
    // never has a fractional component).
    return trimDecimal(value.toString());
  }
  return String(value);
}

/** Microseconds-since-epoch as a decimal Int64Value string (the form BQ
 *  emits when `useInt64Timestamp=true`). */
function timestampToWireMicros(value: unknown): string {
  if (value instanceof Date) {
    return String(BigInt(value.getTime()) * 1000n);
  }
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'number') return String(BigInt(value) * 1000n);
  return String(value);
}

function datetimeToWire(value: unknown): string {
  if (value instanceof Date) {
    // DuckDB returns a JS Date for TIMESTAMP types; for DATETIME (which has
    // no zone), drop the trailing Z to match BQ's canonical form.
    return value.toISOString().replace(/Z$/, '');
  }
  return String(value);
}

function timeToWire(value: unknown): string {
  if (value instanceof Date) {
    // DuckDB sometimes returns TIME as a Date pinned to the Unix epoch.
    return value.toISOString().slice(11, 23);
  }
  if (typeof value === 'bigint') {
    // DuckDB returns TIME as microseconds-since-midnight (bigint). Convert
    // to canonical `HH:MM:SS[.ffffff]`.
    const totalUs = value;
    const usPerSecond = 1_000_000n;
    const seconds = totalUs / usPerSecond;
    const us = totalUs % usPerSecond;
    const hours = Number(seconds / 3600n);
    const minutes = Number((seconds % 3600n) / 60n);
    const secs = Number(seconds % 60n);
    const hh = String(hours).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');
    const ss = String(secs).padStart(2, '0');
    if (us === 0n) return `${hh}:${mm}:${ss}`;
    // Drop trailing zeros (BQ canonical: `HH:MM:SS.f` where f is variable
    // length, no padding required).
    const usStr = String(us).padStart(6, '0').replace(/0+$/, '');
    return `${hh}:${mm}:${ss}.${usStr}`;
  }
  return String(value);
}

function trimDecimal(s: string): string {
  // Avoid `"1"` for integer-valued NUMERIC; keep at least one decimal place
  // so the output round-trips as a decimal string.
  if (s.includes('.')) return s;
  return `${s}.0`;
}

// ---------------------------------------------------------------------------
// Row-level wrappers
// ---------------------------------------------------------------------------

/** Encode an entire row in schema field order. Returns an array suitable
 * for passing as parameters to `db.exec(sql, values)`. */
export function bqRowToDuck(
  row: Readonly<Record<string, unknown>>,
  schema: readonly BqField[],
): unknown[] {
  return schema.map((f) => bqValueToDuck(row[f.name], f));
}

/** Decode an entire DuckDB row into a BigQuery wire-shaped object. */
export function duckRowToBq(
  row: Readonly<Record<string, unknown>>,
  schema: readonly BqField[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of schema) {
    out[f.name] = duckValueToBq(row[f.name], f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inverse: DuckDB column type → BqField (for synthesized query schemas)
// ---------------------------------------------------------------------------

const DUCK_TO_BQ: Readonly<Record<string, BqType>> = {
  VARCHAR: 'STRING',
  TEXT: 'STRING',
  BLOB: 'BYTES',
  BYTEA: 'BYTES',
  BIGINT: 'INT64',
  HUGEINT: 'INT64',
  INTEGER: 'INT64',
  INT: 'INT64',
  SMALLINT: 'INT64',
  TINYINT: 'INT64',
  DOUBLE: 'FLOAT64',
  FLOAT: 'FLOAT64',
  REAL: 'FLOAT64',
  BOOLEAN: 'BOOL',
  DATE: 'DATE',
  TIME: 'TIME',
  TIMESTAMP: 'DATETIME',
  'TIMESTAMP WITH TIME ZONE': 'TIMESTAMP',
  TIMESTAMPTZ: 'TIMESTAMP',
  JSON: 'JSON',
};

/** Synthesize a BqField from a DuckDB column type string + a column name.
 * Strips a trailing `[]` (LIST) and sets `mode: 'REPEATED'`. Recognizes
 * `DECIMAL(p,s)` and `STRUCT(...)` syntactically.  */
export function duckTypeToBq(duckType: string, name: string): BqField {
  const trimmed = duckType.trim();
  if (trimmed.endsWith('[]')) {
    const inner = duckTypeToBq(trimmed.slice(0, -2), name);
    return { ...inner, mode: 'REPEATED' };
  }
  const upper = trimmed.toUpperCase();
  if (upper.startsWith('DECIMAL')) {
    return { name, type: 'NUMERIC' };
  }
  if (upper.startsWith('STRUCT(')) {
    return { name, type: 'STRUCT', fields: parseStructFields(trimmed) };
  }
  const mapped = DUCK_TO_BQ[upper];
  if (mapped === undefined) {
    throw new Error(`Unmapped DuckDB type "${duckType}".`);
  }
  return { name, type: mapped };
}

function parseStructFields(structType: string): readonly BqField[] {
  // Parse "STRUCT(name1 type1, name2 type2, ...)" — splits on top-level commas
  // to handle nested STRUCTs/DECIMALs without a full parser.
  const openIdx = structType.indexOf('(');
  if (openIdx === -1 || !structType.endsWith(')')) {
    throw new Error(`Malformed STRUCT type "${structType}".`);
  }
  const body = structType.slice(openIdx + 1, -1).trim();
  if (body === '') return [];
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts.map((part) => {
    // "fieldName fieldType" — split on the first whitespace (or after the first
    // identifier, allowing quoted identifiers).
    let name: string;
    let rest: string;
    if (part.startsWith('"')) {
      const end = part.indexOf('"', 1);
      name = part.slice(1, end);
      rest = part.slice(end + 1).trim();
    } else {
      const space = part.indexOf(' ');
      name = part.slice(0, space);
      rest = part.slice(space + 1).trim();
    }
    return duckTypeToBq(rest, name);
  });
}

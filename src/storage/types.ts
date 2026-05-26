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
 *   - GEOGRAPHY       WKT string in/out, stored as DuckDB GEOMETRY via
 *                     the spatial extension; the full ST_* surface
 *                     (intersects/contains/distance/…) is available.
 *   - INTERVAL        ISO-8601-ish string `"Y-M D H:M:S[.f]"` (e.g.
 *                     `"1-2 3 4:5:6.5"` = 1y 2mo 3d 4h 5m 6.5s; negative
 *                     intervals carry a leading `-` on the whole value)
 *   - RANGE<T>        half-open interval string `"[<start>, <end>)"` where
 *                     each bound is either a literal of element type T
 *                     (DATE / DATETIME / TIMESTAMP) or `UNBOUNDED`.
 *                     Internally stored as `STRUCT(start BIGINT, end
 *                     BIGINT)` with sentinels MIN_I64 / MAX_I64 for
 *                     unbounded ends — every overlap/contains check is
 *                     then a branch-free integer compare.
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
  | 'INTERVAL'
  | 'RANGE'
  | 'STRUCT';

/** Allowed element types for `RANGE<T>` per BigQuery's spec. */
export type RangeElementType = 'DATE' | 'DATETIME' | 'TIMESTAMP';

export interface BqField {
  readonly name: string;
  readonly type: BqType;
  readonly mode?: BqMode;
  readonly description?: string;
  readonly fields?: readonly BqField[];
  /** Element type for `RANGE<T>` fields. Required when `type === 'RANGE'`. */
  readonly rangeElementType?: { readonly type: RangeElementType };
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
  INTERVAL: 'INTERVAL',
  RANGE: 'RANGE',
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
  if (field.type === 'RANGE') {
    const elem = field.rangeElementType?.type ?? 'DATE';
    return `RANGE<${elem}>`;
  }
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
      // DuckDB spatial extension's native geometry type. Loaded at db init.
      return 'GEOMETRY';
    case 'INTERVAL':
      return 'INTERVAL';
    case 'RANGE':
      // STRUCT of two BIGINT bounds; sentinels MIN_I64 / MAX_I64 cover
      // the UNBOUNDED cases without NULL-handling in comparisons.
      return 'STRUCT("start" BIGINT, "end" BIGINT)';
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
      return p;
    case 'GEOGRAPHY':
      return `ST_GeomFromText(${p}::VARCHAR)`;
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
    case 'INTERVAL':
      // Bind the BQ "Y-M D H:M:S" string already pre-translated to a
      // DuckDB-parseable form (see bqValueToDuckLeaf below). DuckDB
      // accepts `INTERVAL '14 months 3 days 14706500 microseconds'`.
      return `${p}::INTERVAL`;
    case 'RANGE':
      // Bound as a JSON-encoded `{start, end}` object; DuckDB casts the
      // JSON into the STRUCT(start BIGINT, end BIGINT) storage shape.
      return `${p}::JSON::STRUCT("start" BIGINT, "end" BIGINT)`;
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
  if (field.type === 'GEOGRAPHY') return `ST_AsText(${ident})`;
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
    case 'INTERVAL':
      // Bind a DuckDB-parseable interval string; SQL wraps with ::INTERVAL.
      return bqIntervalToDuckBindString(String(value));
    case 'RANGE': {
      const { start, end } = bqRangeToBounds(String(value), rangeElementType(field));
      return JSON.stringify({ start: start.toString(), end: end.toString() });
    }
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
    case 'INTERVAL':
      // Inside a JSON envelope, keep the BQ wire form (DuckDB will parse
      // the outer ARRAY[…]::INTERVAL[] cast on the way in).
      return String(value);
    case 'RANGE': {
      const { start, end } = bqRangeToBounds(String(value), rangeElementType(field));
      return { start: start.toString(), end: end.toString() };
    }
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
    case 'INTERVAL':
      return intervalToWire(value);
    case 'RANGE': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`Expected object from DuckDB for RANGE field "${field.name}".`);
      }
      const obj = value as { start?: unknown; end?: unknown };
      const toBig = (v: unknown): bigint => (typeof v === 'bigint' ? v : BigInt(String(v ?? '0')));
      return boundsToBqRange(toBig(obj.start), toBig(obj.end), rangeElementType(field));
    }
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

// ---------------------------------------------------------------------------
// INTERVAL: BQ wire ↔ DuckDB
// ---------------------------------------------------------------------------

/**
 * Parse a BigQuery INTERVAL wire string ("Y-M D H:M:S[.f]", possibly
 * sign-prefixed) into the {months, days, micros} triple DuckDB stores.
 * The sign on the whole string negates all components.
 */
function parseBqInterval(raw: string): { months: bigint; days: bigint; micros: bigint } {
  let s = raw.trim();
  let sign = 1n;
  if (s.startsWith('-')) {
    sign = -1n;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }
  // Tokens: "Y-M", "D", "H:M:S[.f]"
  const parts = s.split(/\s+/);
  if (parts.length !== 3) {
    throw new Error(`Invalid INTERVAL literal "${raw}" — expected "Y-M D H:M:S".`);
  }
  const [ym, d, hms] = parts as [string, string, string];
  const ymMatch = /^(-?\d+)-(-?\d+)$/.exec(ym);
  if (ymMatch === null) {
    throw new Error(`Invalid INTERVAL Y-M component "${ym}" in "${raw}".`);
  }
  const years = BigInt(ymMatch[1] as string);
  const months = BigInt(ymMatch[2] as string);
  const days = BigInt(d);
  const hmsMatch = /^(-?\d+):(-?\d+):(-?\d+)(?:\.(\d{1,6}))?$/.exec(hms);
  if (hmsMatch === null) {
    throw new Error(`Invalid INTERVAL H:M:S component "${hms}" in "${raw}".`);
  }
  const hours = BigInt(hmsMatch[1] as string);
  const minutes = BigInt(hmsMatch[2] as string);
  const seconds = BigInt(hmsMatch[3] as string);
  const fracStr = (hmsMatch[4] ?? '').padEnd(6, '0');
  const fracUs = fracStr === '' ? 0n : BigInt(fracStr);
  const micros = ((hours * 3600n + minutes * 60n + seconds) * 1_000_000n + fracUs) * sign;
  return {
    months: (years * 12n + months) * sign,
    days: days * sign,
    micros,
  };
}

/** Format DuckDB's {months, days, micros} interval back to BQ wire format. */
function formatBqInterval(months: bigint, days: bigint, micros: bigint): string {
  // BQ canonical form pulls the overall sign out front when every
  // non-zero component shares the same sign. If signs are mixed (e.g.
  // 1 month + -1 day) we keep per-component signs — that's still a
  // valid BQ INTERVAL literal.
  const allNonPositive =
    months <= 0n && days <= 0n && micros <= 0n && (months < 0n || days < 0n || micros < 0n);
  const sign = allNonPositive ? -1n : 1n;
  const M = months * sign;
  const D = days * sign;
  const U = micros * sign;
  const years = M / 12n;
  const monthsRem = M - years * 12n;
  const usPerHour = 3_600_000_000n;
  const usPerMinute = 60_000_000n;
  const usPerSecond = 1_000_000n;
  const hours = U / usPerHour;
  let rest = U - hours * usPerHour;
  const minutes = rest / usPerMinute;
  rest -= minutes * usPerMinute;
  const seconds = rest / usPerSecond;
  const frac = rest - seconds * usPerSecond;
  let fracStr = '';
  if (frac !== 0n) {
    fracStr = `.${frac.toString().padStart(6, '0').replace(/0+$/, '')}`;
  }
  const body = `${years}-${monthsRem} ${D} ${hours}:${minutes}:${seconds}${fracStr}`;
  return sign === -1n ? `-${body}` : body;
}

/** Build the DuckDB INTERVAL literal we bind via `$n::INTERVAL`. */
export function bqIntervalToDuckBindString(raw: string): string {
  const { months, days, micros } = parseBqInterval(raw);
  // DuckDB accepts mixed-unit interval strings; quote a `months days
  // microseconds` form to keep precision (microseconds covers H/M/S/f
  // exactly).
  return `${months.toString()} months ${days.toString()} days ${micros.toString()} microseconds`;
}

// ---------------------------------------------------------------------------
// RANGE<T>: BQ wire ↔ {start, end} BIGINT epoch sentinels
// ---------------------------------------------------------------------------

const RANGE_UNBOUNDED_LO = -9223372036854775808n;
const RANGE_UNBOUNDED_HI = 9223372036854775807n;

function rangeElementType(field: BqField): RangeElementType {
  return field.rangeElementType?.type ?? 'DATE';
}

function dateToEpochDays(literal: string): bigint {
  const m = /^(-?\d{1,6})-(\d{2})-(\d{2})$/.exec(literal);
  if (m === null) {
    throw new Error(`Invalid DATE literal "${literal}" for RANGE bound.`);
  }
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return BigInt(Math.floor(ms / 86400000));
}

function epochDaysToDate(days: bigint): string {
  const ms = Number(days) * 86400000;
  const d = new Date(ms);
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function timestampToEpochMicros(literal: string): bigint {
  const trimmed = literal.trim();
  const iso = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso);
  const dateStr = hasZone ? iso : `${iso}Z`;
  const ms = Date.parse(dateStr);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid TIMESTAMP/DATETIME literal "${literal}" for RANGE bound.`);
  }
  const fracMatch = /\.(\d{1,6})/.exec(iso);
  const fracStr = fracMatch !== null ? (fracMatch[1] as string).padEnd(6, '0') : '';
  const fracUs = fracStr === '' ? 0n : BigInt(fracStr.slice(3));
  const baseMs = BigInt(Math.trunc(ms));
  return baseMs * 1000n + fracUs;
}

function epochMicrosToDatetime(us: bigint): string {
  const ms = Number(us / 1000n);
  const remainderUs = us - BigInt(ms) * 1000n;
  const d = new Date(ms);
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const baseMs = d.getUTCMilliseconds();
  const totalUs = baseMs * 1000 + Number(remainderUs);
  const fracStr = totalUs === 0 ? '' : `.${String(totalUs).padStart(6, '0').replace(/0+$/, '')}`;
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${fracStr}`;
}

function epochMicrosToTimestampWire(us: bigint): string {
  return `${epochMicrosToDatetime(us)}+00`;
}

function rangeBoundToEpoch(raw: string, elem: RangeElementType): bigint {
  switch (elem) {
    case 'DATE':
      return dateToEpochDays(raw.trim());
    case 'DATETIME':
    case 'TIMESTAMP':
      return timestampToEpochMicros(raw.trim());
  }
}

function epochToRangeBound(epoch: bigint, elem: RangeElementType): string {
  switch (elem) {
    case 'DATE':
      return epochDaysToDate(epoch);
    case 'DATETIME':
      return epochMicrosToDatetime(epoch);
    case 'TIMESTAMP':
      return epochMicrosToTimestampWire(epoch);
  }
}

export function bqRangeToBounds(
  raw: string,
  elem: RangeElementType,
): { start: bigint; end: bigint } {
  const trimmed = raw.trim();
  const m = /^\[\s*(.*?)\s*,\s*(.*?)\s*\)$/.exec(trimmed);
  if (m === null) {
    throw new Error(`Invalid RANGE literal "${raw}" — expected "[<start>, <end>)".`);
  }
  const startStr = (m[1] as string).trim();
  const endStr = (m[2] as string).trim();
  const start =
    startStr === '' || startStr.toUpperCase() === 'UNBOUNDED' || startStr.toUpperCase() === 'NULL'
      ? RANGE_UNBOUNDED_LO
      : rangeBoundToEpoch(startStr, elem);
  const end =
    endStr === '' || endStr.toUpperCase() === 'UNBOUNDED' || endStr.toUpperCase() === 'NULL'
      ? RANGE_UNBOUNDED_HI
      : rangeBoundToEpoch(endStr, elem);
  return { start, end };
}

export function boundsToBqRange(start: bigint, end: bigint, elem: RangeElementType): string {
  const startStr = start === RANGE_UNBOUNDED_LO ? 'UNBOUNDED' : epochToRangeBound(start, elem);
  const endStr = end === RANGE_UNBOUNDED_HI ? 'UNBOUNDED' : epochToRangeBound(end, elem);
  return `[${startStr}, ${endStr})`;
}

function intervalToWire(value: unknown): string {
  // DuckDB getRowObjectsJS returns INTERVAL as {months, days, micros}.
  if (typeof value === 'object' && value !== null) {
    const v = value as { months?: unknown; days?: unknown; micros?: unknown };
    const months = typeof v.months === 'bigint' ? v.months : BigInt(Number(v.months ?? 0));
    const days = typeof v.days === 'bigint' ? v.days : BigInt(Number(v.days ?? 0));
    const micros = typeof v.micros === 'bigint' ? v.micros : BigInt(Number(v.micros ?? 0));
    return formatBqInterval(months, days, micros);
  }
  // Fallback: if upstream already serialized to a string (DuckDB has no
  // such path today, but defensive).
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
  INTERVAL: 'INTERVAL',
  GEOMETRY: 'GEOGRAPHY',
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

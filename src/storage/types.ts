/**
 * BigQuery ↔ DuckDB type translation. Layers: `bqTypeToDuck` (column type),
 * `bqInsertExpression`/`bqSelectExpression` (SQL casts), `bqValueToDuck`/
 * `duckValueToBq` (JS value encode/decode), plus row wrappers and the inverse
 * `duckTypeToBq` (synthesizes a BqField from a DuckDB type for query schemas).
 *
 * BQ wire conventions — scalars are strings to survive JSON precision loss:
 *   - INT64 / NUMERIC / BIGNUMERIC  decimal string
 *   - FLOAT64 number, BOOL boolean, STRING string
 *   - BYTES           base64 string
 *   - TIMESTAMP       ISO-8601 w/ TZ; DATETIME w/o TZ; DATE `YYYY-MM-DD`;
 *                     TIME `HH:MM:SS[.SSSSSS]`
 *   - JSON            any JSON value
 *   - GEOGRAPHY       WKT string, stored as DuckDB GEOMETRY (spatial ext)
 *   - INTERVAL        `"Y-M D H:M:S[.f]"`, leading `-` negates whole value
 *   - RANGE<T>        `"[<start>, <end>)"` (T = DATE/DATETIME/TIMESTAMP or
 *                     UNBOUNDED), stored as STRUCT(start,end BIGINT) with
 *                     MIN_I64/MAX_I64 sentinels so overlap checks are int compares
 *   - REPEATED        array of T; STRUCT object keyed by field name
 */

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
 * Standard-SQL type name → legacy wire name BQ's REST API returns. The Go
 * client switches on the legacy constants only (INTEGER/FLOAT/BOOLEAN/RECORD),
 * so standard names would break it; Python and Node normalize both.
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
 * BigQuery `data_type` string as in `INFORMATION_SCHEMA.COLUMNS.data_type`.
 * STRUCT renders its full child list; REPEATED wraps as `ARRAY<…>`.
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
      // DuckDB DECIMAL caps at precision 38, less than BQ's 76 — but enough
      // for any test data that fits in 29 integer digits + 9 decimal places.
      // Schema readback (INFORMATION_SCHEMA, tables.get) still reports
      // BIGNUMERIC, and wire encoders (Avro precision=77/scale=38, Arrow
      // Decimal256(76,38)) pad the unscaled int from scale 9 → 38 on the way
      // out, so byte-for-byte BQ fidelity holds for any value that fits.
      // Values exceeding DECIMAL(38, 9) range are rejected at insert time.
      return 'DECIMAL(38, 9)';
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
      // Spatial extension's native geometry type (loaded at db init).
      return 'GEOMETRY';
    case 'INTERVAL':
      return 'INTERVAL';
    case 'RANGE':
      // Two BIGINT bounds; MIN_I64/MAX_I64 sentinels cover UNBOUNDED without NULLs.
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

/** DuckDB column type for `CREATE TABLE` / `ALTER TABLE`; REPEATED appends `[]`. */
export function bqTypeToDuck(field: BqField): string {
  const base = baseDuckType(field);
  return field.mode === 'REPEATED' ? `${base}[]` : base;
}

function baseInsertExpr(ordinal: number, field: BqField): string {
  const p = `$${ordinal}`;
  switch (field.type) {
    case 'STRING':
      return p;
    case 'GEOGRAPHY':
      return `ST_GeomFromText(${p}::VARCHAR)`;
    case 'BYTES':
      // Bound base64; from_base64() turns it into BLOB.
      return `from_base64(${p})`;
    case 'INT64':
      // JS bigint binds as HUGEINT; cast to BIGINT.
      return `${p}::BIGINT`;
    case 'FLOAT64':
      return `${p}::DOUBLE`;
    case 'BOOL':
      return p;
    case 'NUMERIC':
    case 'BIGNUMERIC':
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
      // Bound pre-translated to DuckDB's `months days microseconds` form
      // (see bqValueToDuckLeaf).
      return `${p}::INTERVAL`;
    case 'RANGE':
      // Bound as JSON `{start, end}`; DuckDB casts to the STRUCT storage shape.
      return `${p}::JSON::STRUCT("start" BIGINT, "end" BIGINT)`;
    case 'STRUCT':
      // Bound as JSON; DuckDB casts to the STRUCT type.
      return `${p}::JSON::${baseDuckType(field)}`;
  }
}

/** SQL binding expression for `$ordinal` as this field's column type, with
 * casts/conversions. REPEATED arrays bind as JSON and cast to `T[]`. */
export function bqInsertExpression(ordinal: number, field: BqField): string {
  if (field.mode === 'REPEATED') {
    // REPEATED always goes through JSON, so cast to the base DuckDB type.
    return `$${ordinal}::JSON::${baseDuckType(field)}[]`;
  }
  return baseInsertExpr(ordinal, field);
}

/** SQL projection for reading a column. Wraps BYTES in `to_base64()` for a
 * wire-format string; everything else is left to `duckValueToBq`. */
export function bqSelectExpression(column: string, field: BqField): string {
  const ident = quoteIdent(column);
  if (field.mode === 'REPEATED') return ident;
  if (field.type === 'BYTES') return `to_base64(${ident})`;
  if (field.type === 'TIME') return `${ident}::VARCHAR`;
  if (field.type === 'GEOGRAPHY') return `replace(ST_AsText(${ident}), ' (', '(')`;
  // DuckDB returns DECIMAL via JS number (loses precision past ~15 digits);
  // cast to VARCHAR so the full string survives.
  if (field.type === 'NUMERIC' || field.type === 'BIGNUMERIC') return `${ident}::VARCHAR`;
  return ident;
}

export function bqValueToDuck(value: unknown, field: BqField): unknown {
  if (value === null || value === undefined) return null;
  if (field.mode === 'REPEATED') {
    if (!Array.isArray(value)) {
      throw new Error(`Expected array for REPEATED field "${field.name}".`);
    }
    // JSON-safe encoder per item: bqValueToDuckLeaf would return unserializable
    // bigints for INT64 and double-stringify STRUCT elements.
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
      // Already base64; SQL wraps with from_base64().
      return String(value);
    case 'INT64':
      return typeof value === 'bigint' ? value : BigInt(String(value));
    case 'FLOAT64':
      return Number(value);
    case 'BOOL':
      // `Boolean("false")` is true (non-empty string), so honor the literal
      // "true"/"false" strings CSV/BQ-wire use (case-insensitive).
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

/** Like bqValueToDuck but for values inside a JSON envelope (REPEATED items,
 * STRUCT fields): returns JSON-friendly forms the caller will stringify. */
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
      // JSON has no bigint; keep as decimal string.
      return typeof value === 'bigint' ? value.toString(10) : String(value);
    case 'FLOAT64':
      return Number(value);
    case 'BOOL':
      return Boolean(value);
    case 'JSON':
      return typeof value === 'string' ? JSON.parse(value) : value;
    case 'INTERVAL':
      // Keep BQ wire form; the outer ::INTERVAL[] cast parses it on the way in.
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

/**
 * BQ wire encoding: each `rows[i].f[j].v` is a JSON value, but scalars are
 * always strings (so INT64/FLOAT64/BOOL/NUMERIC/TIMESTAMP survive JSON
 * precision loss). NULL is JSON null. Arrays/structs wrap each element/field
 * in the same `{v}`/`{f}` envelope recursively.
 */
export function duckValueToBq(value: unknown, field: BqField): unknown {
  if (value === null || value === undefined) return null;
  if (field.mode === 'REPEATED') {
    if (!Array.isArray(value)) {
      throw new Error(`Expected array from DuckDB for REPEATED field "${field.name}".`);
    }
    // Each element is its own `{v}` cell; NULLs render as `{"v": null}`.
    const innerField: BqField = { ...field, mode: 'NULLABLE' };
    return value.map((item) => ({ v: duckValueToBq(item, innerField) }));
  }
  switch (field.type) {
    case 'STRING':
    case 'GEOGRAPHY':
      return typeof value === 'string' ? value : String(value);
    case 'BYTES':
      // `to_base64()` in SELECT yields a string already.
      return typeof value === 'string'
        ? value
        : Buffer.from(value as Uint8Array).toString('base64');
    case 'INT64':
      return typeof value === 'bigint' ? value.toString(10) : String(value);
    case 'FLOAT64':
      return floatToWire(value);
    case 'BOOL':
      // BQ wire uses literal "true"/"false" strings, not JSON booleans;
      // client libs depend on this.
      return value ? 'true' : 'false';
    case 'NUMERIC':
    case 'BIGNUMERIC':
      // SELECT casts NUMERIC/BIGNUMERIC → VARCHAR for full precision; trailing
      // `.0` keeps integer results decimal (matches BQ).
      return trimDecimal(typeof value === 'string' ? value : String(value));
    case 'TIMESTAMP':
      // BQ default (useInt64Timestamp, on by default in @google-cloud/bigquery)
      // is epoch-micros as a decimal Int64Value string — lossless at DuckDB's 1µs.
      return timestampToWireMicros(value);
    case 'DATETIME':
      // No zone; canonical `YYYY-MM-DDTHH:MM:SS[.f]`.
      return datetimeToWire(value);
    case 'DATE':
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      return String(value);
    case 'TIME':
      // DuckDB returns TIME as a string; BQ canonical is `HH:MM:SS[.ffffff]`.
      return timeToWire(value);
    case 'JSON':
      // DuckDB hands back parsed values or JSON strings; normalize to a string.
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
      // BQ STRUCT wire shape: `{ "f": [ {"v": …}, … ] }`, field order = schema.
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
    // `.0` suffix keeps integer-valued floats distinguishable from INT64.
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
    // BQ canonical: no Z, no trailing-zero fraction.
    return value
      .toISOString()
      .replace(/\.0+Z$/, '')
      .replace(/Z$/, '');
  }
  return String(value);
}

function timeToWire(value: unknown): string {
  if (value instanceof Date) {
    // DuckDB sometimes returns TIME as a Date pinned to the Unix epoch.
    return value.toISOString().slice(11, 23);
  }
  if (typeof value === 'bigint') {
    // DuckDB TIME = micros-since-midnight; convert to `HH:MM:SS[.ffffff]`.
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
    // BQ canonical fraction is variable-length, no trailing zeros.
    const usStr = String(us).padStart(6, '0').replace(/0+$/, '');
    return `${hh}:${mm}:${ss}.${usStr}`;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// INTERVAL: BQ wire ↔ DuckDB
// ---------------------------------------------------------------------------

/**
 * Parse a BQ INTERVAL wire string ("Y-M D H:M:S[.f]", optionally sign-prefixed)
 * into the {months, days, micros} triple DuckDB stores; leading sign negates all.
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
  // BQ pulls the overall sign out front when all non-zero components share it;
  // mixed signs keep per-component signs (still a valid BQ literal).
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
  // `months days microseconds` form; micros covers H/M/S/f exactly.
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
  // DuckDB returns INTERVAL as {months, days, micros}.
  if (typeof value === 'object' && value !== null) {
    const v = value as { months?: unknown; days?: unknown; micros?: unknown };
    const months = typeof v.months === 'bigint' ? v.months : BigInt(Number(v.months ?? 0));
    const days = typeof v.days === 'bigint' ? v.days : BigInt(Number(v.days ?? 0));
    const micros = typeof v.micros === 'bigint' ? v.micros : BigInt(Number(v.micros ?? 0));
    return formatBqInterval(months, days, micros);
  }
  // Defensive fallback if upstream already serialized to a string.
  return String(value);
}

function trimDecimal(s: string): string {
  // Keep at least one decimal place so integer-valued NUMERIC round-trips as decimal.
  if (s.includes('.')) return s;
  return `${s}.0`;
}

// ---------------------------------------------------------------------------
// Row-level wrappers
// ---------------------------------------------------------------------------

/** Encode a row in schema field order, as params for `db.exec(sql, values)`. */
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
  UBIGINT: 'INT64',
  UINTEGER: 'INT64',
  USMALLINT: 'INT64',
  UTINYINT: 'INT64',
  UHUGEINT: 'INT64',
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

/** Synthesize a BqField from a DuckDB column type + name. Trailing `[]` (LIST)
 * → REPEATED; recognizes `DECIMAL(p,s)` and `STRUCT(...)` syntactically. */
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
  // Splits "STRUCT(name1 type1, ...)" on top-level commas to handle nesting
  // without a full parser.
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
    // "fieldName fieldType" — split on first whitespace, allowing quoted idents.
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

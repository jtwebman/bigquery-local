/**
 * Schema autodetect (BL-090).
 *
 * Given a sample of N rows from a CSV or NDJSON load, infer a
 * `BqField[]` schema. The inference rules try to match BigQuery's
 * documented behavior:
 *
 *   1. If every value parses as an integer (no decimals, no exponent) →
 *      INT64.
 *   2. Otherwise if every value parses as a finite number → FLOAT64.
 *   3. Otherwise if every value is exactly "true"/"false" (case
 *      insensitive) → BOOL.
 *   4. Otherwise if every value matches `YYYY-MM-DD` → DATE.
 *   5. Otherwise if every value parses as an ISO-8601 timestamp → TIMESTAMP.
 *   6. Otherwise → STRING.
 *
 * Empty strings / null / undefined are treated as "no observation" — they
 * don't push the type toward STRING. A column with no observed values
 * defaults to STRING.
 *
 * For NDJSON the input is already typed (numbers vs strings vs booleans)
 * so the inference is mostly trivial — but the same code path handles
 * "every value is a JS number, some are integers and some are floats"
 * by promoting to FLOAT64.
 */

import type { BqField, BqType } from '../storage/types.ts';

/** A flat row of name → value pairs. CSV gives strings; NDJSON gives
 *  the natural JSON types (number/boolean/null/array/object/string). */
export type SampleRow = Readonly<Record<string, unknown>>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const INT_LITERAL = /^-?\d+$/;
const FLOAT_LITERAL = /^-?\d+\.\d+([eE][+-]?\d+)?$/;

/** Per-column inference state — observation counters that tell us how
 *  many sampled values were compatible with each candidate type. */
interface ColumnObservations {
  total: number;
  asInt: number;
  asFloat: number;
  asBool: number;
  asDate: number;
  asTimestamp: number;
  /** True when at least one value couldn't be coerced to any non-STRING type. */
  sawString: boolean;
  /** True when at least one value was a JS array. Forces REPEATED in inferred field. */
  sawArray: boolean;
}

function freshColumn(): ColumnObservations {
  return {
    total: 0,
    asInt: 0,
    asFloat: 0,
    asBool: 0,
    asDate: 0,
    asTimestamp: 0,
    sawString: false,
    sawArray: false,
  };
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function observe(col: ColumnObservations, value: unknown): void {
  if (isEmpty(value)) return;

  if (Array.isArray(value)) {
    col.sawArray = true;
    // For arrays we don't count the container itself as an observation —
    // the element loop counts each one. Counting both would inflate
    // col.total above asInt/asFloat and force the column to STRING.
    for (const item of value) observe(col, item);
    return;
  }

  col.total += 1;

  if (typeof value === 'number') {
    if (Number.isFinite(value)) {
      col.asFloat += 1;
      if (Number.isInteger(value)) col.asInt += 1;
    } else {
      col.sawString = true;
    }
    return;
  }

  if (typeof value === 'boolean') {
    col.asBool += 1;
    return;
  }

  if (typeof value === 'string') {
    if (INT_LITERAL.test(value)) {
      col.asInt += 1;
      col.asFloat += 1;
    } else if (FLOAT_LITERAL.test(value)) {
      col.asFloat += 1;
    } else if (value.toLowerCase() === 'true' || value.toLowerCase() === 'false') {
      col.asBool += 1;
    } else if (ISO_DATE.test(value)) {
      col.asDate += 1;
    } else if (ISO_TIMESTAMP.test(value)) {
      col.asTimestamp += 1;
    } else {
      col.sawString = true;
    }
    return;
  }

  // Objects / nested structures fall through to STRING for v0.
  col.sawString = true;
}

function pickType(col: ColumnObservations): BqType {
  if (col.total === 0 || col.sawString) return 'STRING';
  if (col.asInt === col.total) return 'INT64';
  if (col.asFloat === col.total) return 'FLOAT64';
  if (col.asBool === col.total) return 'BOOL';
  if (col.asDate === col.total) return 'DATE';
  if (col.asTimestamp === col.total) return 'TIMESTAMP';
  return 'STRING';
}

/**
 * Infer a BigQuery-style schema from a sample of parsed rows.
 *
 * `columnOrder` lets the caller pin the field ordering — for CSV this is
 * the header order, for NDJSON it's first-seen order across the sample.
 * Any keys that appear in rows but aren't in `columnOrder` are appended
 * at the end in their first-seen order.
 */
export function inferSchema(
  rows: readonly SampleRow[],
  columnOrder: readonly string[],
): readonly BqField[] {
  const cols: Map<string, ColumnObservations> = new Map();
  const order: string[] = [...columnOrder];
  for (const name of order) cols.set(name, freshColumn());

  for (const row of rows) {
    for (const [name, value] of Object.entries(row)) {
      if (!cols.has(name)) {
        cols.set(name, freshColumn());
        order.push(name);
      }
      observe(cols.get(name) as ColumnObservations, value);
    }
  }

  return order.map((name) => {
    const col = cols.get(name) as ColumnObservations;
    const baseType = pickType(col);
    const field: BqField = col.sawArray
      ? { name, type: baseType, mode: 'REPEATED' }
      : { name, type: baseType };
    return field;
  });
}

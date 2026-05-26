/**
 * Response canonicalization for the BQ-vs-emulator conformance suite.
 *
 * Strips fields that legitimately differ between engines or between
 * runs (timing, identity, exact byte counts) so a diff that fails
 * means a real divergence in semantics or wire format.
 */

export interface CanonicalQueryResponse {
  readonly schema: {
    readonly fields: ReadonlyArray<Record<string, unknown>>;
  };
  readonly rows: ReadonlyArray<{ readonly f: ReadonlyArray<{ readonly v: unknown }> }>;
  readonly totalRows: string;
  readonly jobComplete: boolean;
}

type AnyObject = Record<string, unknown>;

const VOLATILE_TOP_LEVEL = new Set([
  'kind',
  'jobReference',
  'cacheHit',
  'totalBytesProcessed',
  'sessionInfo',
  'queryId',
]);
const VOLATILE_SCHEMA_FIELD = new Set(['categories', 'policyTags']);

/**
 * Strip volatile / engine-specific fields from a `jobs.query` response
 * and return the shape we want to diff against.
 *
 * `sortRowsBy`, when given, sorts rows by the named column so
 * non-deterministic engine ordering doesn't trip the diff.
 */
export interface CanonicalizeOptions {
  readonly sortRowsBy?: string;
  /**
   * Round numeric row values to the nearest multiple of this unit
   * before diffing. Used for queries whose result is a float computed
   * differently between the engines (e.g. ST_DISTANCE on a sphere vs
   * WGS-84 ellipsoid — sub-meter divergence on continent-scale
   * distances). Use 0.001 for sub-meter precision, 1 for meter, 1000
   * for km, etc.
   */
  readonly numericRoundUnit?: number;
}

export function canonicalizeQueryResponse(
  raw: unknown,
  options: CanonicalizeOptions = {},
): CanonicalQueryResponse {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Expected a JSON object query response.');
  }
  const obj = raw as AnyObject;
  const schemaRaw = (obj['schema'] ?? {}) as AnyObject;
  const fields = Array.isArray(schemaRaw['fields'])
    ? (schemaRaw['fields'] as AnyObject[]).map(canonicalizeSchemaField)
    : [];
  let rows: ReadonlyArray<{ f: ReadonlyArray<{ v: unknown }> }> = Array.isArray(obj['rows'])
    ? (obj['rows'] as ReadonlyArray<{ f: ReadonlyArray<{ v: unknown }> }>)
    : [];
  if (options.sortRowsBy !== undefined) {
    const colIdx = fields.findIndex((f) => f['name'] === options.sortRowsBy);
    if (colIdx === -1) {
      throw new Error(`sortRowsBy="${options.sortRowsBy}" not in schema.fields`);
    }
    rows = [...rows].sort((a, b) => {
      const av = String(a.f[colIdx]?.v ?? '');
      const bv = String(b.f[colIdx]?.v ?? '');
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
  }
  if (options.numericRoundUnit !== undefined) {
    const unit = options.numericRoundUnit;
    rows = rows.map((row) => ({
      f: row.f.map((cell) => {
        if (typeof cell.v !== 'string') return cell;
        const n = Number(cell.v);
        if (Number.isNaN(n)) return cell;
        return { v: String(Math.round(n / unit) * unit) };
      }),
    }));
  }
  void VOLATILE_TOP_LEVEL;
  return {
    schema: { fields },
    rows,
    totalRows: String(obj['totalRows'] ?? rows.length),
    jobComplete: Boolean(obj['jobComplete']),
  };
}

function canonicalizeSchemaField(field: AnyObject): AnyObject {
  const out: AnyObject = {};
  for (const [k, v] of Object.entries(field)) {
    if (VOLATILE_SCHEMA_FIELD.has(k)) continue;
    // NULLABLE is the default — BQ emits it, we omit. Same meaning.
    if (k === 'mode' && v === 'NULLABLE') continue;
    if (k === 'fields' && Array.isArray(v)) {
      out['fields'] = (v as AnyObject[]).map(canonicalizeSchemaField);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface CanonicalErrorResponse {
  readonly status: number;
  readonly reason: string;
  /** Regex source string — the captured fixture stores a pattern, not
   *  a literal, so BQ wording drift doesn't fail the diff. */
  readonly messageRegex: string;
}

export function canonicalizeError(status: number, body: unknown): CanonicalErrorResponse {
  const obj = (body as AnyObject) ?? {};
  const err = (obj['error'] as AnyObject) ?? {};
  const errors = Array.isArray(err['errors']) ? (err['errors'] as AnyObject[]) : [];
  const first = errors[0] ?? {};
  return {
    status,
    reason: String(first['reason'] ?? ''),
    messageRegex: escapeForRegex(String(first['message'] ?? '')),
  };
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

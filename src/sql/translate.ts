/**
 * BigQuery SQL → DuckDB SQL translator. Not a parser — a targeted
 * token-stream rewriter: most SQL passes through unchanged; a fixed set of
 * BQ-isms get rewritten. The "current project" (from the request URL) scopes
 * backtick table refs to `project__dataset`.`table` so same-named datasets in
 * different projects don't collide. Known-unsupported BQ functions throw
 * `BqError.unsupportedFeature`; anything else passes through for DuckDB to
 * accept or reject.
 */

import { BqError } from '../util/errors.ts';
import {
  decodeBqString,
  encodeDuckString,
  findFollowingOpenParen,
  findMatchingClose,
  skipWhitespace,
} from './rewrite/helpers.ts';
import { CALL_HANDLERS, type RewriteCtx } from './rewrite/index.ts';
import { type Token, type TokenKind, isSkippable, nextNonSkippable, tokenize } from './tokenize.ts';

export interface TranslateResult {
  /** DuckDB-ready SQL. */
  readonly sql: string;
  /** Parameter names in `$1`, `$2`, … order. The caller maps named values
   * into a positional array using this list. */
  readonly paramOrder: readonly string[];
}

export interface TranslateOptions {
  /** The request's URL project — used to qualify 2-part backtick refs
   * (`dataset.table`) into the project-scoped DuckDB schema. Required;
   * single-project translators are no longer correct. */
  readonly project: string;
}

// BQ function name → DuckDB name, for cases where only the name differs.
// Matching names need no entry (DuckDB is case-insensitive on function
// names). Functions needing argument reshuffles or wrappers live as branches
// in `handleIdentifier`.
const FUNCTION_RENAMES: ReadonlyMap<string, string> = new Map([
  ['JSON_VALUE', 'json_extract_string'],
  ['SAFE_CAST', 'try_cast'],
  ['REGEXP_CONTAINS', 'regexp_matches'],
  ['FORMAT', 'printf'],
  ['NORMALIZE', 'nfc_normalize'],
  // strlen() is byte count (matches BQ OCTET_LENGTH/BYTE_LENGTH); length() is char count.
  ['OCTET_LENGTH', 'strlen'],
  ['BYTE_LENGTH', 'strlen'],
  ['IS_INF', 'isinf'],
  ['IS_NAN', 'isnan'],
  ['UNIX_MILLIS', 'epoch_ms'],
  ['UNIX_MICROS', 'epoch_us'],
  ['LAST_DAY', 'last_day'],
  ['SPLIT', 'string_split'],
  ['EDIT_DISTANCE', 'levenshtein'],
  ['RAND', 'random'],
  ['GENERATE_ARRAY', 'generate_series'],
  ['FLATTEN', 'flatten'],
  ['STRING_AGG', 'string_agg'],
  ['LOGICAL_AND', 'bool_and'],
  ['LOGICAL_OR', 'bool_or'],
  ['JSON_QUERY', 'json_extract'],
  ['JSON_QUERY_ARRAY', 'json_extract'],
  ['JSON_VALUE_ARRAY', 'json_extract_string'],
  ['JSON_EXTRACT_SCALAR', 'json_extract_string'],
  ['JSON_KEYS', 'json_keys'],
  ['TO_JSON', 'to_json'],
  ['TO_JSON_STRING', 'to_json'],
  // GEOGRAPHY (spatial extension): BQ's ST_GEOG* spellings → DuckDB's. Other ST_* match.
  ['ST_GEOGFROMTEXT', 'ST_GeomFromText'],
  ['ST_GEOGFROMWKB', 'ST_GeomFromWKB'],
  ['ST_GEOGPOINT', 'ST_Point'],
  ['ST_GEOGFROMGEOJSON', 'ST_GeomFromGeoJSON'],
  ['ST_ASGEOJSON', 'ST_AsGeoJSON'],
  // Geodesic-in-meters semantics — see bq_st_distance macro in db.ts.
  ['ST_DISTANCE', 'bq_st_distance'],
  ['ST_DWITHIN', 'bq_st_dwithin'],
]);

/** A small list of BQ functions we explicitly call out as unsupported, so
 * the error is "BigQuery feature not supported in v0" rather than a vague
 * DuckDB "function does not exist". Grow this as we hit real cases. */
const UNSUPPORTED_FUNCTIONS = new Set([
  // FARM_FINGERPRINT uses FarmHash specifically; DuckDB's hash() is a
  // different algorithm and would not return matching values.
  'FARM_FINGERPRINT',
  // APPROX_COUNT_DISTINCT is supported (BL-045) — pass-through to DuckDB.
  'APPROX_QUANTILES',
  'NET.IP_FROM_STRING',
  'ML.PREDICT',
  'ML.EVALUATE',
  'SEARCH',
  'VECTOR_SEARCH',
  // No DuckDB equivalent yet — surface a precise error rather than DuckDB's
  // "function does not exist". Planned for a future version.
  'INITCAP',
  'REGEXP_INSTR',
  'CONTAINS_SUBSTR',
  'CODE_POINTS_TO_STRING',
  'CODE_POINTS_TO_BYTES',
  'TO_CODE_POINTS',
  'SAFE_CONVERT_BYTES_TO_STRING',
  'SOUNDEX',
  'RANGE_BUCKET',
  'LAX_BOOL',
  'LAX_INT64',
  'LAX_FLOAT64',
  'LAX_STRING',
  'JSON_EXTRACT_ARRAY',
  'JSON_REMOVE',
  'JSON_SET',
  'JSON_STRIP_NULLS',
  'TO_BASE32',
  'FROM_BASE32',
  'APPROX_TOP_COUNT',
  'APPROX_TOP_SUM',
  'HLL_COUNT',
  'ST_GEOHASH',
]);

// BQ type-name → DuckDB type-name, for a bare identifier outside a
// function-call position (e.g. inside CAST). `FLOAT64(json)`-style call
// positions are handled by branches in handleIdentifier.
const BQ_TYPE_ALIAS_FOR_CAST: ReadonlyMap<string, string> = new Map([
  ['INT64', 'BIGINT'],
  ['FLOAT64', 'DOUBLE'],
  ['BOOL', 'BOOLEAN'],
  ['BYTES', 'BLOB'],
]);

// Identifiers DuckDB reserves but BQ allows as bare columns — auto-quote them
// so DuckDB doesn't parse-error. Words reserved in both dialects (WINDOW,
// RANGE, QUALIFY, ...) are excluded: BQ users backtick-quote those anyway.
const DUCKDB_RESERVED_BUT_BQ_ALLOWED = new Set<string>([
  'CHECK',
  'COLUMN',
  'CONSTRAINT',
  'FOREIGN',
  'PRIMARY',
  'REFERENCES',
  'UNIQUE',
  'DEFERRABLE',
  'INITIALLY',
  'ANALYSE',
  'ANALYZE',
  'DESCRIBE',
  'SUMMARIZE',
  'RETURNING',
  'DO',
  'ONLY',
  'USER',
]);

export function translate(sql: string, options: TranslateOptions): TranslateResult {
  const tokens = rewriteXor(tokenize(sql));
  const paramOrder: string[] = [];
  const out = translateRange(tokens, 0, tokens.length, paramOrder, options.project);
  return { sql: out, paramOrder };
}

// ---------------------------------------------------------------------------
// `^` infix → xor() rewrite
// ---------------------------------------------------------------------------

// BQ's `^` is bitwise XOR; DuckDB's is exponentiation. Rewrite `a ^ b` →
// `xor(a, b)` by grabbing the primary expression on each side (atom +
// member/call/subscript postfixes, or a parenthesized group), folding chained
// `^` left-associatively. An unparenthesized mix with a higher-precedence
// binary (`a + b ^ c`) associates by primary, not BQ precedence.

function syntheticToken(kind: TokenKind, value: string): Token {
  return { kind, value, start: 0, end: 0 };
}

// Keywords that can sit directly before a `(...)` group without making it a
// function call (`WHERE (...)`, `IN (...)`, etc.). Used to stop left-operand
// extraction from swallowing the keyword as a callee.
const KEYWORD_BEFORE_GROUP = new Set<string>([
  'SELECT',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'ON',
  'WHEN',
  'THEN',
  'ELSE',
  'CASE',
  'BY',
  'IN',
  'FROM',
  'HAVING',
  'RETURNING',
  'VALUES',
  'SET',
  'AS',
  'OVER',
  'PARTITION',
  'BETWEEN',
  'LIKE',
  'IS',
  'USING',
  'EXISTS',
  'ALL',
  'ANY',
  'SOME',
  'INTO',
  'LIMIT',
  'OFFSET',
  'QUALIFY',
  'GROUP',
  'ORDER',
]);

function isCalleeIdentifier(tok: Token): boolean {
  if (tok.kind === 'backtick-identifier') return true;
  return tok.kind === 'identifier' && !KEYWORD_BEFORE_GROUP.has(tok.value.toUpperCase());
}

function rewriteXor(tokens: readonly Token[]): readonly Token[] {
  let arr = tokens.slice();
  let searchFrom = 0;
  while (true) {
    let k = -1;
    for (let idx = searchFrom; idx < arr.length; idx += 1) {
      const t = arr[idx];
      if (t?.kind === 'operator' && t.value === '^') {
        k = idx;
        break;
      }
    }
    if (k === -1) return arr;
    const left = leftPrimaryRange(arr, k);
    const right = rightPrimaryRange(arr, k);
    if (left === null || right === null) {
      searchFrom = k + 1;
      continue;
    }
    arr = [
      ...arr.slice(0, left.start),
      syntheticToken('identifier', 'xor'),
      syntheticToken('punctuation', '('),
      ...arr.slice(left.start, left.endExcl),
      syntheticToken('punctuation', ', '),
      ...arr.slice(right.start, right.endExcl),
      syntheticToken('punctuation', ')'),
      ...arr.slice(right.endExcl),
    ];
    searchFrom = 0;
  }
}

function isOpenBracket(tok: Token): boolean {
  return (
    tok.kind === 'punctuation' && (tok.value === '(' || tok.value === '[' || tok.value === '{')
  );
}

function isCloseBracket(tok: Token): boolean {
  return (
    tok.kind === 'punctuation' && (tok.value === ')' || tok.value === ']' || tok.value === '}')
  );
}

function isAtomToken(tok: Token): boolean {
  return (
    tok.kind === 'identifier' ||
    tok.kind === 'backtick-identifier' ||
    tok.kind === 'number' ||
    tok.kind === 'string' ||
    tok.kind === 'raw-string' ||
    tok.kind === 'bytes' ||
    tok.kind === 'raw-bytes' ||
    tok.kind === 'parameter'
  );
}

function prevNonSkippable(tokens: readonly Token[], start: number): number {
  let i = start;
  while (i >= 0 && isSkippable(tokens[i] as Token)) i -= 1;
  return i;
}

/** Index of the bracket that closes the one opened at `openIdx`, tracking all
 *  bracket kinds. Returns -1 if unbalanced. */
function matchBracketForward(tokens: readonly Token[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i += 1) {
    const tok = tokens[i] as Token;
    if (isOpenBracket(tok)) depth += 1;
    else if (isCloseBracket(tok)) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the bracket that opens the one closed at `closeIdx`. */
function matchBracketBackward(tokens: readonly Token[], closeIdx: number): number {
  let depth = 0;
  for (let i = closeIdx; i >= 0; i -= 1) {
    const tok = tokens[i] as Token;
    if (isCloseBracket(tok)) depth += 1;
    else if (isOpenBracket(tok)) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The primary expression immediately right of the `^` at index `k`. */
function rightPrimaryRange(
  tokens: readonly Token[],
  k: number,
): { start: number; endExcl: number } | null {
  let i = nextNonSkippable(tokens, k + 1);
  if (i >= tokens.length) return null;
  const start = i;
  // Leading unary operators bind tighter than `^`.
  while (i < tokens.length) {
    const t = tokens[i] as Token;
    if (t.kind === 'operator' && (t.value === '-' || t.value === '+' || t.value === '~')) {
      i = nextNonSkippable(tokens, i + 1);
    } else break;
  }
  const atomEnd = consumeAtomForward(tokens, i);
  if (atomEnd < 0) return null;
  return { start, endExcl: atomEnd };
}

/** Index just past the atom (with postfix `.`/call/subscript) starting at `i`. */
function consumeAtomForward(tokens: readonly Token[], i: number): number {
  const tok = tokens[i];
  if (tok === undefined) return -1;
  if (isOpenBracket(tok)) {
    const close = matchBracketForward(tokens, i);
    return close < 0 ? -1 : close + 1;
  }
  if (!isAtomToken(tok)) return -1;
  let j = i + 1;
  while (true) {
    const n = nextNonSkippable(tokens, j);
    const nt = tokens[n];
    if (nt === undefined) break;
    if (nt.kind === 'punctuation' && nt.value === '.') {
      const m = nextNonSkippable(tokens, n + 1);
      const mt = tokens[m];
      if (mt !== undefined && (isAtomToken(mt) || (mt.kind === 'operator' && mt.value === '*'))) {
        j = m + 1;
        continue;
      }
      break;
    }
    if (isOpenBracket(nt)) {
      const close = matchBracketForward(tokens, n);
      if (close < 0) break;
      j = close + 1;
      continue;
    }
    break;
  }
  return j;
}

/** The primary expression immediately left of the `^` at index `k`. */
function leftPrimaryRange(
  tokens: readonly Token[],
  k: number,
): { start: number; endExcl: number } | null {
  const end = prevNonSkippable(tokens, k - 1);
  if (end < 0) return null;
  const start = consumeAtomBackward(tokens, end);
  if (start < 0) return null;
  return { start, endExcl: end + 1 };
}

/** Start index of the atom (with member chains / call / subscript) ending at `i`. */
function consumeAtomBackward(tokens: readonly Token[], i: number): number {
  let cur = i;
  while (cur >= 0) {
    const tok = tokens[cur] as Token;
    if (isCloseBracket(tok)) {
      const open = matchBracketBackward(tokens, cur);
      if (open < 0) return -1;
      const p = prevNonSkippable(tokens, open - 1);
      const pt = tokens[p];
      if (p >= 0 && pt !== undefined && (isCalleeIdentifier(pt) || isCloseBracket(pt))) {
        cur = p;
        continue;
      }
      return open;
    }
    if (isAtomToken(tok)) {
      const p = prevNonSkippable(tokens, cur - 1);
      const pt = tokens[p];
      if (p >= 0 && pt?.kind === 'punctuation' && pt.value === '.') {
        const pp = prevNonSkippable(tokens, p - 1);
        const ppt = tokens[pp];
        if (
          pp >= 0 &&
          ppt !== undefined &&
          (ppt.kind === 'identifier' || ppt.kind === 'backtick-identifier' || isCloseBracket(ppt))
        ) {
          cur = pp;
          continue;
        }
      }
      return cur;
    }
    return -1;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Core walk
// ---------------------------------------------------------------------------

function translateRange(
  tokens: readonly Token[],
  startIdx: number,
  endIdx: number,
  paramOrder: string[],
  project: string,
): string {
  const out: string[] = [];
  let i = startIdx;
  while (i < endIdx) {
    const tok = tokens[i];
    if (tok === undefined) break;

    // INFORMATION_SCHEMA references — intercept before the regular switch so
    // we can consume the whole `<prefix>.INFORMATION_SCHEMA.<view>` span as a
    // single virtual table reference.
    if (tok.kind === 'identifier' || tok.kind === 'backtick-identifier') {
      const rewritten = tryRewriteInformationSchema(tokens, i, endIdx, project);
      if (rewritten !== null) {
        out.push(rewritten.sql);
        i = rewritten.nextIdx;
        continue;
      }
    }

    switch (tok.kind) {
      case 'backtick-identifier':
        out.push(rewriteBacktick(tok, project));
        i += 1;
        break;
      case 'parameter':
        out.push(rewriteParameter(tok, paramOrder));
        i += 1;
        break;
      case 'raw-string':
        // BQ raw string `r'\d+'` → plain DuckDB string `'\d+'`. DuckDB's
        // default string literal doesn't interpret backslash escapes
        // (unlike PostgreSQL's E'...'), so dropping the prefix preserves
        // BQ's no-escape semantics.
        out.push(tok.value.replace(/^[rR]/, ''));
        i += 1;
        break;
      case 'string':
        // BQ `"x"` is a string (DuckDB reads it as an identifier) and BQ
        // interprets `\n`-style escapes (DuckDB's `'...'` doesn't) — decode
        // and re-emit single-quoted.
        out.push(encodeDuckString(decodeBqString(tok.value)));
        i += 1;
        break;
      case 'bytes':
      case 'raw-bytes':
        // BQ bytes literal `b'hello'` → DuckDB `BLOB 'hello'`. The same
        // path covers `rb'...'` / `br'...'` (raw bytes — no backslash
        // escapes, same as raw strings).
        out.push(`BLOB ${tok.value.replace(/^(rb|br|b)/i, '')}`);
        i += 1;
        break;
      case 'identifier':
        i = handleIdentifier(tokens, i, endIdx, out, paramOrder, project);
        break;
      case 'number':
        out.push(rewriteNumberLiteral(tok, tokens, i, endIdx));
        i += 1;
        break;
      default:
        out.push(tok.value);
        i += 1;
        break;
    }
  }
  return out.join('');
}

// BQ types a bare decimal literal (`3.14`, `1e3`) as FLOAT64; DuckDB types it
// as DECIMAL, which we surface as NUMERIC. Cast fractional literals to DOUBLE
// so the result schema reports FLOAT, matching BQ. Integer literals (INT64)
// are left alone. The one fractional literal that isn't a value expression is
// a `TABLESAMPLE … (n PERCENT)` percentage — leave that untouched.
function rewriteNumberLiteral(
  tok: Token,
  tokens: readonly Token[],
  i: number,
  endIdx: number,
): string {
  if (!/[.eE]/.test(tok.value)) return tok.value;
  const nextIdx = nextNonSkippable(tokens, i + 1);
  if (nextIdx < endIdx && tokens[nextIdx]?.value.toUpperCase() === 'PERCENT') {
    return tok.value;
  }
  return `CAST(${tok.value} AS DOUBLE)`;
}

// ---------------------------------------------------------------------------
// INFORMATION_SCHEMA → virtual views over _bq metadata
// ---------------------------------------------------------------------------

/**
 * Maps a BQ `INFORMATION_SCHEMA.<NAME>` to the backing DuckDB view in the
 * `_bq` schema, plus the column names the project/dataset filter applies
 * to. Most views use `table_catalog` / `table_schema`; the routine-shaped
 * views (ROUTINES, PARAMETERS, ROUTINE_OPTIONS) use BQ's `specific_*`
 * naming. Names not in this map throw `unsupportedFeature` so the caller
 * gets a precise error instead of a DuckDB "table does not exist".
 */
interface InformationSchemaView {
  readonly duckdbView: string;
  readonly catalogColumn: string;
  /** `undefined` for project-scoped views (JOBS*, SCHEMATA*) — no per-dataset
   * filter applies even if the caller named a dataset. */
  readonly schemaColumn: string | undefined;
}

const TABLE_SCOPED: Pick<InformationSchemaView, 'catalogColumn' | 'schemaColumn'> = {
  catalogColumn: 'table_catalog',
  schemaColumn: 'table_schema',
};
const ROUTINE_SCOPED: Pick<InformationSchemaView, 'catalogColumn' | 'schemaColumn'> = {
  catalogColumn: 'specific_catalog',
  schemaColumn: 'specific_schema',
};
const JOB_SCOPED: Pick<InformationSchemaView, 'catalogColumn' | 'schemaColumn'> = {
  catalogColumn: 'project_id',
  schemaColumn: undefined,
};
const SCHEMA_SCOPED: Pick<InformationSchemaView, 'catalogColumn' | 'schemaColumn'> = {
  catalogColumn: 'catalog_name',
  schemaColumn: undefined,
};

const INFORMATION_SCHEMA_VIEWS: ReadonlyMap<string, InformationSchemaView> = new Map([
  ['TABLES', { duckdbView: 'info_tables', ...TABLE_SCOPED }],
  ['COLUMNS', { duckdbView: 'info_columns', ...TABLE_SCOPED }],
  ['COLUMN_FIELD_PATHS', { duckdbView: 'info_column_field_paths', ...TABLE_SCOPED }],
  ['TABLE_OPTIONS', { duckdbView: 'info_table_options', ...TABLE_SCOPED }],
  ['VIEWS', { duckdbView: 'info_views', ...TABLE_SCOPED }],
  ['MATERIALIZED_VIEWS', { duckdbView: 'info_materialized_views', ...TABLE_SCOPED }],
  ['ROUTINES', { duckdbView: 'info_routines', ...ROUTINE_SCOPED }],
  ['PARAMETERS', { duckdbView: 'info_parameters', ...ROUTINE_SCOPED }],
  ['ROUTINE_OPTIONS', { duckdbView: 'info_routine_options', ...ROUTINE_SCOPED }],
  ['JOBS', { duckdbView: 'info_jobs', ...JOB_SCOPED }],
  ['JOBS_BY_USER', { duckdbView: 'info_jobs_by_user', ...JOB_SCOPED }],
  ['JOBS_BY_PROJECT', { duckdbView: 'info_jobs_by_project', ...JOB_SCOPED }],
  ['JOBS_BY_ORGANIZATION', { duckdbView: 'info_jobs_by_organization', ...JOB_SCOPED }],
  ['JOBS_TIMELINE', { duckdbView: 'info_jobs_timeline', ...JOB_SCOPED }],
  ['JOBS_TIMELINE_BY_USER', { duckdbView: 'info_jobs_timeline_by_user', ...JOB_SCOPED }],
  ['JOBS_TIMELINE_BY_PROJECT', { duckdbView: 'info_jobs_timeline_by_project', ...JOB_SCOPED }],
  [
    'JOBS_TIMELINE_BY_ORGANIZATION',
    { duckdbView: 'info_jobs_timeline_by_organization', ...JOB_SCOPED },
  ],
  ['SCHEMATA', { duckdbView: 'info_schemata', ...SCHEMA_SCOPED }],
  ['SCHEMATA_OPTIONS', { duckdbView: 'info_schemata_options', ...SCHEMA_SCOPED }],
]);

/** A segment of an INFORMATION_SCHEMA prefix — one component before the
 * `INFORMATION_SCHEMA` keyword. Carries the literal token text so we can
 * decide whether it names a project, dataset, or region. */
interface PrefixSegment {
  readonly text: string;
  /** True if the segment was sourced from a multi-part backtick — i.e. the
   * caller wrote `\`project.region-us\`` and we split it. Multi-part
   * backticks force `project.region` interpretation. */
  readonly fromMultiBacktick: boolean;
}

/**
 * If tokens at `i` form `<prefix>.INFORMATION_SCHEMA.<view>`, return the
 * DuckDB rewrite + resume index; else null. Region segments (`region-*`)
 * drop out of the filter — the emulator doesn't track regions. Prefix shapes:
 *   `\`region-us\``           — region-scoped, current project
 *   `\`project.region-us\``   — region-scoped, named project
 *   `\`project.dataset\``     — dataset-scoped, named project
 *   `dataset`                 — dataset-scoped, current project
 *   `project.dataset`         — dataset-scoped, named project
 */
function tryRewriteInformationSchema(
  tokens: readonly Token[],
  i: number,
  endIdx: number,
  currentProject: string,
): { sql: string; nextIdx: number } | null {
  const segments: PrefixSegment[] = [];
  let cursor = i;
  const first = tokens[cursor];
  if (first === undefined) return null;
  if (first.kind === 'backtick-identifier') {
    const inner = first.value.slice(1, -1);
    const parts = inner.split('.').filter((p) => p !== '');
    if (parts.length === 0) return null;
    for (const part of parts) {
      segments.push({ text: part, fromMultiBacktick: parts.length > 1 });
    }
    cursor += 1;
  } else if (first.kind === 'identifier') {
    segments.push({ text: first.value, fromMultiBacktick: false });
    cursor += 1;
  } else {
    return null;
  }
  // Walk forward through `. ident` pairs until we run out or hit
  // INFORMATION_SCHEMA.
  while (cursor < endIdx) {
    const dotIdx = nextNonSkippable(tokens, cursor);
    if (dotIdx >= endIdx) return null;
    const dot = tokens[dotIdx];
    if (dot?.kind !== 'punctuation' || dot.value !== '.') return null;
    const idIdx = nextNonSkippable(tokens, dotIdx + 1);
    if (idIdx >= endIdx) return null;
    const id = tokens[idIdx];
    if (id === undefined) return null;
    if (id.kind === 'identifier' && id.value.toUpperCase() === 'INFORMATION_SCHEMA') {
      // Found it — next must be `. <view>`.
      const dot2Idx = nextNonSkippable(tokens, idIdx + 1);
      const dot2 = tokens[dot2Idx];
      if (dot2?.kind !== 'punctuation' || dot2.value !== '.') return null;
      const viewIdx = nextNonSkippable(tokens, dot2Idx + 1);
      const viewTok = tokens[viewIdx];
      if (viewTok?.kind !== 'identifier') return null;
      const sql = buildInformationSchemaQuery(segments, viewTok.value, currentProject);
      return { sql, nextIdx: viewIdx + 1 };
    }
    if (id.kind !== 'identifier') return null;
    segments.push({ text: id.value, fromMultiBacktick: false });
    cursor = idIdx + 1;
  }
  return null;
}

function buildInformationSchemaQuery(
  segments: readonly PrefixSegment[],
  viewName: string,
  currentProject: string,
): string {
  const view = INFORMATION_SCHEMA_VIEWS.get(viewName.toUpperCase());
  if (view === undefined) {
    throw BqError.unsupportedFeature(
      `BigQuery feature not supported in v0: INFORMATION_SCHEMA.${viewName}`,
      `INFORMATION_SCHEMA.${viewName}`,
    );
  }
  const { project, dataset } = resolveInformationSchemaScope(segments, currentProject);
  const conditions: string[] = [`${view.catalogColumn} = ${sqlString(project)}`];
  if (dataset !== null && view.schemaColumn !== undefined) {
    conditions.push(`${view.schemaColumn} = ${sqlString(dataset)}`);
  }
  return `(SELECT * FROM _bq."${view.duckdbView}" WHERE ${conditions.join(' AND ')})`;
}

function resolveInformationSchemaScope(
  segments: readonly PrefixSegment[],
  currentProject: string,
): { project: string; dataset: string | null } {
  const isRegion = (s: PrefixSegment): boolean => /^region-/i.test(s.text);
  const nonRegion = segments.filter((s) => !isRegion(s));
  const hasRegion = segments.some(isRegion);
  if (nonRegion.length === 0) {
    // Pure region prefix like `region-us` — current project, no dataset filter.
    return { project: currentProject, dataset: null };
  }
  if (nonRegion.length === 1) {
    const only = nonRegion[0] as PrefixSegment;
    if (hasRegion || only.fromMultiBacktick) {
      // `project.region` form — the single segment is a project; region scope.
      return { project: only.text, dataset: null };
    }
    // Single bare identifier — treat as a dataset in the current project.
    return { project: currentProject, dataset: only.text };
  }
  // Two non-region segments: `project.dataset`.
  const [proj, ds] = nonRegion as [PrefixSegment, PrefixSegment];
  return { project: proj.text, dataset: ds.text };
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Backticks → DuckDB quoted identifiers
// ---------------------------------------------------------------------------

function rewriteBacktick(tok: Token, currentProject: string): string {
  // `proj.dataset.table` → "<proj>__<dataset>"."<table>"
  // `dataset.table`      → "<currentProject>__<dataset>"."<table>"
  // `name`               → "name"   (column refs, aliases — unchanged)
  const inner = tok.value.slice(1, -1); // strip backticks
  const parts = inner.split('.').filter((p) => p !== '');
  const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  if (parts.length === 3) {
    const [proj, ds, tbl] = parts as [string, string, string];
    return `${q(`${proj}__${ds}`)}.${q(tbl)}`;
  }
  if (parts.length === 2) {
    const [ds, tbl] = parts as [string, string];
    return `${q(`${currentProject}__${ds}`)}.${q(tbl)}`;
  }
  return parts.map(q).join('.');
}

// ---------------------------------------------------------------------------
// Named params → positional placeholders
// ---------------------------------------------------------------------------

function rewriteParameter(tok: Token, paramOrder: string[]): string {
  const name = tok.value.slice(1); // strip leading '@'
  let idx = paramOrder.indexOf(name);
  if (idx === -1) {
    paramOrder.push(name);
    idx = paramOrder.length - 1;
  }
  return `$${idx + 1}`;
}

// ---------------------------------------------------------------------------
// Identifier-as-function-call dispatch
// ---------------------------------------------------------------------------

function handleIdentifier(
  tokens: readonly Token[],
  i: number,
  endIdx: number,
  out: string[],
  paramOrder: string[],
  project: string,
): number {
  const tok = tokens[i];
  if (tok === undefined) return i + 1;
  const upper = tok.value.toUpperCase();

  // `SELECT * EXCEPT (cols)` → DuckDB `* EXCLUDE (cols)`. Only when EXCEPT
  // directly follows `*` and precedes `(` — otherwise it's the set operator.
  if (upper === 'EXCEPT') {
    let prevIdx = i - 1;
    while (prevIdx >= 0 && isSkippable(tokens[prevIdx] as Token)) prevIdx -= 1;
    const prev = prevIdx >= 0 ? tokens[prevIdx] : undefined;
    const nextIdx = skipWhitespace(tokens, i + 1, endIdx);
    const next = nextIdx !== null ? tokens[nextIdx] : undefined;
    if (
      prev?.kind === 'operator' &&
      prev.value === '*' &&
      next?.kind === 'punctuation' &&
      next.value === '('
    ) {
      out.push('EXCLUDE');
      return i + 1;
    }
  }

  // `SAFE.<FN>(args)` — BQ's SAFE prefix wraps any scalar function so errors
  // return NULL. DuckDB has `try(expr)` with the same semantics; emit
  // `try(<FN>(args))` after recursing through the args.
  if (upper === 'SAFE') {
    const dotIdx = skipWhitespace(tokens, i + 1, endIdx);
    if (dotIdx !== null) {
      const dotTok = tokens[dotIdx];
      if (dotTok?.kind === 'punctuation' && dotTok.value === '.') {
        const fnIdx = skipWhitespace(tokens, dotIdx + 1, endIdx);
        const fnTok = fnIdx !== null ? tokens[fnIdx] : undefined;
        if (fnTok?.kind === 'identifier' && fnIdx !== null) {
          const openParen = findFollowingOpenParen(tokens, fnIdx + 1, endIdx);
          if (openParen !== null) {
            const close = findMatchingClose(tokens, openParen, endIdx);
            const innerArgs = translateRange(tokens, openParen + 1, close, paramOrder, project);
            out.push(`try(${fnTok.value}(${innerArgs}))`);
            return close + 1;
          }
        }
      }
    }
  }

  // `NET.<FN>(…)` — the BQ Net library. DuckDB has no equivalents, so we
  // surface a precise unsupported error rather than passing through and
  // letting DuckDB say "function does not exist". The dotted name tokenizes
  // as IDENT "NET" + PUNCT "." + IDENT "<FN>" — peek the next two tokens.
  if (upper === 'NET') {
    const dotIdx = skipWhitespace(tokens, i + 1, endIdx);
    if (dotIdx !== null) {
      const dotTok = tokens[dotIdx];
      if (dotTok?.kind === 'punctuation' && dotTok.value === '.') {
        const fnIdx = skipWhitespace(tokens, dotIdx + 1, endIdx);
        const fnTok = fnIdx !== null ? tokens[fnIdx] : undefined;
        if (fnTok?.kind === 'identifier') {
          throw BqError.unsupportedFeature(
            `BigQuery feature not supported in v0: NET.${fnTok.value}`,
            `NET.${fnTok.value}`,
          );
        }
      }
    }
  }

  // `TIMESTAMP 'literal'` typed-literal. BigQuery's TIMESTAMP is timezone-
  // aware (always UTC if no zone given); DuckDB's bare `TIMESTAMP 'x'`
  // produces a *timezone-naive* TIMESTAMP that we'd then encode as DATETIME.
  // Rewrite to `TIMESTAMPTZ 'x'` so the value flows through as BQ TIMESTAMP.
  // Only fires when the next non-whitespace token is a string literal —
  // bare `TIMESTAMP` in CAST / column-type context is left alone.
  if (upper === 'TIMESTAMP') {
    const nextIdx = skipWhitespace(tokens, i + 1, endIdx);
    if (nextIdx !== null && tokens[nextIdx]?.kind === 'string') {
      out.push('TIMESTAMPTZ');
      return i + 1;
    }
  }

  // `NUMERIC '123.456'` / `BIGNUMERIC '...'` typed-string literals.
  // DuckDB doesn't accept this syntax — rewrite to a cast.
  if (upper === 'NUMERIC' || upper === 'BIGNUMERIC') {
    const nextIdx = skipWhitespace(tokens, i + 1, endIdx);
    if (nextIdx !== null) {
      const literal = tokens[nextIdx];
      if (literal?.kind === 'string') {
        out.push(`CAST(${literal.value} AS DECIMAL(38, 9))`);
        return nextIdx + 1;
      }
    }
  }

  // `TABLESAMPLE SYSTEM (n PERCENT)` → BERNOULLI. DuckDB's SYSTEM samples whole
  // storage blocks, so on small/in-memory tables N% rounds to all-or-nothing;
  // BERNOULLI is row-level and gives the ~N%-of-rows callers expect.
  if (upper === 'TABLESAMPLE') {
    const nextIdx = skipWhitespace(tokens, i + 1, endIdx);
    if (nextIdx !== null) {
      const next = tokens[nextIdx];
      if (next?.kind === 'identifier' && next.value.toUpperCase() === 'SYSTEM') {
        out.push(tok.value);
        for (let k = i + 1; k < nextIdx; k += 1) {
          out.push((tokens[k] as Token).value);
        }
        out.push('BERNOULLI');
        return nextIdx + 1;
      }
    }
  }

  // `IN UNNEST(<expr>)` → `= ANY (<expr>)`. DuckDB doesn't accept the BQ
  // `IN UNNEST(array)` membership idiom but does accept `= ANY(array)`.
  if (upper === 'IN') {
    const unnestIdx = skipWhitespace(tokens, i + 1, endIdx);
    if (unnestIdx !== null) {
      const next = tokens[unnestIdx];
      if (next?.kind === 'identifier' && next.value.toUpperCase() === 'UNNEST') {
        const openParen = findFollowingOpenParen(tokens, unnestIdx + 1, endIdx);
        if (openParen !== null) {
          // Emit `= ANY (`; the main loop will translate the contents
          // (including any param rewrites) and the closing `)` flows
          // through as a regular punctuation token.
          out.push('= ANY (');
          return openParen + 1;
        }
      }
    }
    out.push(tok.value);
    return i + 1;
  }

  // If this identifier is immediately followed by `(`, it's a function call.
  // Otherwise it's just a name (column, table, alias) — pass it through.
  const parenIdx = findFollowingOpenParen(tokens, i + 1, endIdx);
  if (parenIdx === null) {
    if (UNSUPPORTED_FUNCTIONS.has(upper)) {
      throw BqError.unsupportedFeature(
        `BigQuery feature not supported in v0: ${tok.value}`,
        tok.value,
      );
    }
    // BL-096 — pseudo columns for ingestion-time partitioning. BigQuery
    // exposes the partition boundary as `_PARTITIONTIME` (TIMESTAMP)
    // and `_PARTITIONDATE` (DATE). We back both with a hidden
    // `_partition_time` column that insertAll auto-populates.
    if (upper === '_PARTITIONTIME') {
      out.push('"_partition_time"');
      return i + 1;
    }
    if (upper === '_PARTITIONDATE') {
      out.push('CAST("_partition_time" AS DATE)');
      return i + 1;
    }
    // Bare BQ type identifiers (CAST(x AS FLOAT64), etc.) — DuckDB
    // doesn't know FLOAT64/INT64/BOOL/BYTES under those names.
    const typeAlias = BQ_TYPE_ALIAS_FOR_CAST.get(upper);
    if (typeAlias !== undefined) {
      out.push(typeAlias);
      return i + 1;
    }
    if (DUCKDB_RESERVED_BUT_BQ_ALLOWED.has(upper)) {
      out.push(`"${tok.value.replace(/"/g, '""')}"`);
      return i + 1;
    }
    out.push(tok.value);
    return i + 1;
  }

  // It's a function call (`name(`). Dispatch to the per-family rewrite map.
  const handler = CALL_HANDLERS.get(upper);
  if (handler !== undefined) {
    const ctx: RewriteCtx = {
      tokens,
      i,
      parenIdx,
      endIdx,
      out,
      funcName: tok.value,
      tr: (start, end) => translateRange(tokens, start, end, paramOrder, project),
    };
    return handler(ctx);
  }

  if (UNSUPPORTED_FUNCTIONS.has(upper)) {
    throw BqError.unsupportedFeature(
      `BigQuery feature not supported in v0: ${tok.value}`,
      tok.value,
    );
  }
  const renamed = FUNCTION_RENAMES.get(upper);
  if (renamed !== undefined) {
    out.push(renamed);
    return i + 1;
  }
  // Pass-through: STARTS_WITH / ENDS_WITH and any name DuckDB accepts.
  out.push(tok.value);
  return i + 1;
}

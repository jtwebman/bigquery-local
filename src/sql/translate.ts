/**
 * BigQuery SQL → DuckDB SQL translator.
 *
 * Not a parser — a targeted token-stream rewriter. We pass through most
 * of the SQL unchanged and rewrite a fixed set of BQ-isms that DuckDB
 * doesn't accept verbatim:
 *
 *   `proj.dataset.table` (backtick)   →  "<proj>__<dataset>"."<table>"
 *   `dataset.table`                   →  "<current-proj>__<dataset>"."<table>"
 *   `name`                            →  "name"
 *
 * The "current project" comes from the request's URL path (`/projects/{p}/…`).
 * `dataset_schema_name(project, dataset) = project__dataset` keeps two
 * projects with the same dataset id from colliding at the DuckDB layer.
 *   @paramName                        →  $N (positional; paramOrder lists names)
 *   CURRENT_TIMESTAMP()               →  CURRENT_TIMESTAMP
 *   TIMESTAMP_SUB(x, INTERVAL n U)    →  (x - INTERVAL n U)
 *   TIMESTAMP_ADD(x, INTERVAL n U)    →  (x + INTERVAL n U)
 *   JSON_VALUE(j, '$.path')           →  json_extract_string(j, '$.path')
 *   SAFE_CAST(x AS T)                 →  try_cast(x AS T)
 *   STARTS_WITH / ENDS_WITH           →  pass-through (DuckDB has them)
 *
 * Known-unsupported BigQuery functions throw `BqError.unsupportedFeature`
 * so the caller surfaces a precise error to the API client. Anything else
 * is passed through verbatim — if it's a DuckDB-compatible identifier or
 * function, it just works; if it isn't, DuckDB itself returns the error
 * and the route layer turns that into a 400.
 */

import { BqError } from '../util/errors.ts';
import { type Token, tokenize } from './tokenize.ts';

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

/**
 * BQ function name → DuckDB function name, for the cases where the names
 * differ but the call signatures match closely enough that a name swap is
 * the whole rewrite.
 *
 * Functions whose BQ and DuckDB names *match* (case-insensitive — DuckDB
 * is case-insensitive on function names) don't need an entry here; the
 * translator's default branch passes them through verbatim.
 *
 * Functions that need *more* than a rename (e.g. argument reshuffle,
 * wrapper call) live as explicit `case` branches in `handleIdentifier`.
 */
const FUNCTION_RENAMES: ReadonlyMap<string, string> = new Map([
  ['JSON_VALUE', 'json_extract_string'],
  ['SAFE_CAST', 'try_cast'],
  // BL-037 — strings:
  ['REGEXP_CONTAINS', 'regexp_matches'],
  ['FORMAT', 'printf'],
  ['NORMALIZE', 'nfc_normalize'],
  // DuckDB's `length()` is char count; `strlen()` is byte count, matching
  // BigQuery's OCTET_LENGTH for STRING.
  ['OCTET_LENGTH', 'strlen'],
  // BL-038 — numeric/math:
  ['IS_INF', 'isinf'],
  ['IS_NAN', 'isnan'],
  // BL-040 — date/time (2): straight renames.
  ['UNIX_MILLIS', 'epoch_ms'],
  ['UNIX_MICROS', 'epoch_us'],
  ['LAST_DAY', 'last_day'],
]);

/** A small list of BQ functions we explicitly call out as unsupported, so
 * the error is "BigQuery feature not supported in v0" rather than a vague
 * DuckDB "function does not exist". Grow this as we hit real cases. */
const UNSUPPORTED_FUNCTIONS = new Set([
  'FARM_FINGERPRINT',
  'APPROX_COUNT_DISTINCT',
  'APPROX_QUANTILES',
  'GENERATE_UUID',
  'NET.IP_FROM_STRING',
  'ST_GEOGFROMTEXT',
  'ST_INTERSECTS',
  'ST_DISTANCE',
  'ML.PREDICT',
  'ML.EVALUATE',
  'SEARCH',
  'VECTOR_SEARCH',
]);

export function translate(sql: string, options: TranslateOptions): TranslateResult {
  const tokens = tokenize(sql);
  const paramOrder: string[] = [];
  const out = translateRange(tokens, 0, tokens.length, paramOrder, options.project);
  return { sql: out, paramOrder };
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
      case 'identifier':
        i = handleIdentifier(tokens, i, endIdx, out, paramOrder, project);
        break;
      default:
        out.push(tok.value);
        i += 1;
        break;
    }
  }
  return out.join('');
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
    out.push(tok.value);
    return i + 1;
  }

  switch (upper) {
    case 'CURRENT_TIMESTAMP': {
      const close = findMatchingClose(tokens, parenIdx, endIdx);
      if (areArgsEmpty(tokens, parenIdx, close)) {
        out.push('CURRENT_TIMESTAMP');
        return close + 1;
      }
      // CURRENT_TIMESTAMP(...) with args — let DuckDB handle / fail naturally.
      out.push(tok.value);
      return i + 1;
    }

    case 'TIMESTAMP_SUB':
      return rewriteTimestampArith(tokens, i, parenIdx, endIdx, '-', out, paramOrder, project);

    case 'TIMESTAMP_ADD':
      return rewriteTimestampArith(tokens, i, parenIdx, endIdx, '+', out, paramOrder, project);

    case 'NORMALIZE_AND_CASEFOLD':
      // BQ has it natively; DuckDB has nfc_normalize() and lower(), so we
      // synthesize the composition: NORMALIZE_AND_CASEFOLD(x[, form])
      // becomes lower(nfc_normalize(x[, form])).
      return wrapCall(tokens, parenIdx, endIdx, 'lower(nfc_normalize', out, paramOrder, project);

    case 'REGEXP_REPLACE':
      // DuckDB's regexp_replace replaces only the FIRST match by default.
      // BigQuery replaces ALL. Add a 'g' (global) options arg so the
      // semantics line up.
      return rewriteRegexpReplace(tokens, parenIdx, endIdx, out, paramOrder, project);

    case 'SAFE_DIVIDE':
      // BQ: returns NULL if denominator is 0. `x / NULLIF(y, 0)` gives the
      // same shape using only standard SQL.
      return rewriteTwoArg(
        tokens,
        parenIdx,
        endIdx,
        (a, b) => `(${a} / NULLIF(${b}, 0))`,
        out,
        paramOrder,
        project,
        tok.value,
      );

    case 'TIMESTAMP_TRUNC':
    case 'DATETIME_TRUNC':
      // BQ: TRUNC(ts, DAY)  →  DuckDB: date_trunc('day', ts)
      return rewritePartArg2(
        tokens,
        parenIdx,
        endIdx,
        'date_trunc',
        '',
        out,
        paramOrder,
        project,
        tok.value,
      );

    case 'DATE_TRUNC':
      // DuckDB's date_trunc always returns TIMESTAMP; BQ's DATE_TRUNC
      // returns DATE. Cast back so the wire format is YYYY-MM-DD.
      return rewritePartArg2(
        tokens,
        parenIdx,
        endIdx,
        'date_trunc',
        '::DATE',
        out,
        paramOrder,
        project,
        tok.value,
      );

    case 'FORMAT_TIMESTAMP':
    case 'FORMAT_DATE':
    case 'FORMAT_DATETIME':
      // BQ: FORMAT_X(format, ts)  →  DuckDB: strftime(ts, format)
      return rewriteTwoArg(
        tokens,
        parenIdx,
        endIdx,
        (fmt, x) => `strftime(${x}, ${fmt})`,
        out,
        paramOrder,
        project,
        tok.value,
      );

    case 'PARSE_TIMESTAMP':
    case 'PARSE_DATETIME':
      // BQ: PARSE_X(format, str)  →  DuckDB: strptime(str, format)
      return rewriteTwoArg(
        tokens,
        parenIdx,
        endIdx,
        (fmt, s) => `strptime(${s}, ${fmt})`,
        out,
        paramOrder,
        project,
        tok.value,
      );

    case 'PARSE_DATE':
      // strptime returns TIMESTAMP; PARSE_DATE in BQ returns DATE.
      return rewriteTwoArg(
        tokens,
        parenIdx,
        endIdx,
        (fmt, s) => `CAST(strptime(${s}, ${fmt}) AS DATE)`,
        out,
        paramOrder,
        project,
        tok.value,
      );

    case 'GENERATE_DATE_ARRAY':
      // BQ: GENERATE_DATE_ARRAY(start, end[, INTERVAL step part])
      // DuckDB: generate_series returns TIMESTAMP[]; cast each to DATE.
      return rewriteGenerateArray(
        tokens,
        parenIdx,
        endIdx,
        '::DATE',
        out,
        paramOrder,
        project,
        tok.value,
      );

    case 'GENERATE_TIMESTAMP_ARRAY':
      // Already TIMESTAMP[]; no cast needed.
      return rewriteGenerateArray(
        tokens,
        parenIdx,
        endIdx,
        '',
        out,
        paramOrder,
        project,
        tok.value,
      );

    case 'DATE_FROM_UNIX_DATE':
      // BQ: DATE_FROM_UNIX_DATE(int_days_since_epoch) → DATE.
      // DuckDB has no direct function; compose via INTERVAL.
      return rewriteOneArg(
        tokens,
        parenIdx,
        endIdx,
        (x) => `CAST(DATE '1970-01-01' + INTERVAL (${x}) DAY AS DATE)`,
        out,
        paramOrder,
        project,
        tok.value,
      );

    case 'UNIX_DATE':
      // BQ: UNIX_DATE(date) → INT64 days since 1970-01-01.
      return rewriteOneArg(
        tokens,
        parenIdx,
        endIdx,
        (x) => `date_diff('day', DATE '1970-01-01', ${x})`,
        out,
        paramOrder,
        project,
        tok.value,
      );

    case 'UNIX_SECONDS':
      // DuckDB's `epoch(ts)` returns DOUBLE; cast to BIGINT so the wire
      // type is INT64 (matching BigQuery's UNIX_SECONDS return type).
      return rewriteOneArg(
        tokens,
        parenIdx,
        endIdx,
        (x) => `CAST(epoch(${x}) AS BIGINT)`,
        out,
        paramOrder,
        project,
        tok.value,
      );

    case 'DATE_DIFF':
    case 'TIMESTAMP_DIFF':
    case 'DATETIME_DIFF':
      // BQ: X_DIFF(a, b, PART)  →  DuckDB: date_diff('part', b, a)
      // (BQ's a - b in `part` units equals DuckDB's `from b to a`.)
      return rewriteDiff(tokens, parenIdx, endIdx, out, paramOrder, project, tok.value);

    case 'IEEE_DIVIDE':
      // BQ: IEEE 754 semantics (±Inf, NaN) for FLOAT64 divide. DuckDB's
      // DOUBLE / DOUBLE already follows IEEE 754, so casting both sides
      // to DOUBLE is sufficient.
      return rewriteTwoArg(
        tokens,
        parenIdx,
        endIdx,
        (a, b) => `(CAST(${a} AS DOUBLE) / CAST(${b} AS DOUBLE))`,
        out,
        paramOrder,
        project,
        tok.value,
      );

    default: {
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
      // Pass-through (covers STARTS_WITH / ENDS_WITH and every other
      // function whose name DuckDB happens to accept).
      out.push(tok.value);
      return i + 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Wrap-a-call helper: emit `prefix(<recurse on args>)` where `prefix` already
// includes opening parens (e.g. `lower(nfc_normalize` for two-deep wrapping).
// ---------------------------------------------------------------------------

function wrapCall(
  tokens: readonly Token[],
  openParenIdx: number,
  endIdx: number,
  prefix: string,
  out: string[],
  paramOrder: string[],
  project: string,
): number {
  const close = findMatchingClose(tokens, openParenIdx, endIdx);
  const inner = translateRange(tokens, openParenIdx + 1, close, paramOrder, project);
  // `prefix` already contains the *outer* wrapping calls' opening parens
  // (e.g. `lower(nfc_normalize` has one). We add one more `(` for the
  // innermost call, then close all of them. The original `)` (at `close`)
  // is consumed — we return `close + 1`.
  const fullPrefix = `${prefix}(`;
  const opens = (fullPrefix.match(/\(/g) ?? []).length;
  out.push(`${fullPrefix}${inner}${')'.repeat(opens)}`);
  return close + 1;
}

/** Generic 1-arg function rewrite. Recursively translates the arg, then
 * composes via `template(x)`. */
function rewriteOneArg(
  tokens: readonly Token[],
  openParenIdx: number,
  endIdx: number,
  template: (x: string) => string,
  out: string[],
  paramOrder: string[],
  project: string,
  funcName: string,
): number {
  const close = findMatchingClose(tokens, openParenIdx, endIdx);
  // No commas allowed at top level — exactly one arg.
  if (findTopLevelComma(tokens, openParenIdx + 1, close) !== null) {
    throw BqError.invalid(`${funcName} requires exactly one argument.`, funcName);
  }
  const x = translateRange(tokens, openParenIdx + 1, close, paramOrder, project).trim();
  out.push(template(x));
  return close + 1;
}

/** GENERATE_DATE_ARRAY / GENERATE_TIMESTAMP_ARRAY rewrite. Emits
 *  `generate_series(start, end[, step])[::DATE[]]`. */
function rewriteGenerateArray(
  tokens: readonly Token[],
  openParenIdx: number,
  endIdx: number,
  /** Trailing element-cast (e.g. `::DATE`) or empty. The emit applies it
   * to each element via list_transform. */
  elementCast: string,
  out: string[],
  paramOrder: string[],
  project: string,
  funcName: string,
): number {
  const close = findMatchingClose(tokens, openParenIdx, endIdx);
  // Translate the inner range as-is — start, end, optional INTERVAL step.
  const inner = translateRange(tokens, openParenIdx + 1, close, paramOrder, project).trim();
  if (inner === '') {
    throw BqError.invalid(`${funcName} requires at least (start, end).`, funcName);
  }
  if (elementCast === '') {
    out.push(`generate_series(${inner})`);
  } else {
    out.push(`list_transform(generate_series(${inner}), x -> CAST(x AS ${elementCast.slice(2)}))`);
  }
  return close + 1;
}

/** Generic 2-arg function rewrite. Splits at the top-level comma,
 * recursively translates each arg, then composes via `template(a, b)`. */
function rewriteTwoArg(
  tokens: readonly Token[],
  openParenIdx: number,
  endIdx: number,
  template: (a: string, b: string) => string,
  out: string[],
  paramOrder: string[],
  project: string,
  funcName: string,
): number {
  const close = findMatchingClose(tokens, openParenIdx, endIdx);
  const commaIdx = findTopLevelComma(tokens, openParenIdx + 1, close);
  if (commaIdx === null) {
    throw BqError.invalid(`${funcName} requires two arguments.`, funcName);
  }
  const arg1 = translateRange(tokens, openParenIdx + 1, commaIdx, paramOrder, project).trim();
  const arg2 = translateRange(tokens, commaIdx + 1, close, paramOrder, project).trim();
  out.push(template(arg1, arg2));
  return close + 1;
}

/** Rewrite TIMESTAMP_TRUNC / DATETIME_TRUNC family:
 *   BQ: TRUNC(ts, PART) →  DuckDB: date_trunc('part', ts)
 * Drops the BigQuery keyword form (DAY/HOUR/etc.) to a lowercase string. */
function rewritePartArg2(
  tokens: readonly Token[],
  openParenIdx: number,
  endIdx: number,
  duckFn: string,
  /** Trailing cast (e.g. "::DATE") or empty string. */
  suffix: string,
  out: string[],
  paramOrder: string[],
  project: string,
  funcName: string,
): number {
  const close = findMatchingClose(tokens, openParenIdx, endIdx);
  const commaIdx = findTopLevelComma(tokens, openParenIdx + 1, close);
  if (commaIdx === null) {
    throw BqError.invalid(`${funcName} requires (timestamp, PART).`, funcName);
  }
  const tsArg = translateRange(tokens, openParenIdx + 1, commaIdx, paramOrder, project).trim();
  const part = sliceTokens(tokens, commaIdx + 1, close)
    .trim()
    .toLowerCase();
  out.push(`${duckFn}('${part}', ${tsArg})${suffix}`);
  return close + 1;
}

/** Rewrite X_DIFF family:
 *   BQ: X_DIFF(a, b, PART) →  DuckDB: date_diff('part', b, a)
 * BQ computes a - b in the given part; DuckDB computes "from start to end",
 * so we swap a and b to get the same sign. */
function rewriteDiff(
  tokens: readonly Token[],
  openParenIdx: number,
  endIdx: number,
  out: string[],
  paramOrder: string[],
  project: string,
  funcName: string,
): number {
  const close = findMatchingClose(tokens, openParenIdx, endIdx);
  const commaIdx1 = findTopLevelComma(tokens, openParenIdx + 1, close);
  if (commaIdx1 === null) {
    throw BqError.invalid(`${funcName} requires three arguments.`, funcName);
  }
  const commaIdx2 = findTopLevelComma(tokens, commaIdx1 + 1, close);
  if (commaIdx2 === null) {
    throw BqError.invalid(`${funcName} requires three arguments.`, funcName);
  }
  const a = translateRange(tokens, openParenIdx + 1, commaIdx1, paramOrder, project).trim();
  const b = translateRange(tokens, commaIdx1 + 1, commaIdx2, paramOrder, project).trim();
  const part = sliceTokens(tokens, commaIdx2 + 1, close)
    .trim()
    .toLowerCase();
  out.push(`date_diff('${part}', ${b}, ${a})`);
  return close + 1;
}

/** Rewrite BQ `REGEXP_REPLACE(s, pattern, replacement)` →
 *  DuckDB `regexp_replace(s, pattern, replacement, 'g')`. The trailing
 *  `'g'` switches DuckDB to global (replace-all), matching BQ's behavior. */
function rewriteRegexpReplace(
  tokens: readonly Token[],
  openParenIdx: number,
  endIdx: number,
  out: string[],
  paramOrder: string[],
  project: string,
): number {
  const close = findMatchingClose(tokens, openParenIdx, endIdx);
  const inner = translateRange(tokens, openParenIdx + 1, close, paramOrder, project).trim();
  out.push(`regexp_replace(${inner}, 'g')`);
  return close + 1;
}

// ---------------------------------------------------------------------------
// TIMESTAMP_SUB / TIMESTAMP_ADD rewrite
// ---------------------------------------------------------------------------

function rewriteTimestampArith(
  tokens: readonly Token[],
  funcIdx: number,
  openParenIdx: number,
  endIdx: number,
  op: '-' | '+',
  out: string[],
  paramOrder: string[],
  project: string,
): number {
  const close = findMatchingClose(tokens, openParenIdx, endIdx);
  const commaIdx = findTopLevelComma(tokens, openParenIdx + 1, close);
  const funcTok = tokens[funcIdx];
  if (commaIdx === null) {
    throw BqError.invalid(
      `${funcTok?.value ?? 'TIMESTAMP_SUB'} requires two arguments.`,
      funcTok?.value ?? 'TIMESTAMP_SUB',
    );
  }
  // Arg 1 is an arbitrary expression — recurse to apply any nested rewrites.
  const arg1 = translateRange(tokens, openParenIdx + 1, commaIdx, paramOrder, project).trim();
  // Arg 2 is the INTERVAL clause; pass through verbatim (trimmed).
  const arg2 = sliceTokens(tokens, commaIdx + 1, close).trim();
  out.push(`(${arg1} ${op} ${arg2})`);
  return close + 1;
}

// ---------------------------------------------------------------------------
// Token-stream helpers
// ---------------------------------------------------------------------------

/** Returns the index of the first non-whitespace token in [start, end), or
 * null if none exists. */
function skipWhitespace(tokens: readonly Token[], start: number, end: number): number | null {
  for (let j = start; j < end; j += 1) {
    const t = tokens[j];
    if (t === undefined) return null;
    if (t.kind !== 'whitespace' && t.kind !== 'line-comment' && t.kind !== 'block-comment') {
      return j;
    }
  }
  return null;
}

function findFollowingOpenParen(
  tokens: readonly Token[],
  start: number,
  end: number,
): number | null {
  const idx = skipWhitespace(tokens, start, end);
  if (idx === null) return null;
  const t = tokens[idx];
  if (t === undefined) return null;
  if (t.kind === 'punctuation' && t.value === '(') return idx;
  return null;
}

function findMatchingClose(tokens: readonly Token[], openIdx: number, end: number): number {
  let depth = 0;
  for (let j = openIdx; j < end; j += 1) {
    const t = tokens[j];
    if (t === undefined) continue;
    if (t.kind === 'punctuation' && t.value === '(') depth += 1;
    else if (t.kind === 'punctuation' && t.value === ')') {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  throw BqError.invalid('Unbalanced parentheses in SQL.', 'sql');
}

function findTopLevelComma(
  tokens: readonly Token[],
  start: number,
  closeIdx: number,
): number | null {
  let depth = 0;
  for (let j = start; j < closeIdx; j += 1) {
    const t = tokens[j];
    if (t === undefined) continue;
    if (t.kind === 'punctuation' && t.value === '(') depth += 1;
    else if (t.kind === 'punctuation' && t.value === ')') depth -= 1;
    else if (t.kind === 'punctuation' && t.value === ',' && depth === 0) {
      return j;
    }
  }
  return null;
}

function areArgsEmpty(tokens: readonly Token[], openIdx: number, closeIdx: number): boolean {
  for (let j = openIdx + 1; j < closeIdx; j += 1) {
    const t = tokens[j];
    if (t === undefined) continue;
    if (t.kind !== 'whitespace' && t.kind !== 'line-comment' && t.kind !== 'block-comment') {
      return false;
    }
  }
  return true;
}

function sliceTokens(tokens: readonly Token[], startIdx: number, endIdx: number): string {
  let out = '';
  for (let j = startIdx; j < endIdx; j += 1) {
    const t = tokens[j];
    if (t === undefined) continue;
    out += t.value;
  }
  return out;
}

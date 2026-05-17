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
  // BL-042 — arrays: BQ GENERATE_ARRAY/FLATTEN don't exist in DuckDB by
  // those names; the semantics map directly.
  ['GENERATE_ARRAY', 'generate_series'],
  ['FLATTEN', 'flatten'],
  // BL-043 — aggregates:
  ['STRING_AGG', 'string_agg'],
  ['LOGICAL_AND', 'bool_and'],
  ['LOGICAL_OR', 'bool_or'],
  // BL-041 — JSON:
  ['JSON_QUERY', 'json_extract'],
  ['JSON_QUERY_ARRAY', 'json_extract'],
  ['JSON_VALUE_ARRAY', 'json_extract_string'],
  ['JSON_TYPE', 'json_type'],
  ['JSON_KEYS', 'json_keys'],
  ['TO_JSON', 'to_json'],
  ['TO_JSON_STRING', 'to_json'],
]);

/** A small list of BQ functions we explicitly call out as unsupported, so
 * the error is "BigQuery feature not supported in v0" rather than a vague
 * DuckDB "function does not exist". Grow this as we hit real cases. */
const UNSUPPORTED_FUNCTIONS = new Set([
  // FARM_FINGERPRINT uses FarmHash specifically; DuckDB's hash() is a
  // different algorithm and would not return matching values.
  'FARM_FINGERPRINT',
  // DuckDB has no SHA512.
  'SHA512',
  // APPROX_COUNT_DISTINCT is supported (BL-045) — pass-through to DuckDB.
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

export type StatementType =
  | 'SELECT'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'MERGE'
  | 'CREATE_VIEW'
  | 'DROP_VIEW';

/**
 * Classifies a BQ SQL string by its leading keyword. Skips whitespace,
 * comments, and a leading `WITH … AS (…)` CTE block — a `WITH` that ends
 * in an INSERT/UPDATE/DELETE still classifies as DML.
 */
export function detectStatementType(sql: string): StatementType {
  const tokens = tokenize(sql);
  let i = 0;
  while (i < tokens.length && isSkippable(tokens[i] as Token)) i += 1;
  const first = tokens[i];
  if (first === undefined) return 'SELECT';
  if (first.kind !== 'identifier') return 'SELECT';
  const head = first.value.toUpperCase();
  if (head === 'INSERT') return 'INSERT';
  if (head === 'UPDATE') return 'UPDATE';
  if (head === 'DELETE') return 'DELETE';
  if (head === 'MERGE') return 'MERGE';
  if (head === 'CREATE') {
    // Look ahead past OR REPLACE, TEMP|TEMPORARY for the object kind.
    const kindIdx = findNextKeyword(tokens, i + 1, ['VIEW', 'TABLE', 'SCHEMA']);
    if (kindIdx !== null && tokens[kindIdx]?.value.toUpperCase() === 'VIEW') {
      return 'CREATE_VIEW';
    }
  }
  if (head === 'DROP') {
    const kindIdx = findNextKeyword(tokens, i + 1, ['VIEW', 'TABLE', 'SCHEMA']);
    if (kindIdx !== null && tokens[kindIdx]?.value.toUpperCase() === 'VIEW') {
      return 'DROP_VIEW';
    }
  }
  if (head === 'WITH') {
    // Skip past the CTE definitions to the trailing statement keyword.
    const after = skipCteBlock(tokens, i + 1);
    if (after !== null) {
      const trailing = tokens[after];
      if (trailing?.kind === 'identifier') {
        const tail = trailing.value.toUpperCase();
        if (tail === 'INSERT') return 'INSERT';
        if (tail === 'UPDATE') return 'UPDATE';
        if (tail === 'DELETE') return 'DELETE';
        if (tail === 'MERGE') return 'MERGE';
      }
    }
  }
  return 'SELECT';
}

/**
 * Resolves a CREATE [OR REPLACE] [TEMP] VIEW [IF NOT EXISTS] / DROP VIEW
 * [IF EXISTS] target into its (project, dataset, view) triple, plus the
 * raw BQ AS-clause SQL for CREATE (used to populate `view.query` in
 * tables.get). The default project applies when the SQL omits one.
 */
export interface ViewDdlTarget {
  readonly kind: 'CREATE_VIEW' | 'DROP_VIEW';
  readonly project: string;
  readonly datasetId: string;
  readonly viewId: string;
  /** Raw SELECT text after `AS`, or undefined for DROP VIEW. */
  readonly viewQuery?: string;
}

export function parseViewDdl(sql: string, defaultProject: string): ViewDdlTarget {
  const tokens = tokenize(sql);
  let i = 0;
  while (i < tokens.length && isSkippable(tokens[i] as Token)) i += 1;
  const first = tokens[i];
  if (first === undefined || first.kind !== 'identifier') {
    throw BqError.invalid('Expected a CREATE VIEW or DROP VIEW statement.', 'query');
  }
  const head = first.value.toUpperCase();
  if (head !== 'CREATE' && head !== 'DROP') {
    throw BqError.invalid('Expected a CREATE VIEW or DROP VIEW statement.', 'query');
  }
  const viewKw = findNextKeyword(tokens, i + 1, ['VIEW']);
  if (viewKw === null) {
    throw BqError.invalid('Expected VIEW keyword after CREATE / DROP.', 'query');
  }
  // Move past VIEW, then optional IF [NOT] EXISTS.
  let j = nextNonSkippable(tokens, viewKw + 1);
  if (tokens[j]?.kind === 'identifier' && tokens[j]?.value.toUpperCase() === 'IF') {
    j = nextNonSkippable(tokens, j + 1);
    if (tokens[j]?.kind === 'identifier' && tokens[j]?.value.toUpperCase() === 'NOT') {
      j = nextNonSkippable(tokens, j + 1);
    }
    if (tokens[j]?.kind === 'identifier' && tokens[j]?.value.toUpperCase() === 'EXISTS') {
      j = nextNonSkippable(tokens, j + 1);
    }
  }
  const targetTok = tokens[j];
  if (targetTok === undefined) {
    throw BqError.invalid('Expected a view name.', 'query');
  }
  const { project, datasetId, viewId } = parseTableTarget(tokens, j, defaultProject);
  if (head === 'DROP') {
    return { kind: 'DROP_VIEW', project, datasetId, viewId };
  }
  // CREATE: find the AS keyword and capture everything past it as the view body.
  const after = advancePastTarget(tokens, j);
  const asIdx = findNextKeyword(tokens, after, ['AS']);
  if (asIdx === null) {
    throw BqError.invalid('CREATE VIEW requires an AS <query> body.', 'query');
  }
  const bodyStart = tokens[asIdx]?.end ?? sql.length;
  const viewQuery = sql.slice(bodyStart).trim();
  return { kind: 'CREATE_VIEW', project, datasetId, viewId, viewQuery };
}

function parseTableTarget(
  tokens: readonly Token[],
  start: number,
  defaultProject: string,
): { project: string; datasetId: string; viewId: string } {
  const tok = tokens[start];
  if (tok === undefined) {
    throw BqError.invalid('Expected a table reference.', 'query');
  }
  // Backtick form: `project.dataset.view` or `dataset.view`.
  if (tok.kind === 'backtick-identifier') {
    const inner = tok.value.slice(1, -1);
    const parts = inner.split('.');
    if (parts.length === 3) {
      return {
        project: parts[0] as string,
        datasetId: parts[1] as string,
        viewId: parts[2] as string,
      };
    }
    if (parts.length === 2) {
      return {
        project: defaultProject,
        datasetId: parts[0] as string,
        viewId: parts[1] as string,
      };
    }
    throw BqError.invalid(
      `Unsupported view reference \`${inner}\` — expected dataset.view or project.dataset.view.`,
      'query',
    );
  }
  // Bare-identifier form: IDENT . IDENT [. IDENT].
  if (tok.kind === 'identifier') {
    const parts: string[] = [tok.value];
    let i = nextNonSkippable(tokens, start + 1);
    while (tokens[i]?.kind === 'punctuation' && tokens[i]?.value === '.') {
      const next = nextNonSkippable(tokens, i + 1);
      const id = tokens[next];
      if (id?.kind !== 'identifier') break;
      parts.push(id.value);
      i = nextNonSkippable(tokens, next + 1);
    }
    if (parts.length === 3) {
      return {
        project: parts[0] as string,
        datasetId: parts[1] as string,
        viewId: parts[2] as string,
      };
    }
    if (parts.length === 2) {
      return {
        project: defaultProject,
        datasetId: parts[0] as string,
        viewId: parts[1] as string,
      };
    }
    throw BqError.invalid(
      `View reference must include a dataset (got "${parts.join('.')}").`,
      'query',
    );
  }
  throw BqError.invalid(`Unexpected token "${tok.value}" where a view name was expected.`, 'query');
}

function advancePastTarget(tokens: readonly Token[], start: number): number {
  const tok = tokens[start];
  if (tok?.kind === 'backtick-identifier') return nextNonSkippable(tokens, start + 1);
  let i = nextNonSkippable(tokens, start + 1);
  while (tokens[i]?.kind === 'punctuation' && tokens[i]?.value === '.') {
    const next = nextNonSkippable(tokens, i + 1);
    if (tokens[next]?.kind !== 'identifier') break;
    i = nextNonSkippable(tokens, next + 1);
  }
  return i;
}

function findNextKeyword(
  tokens: readonly Token[],
  start: number,
  keywords: readonly string[],
): number | null {
  for (let i = start; i < tokens.length; i += 1) {
    const tok = tokens[i] as Token;
    if (tok.kind !== 'identifier') continue;
    if (keywords.includes(tok.value.toUpperCase())) return i;
  }
  return null;
}

function nextNonSkippable(tokens: readonly Token[], start: number): number {
  let i = start;
  while (i < tokens.length && isSkippable(tokens[i] as Token)) i += 1;
  return i;
}

function isSkippable(tok: Token): boolean {
  return tok.kind === 'whitespace' || tok.kind === 'line-comment' || tok.kind === 'block-comment';
}

function skipCteBlock(tokens: readonly Token[], start: number): number | null {
  let i = start;
  let depth = 0;
  while (i < tokens.length) {
    const tok = tokens[i] as Token;
    if (tok.kind === 'punctuation') {
      if (tok.value === '(') depth += 1;
      else if (tok.value === ')') depth -= 1;
    }
    if (depth === 0 && tok.kind === 'identifier') {
      const word = tok.value.toUpperCase();
      if (
        word === 'SELECT' ||
        word === 'INSERT' ||
        word === 'UPDATE' ||
        word === 'DELETE' ||
        word === 'MERGE'
      ) {
        return i;
      }
    }
    i += 1;
  }
  return null;
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

    case 'COUNTIF':
      // BQ: COUNTIF(cond)  →  DuckDB: COUNT(*) FILTER (WHERE cond)
      return rewriteOneArg(
        tokens,
        parenIdx,
        endIdx,
        (cond) => `COUNT(*) FILTER (WHERE ${cond})`,
        out,
        paramOrder,
        project,
        tok.value,
      );

    case 'ARRAY_CONCAT_AGG':
      // BQ: ARRAY_CONCAT_AGG(arr) flattens NULLs out and concatenates.
      // DuckDB equivalent: flatten(array_agg(x) FILTER (WHERE x IS NOT NULL)).
      return rewriteOneArg(
        tokens,
        parenIdx,
        endIdx,
        (x) => `flatten(array_agg(${x}) FILTER (WHERE ${x} IS NOT NULL))`,
        out,
        paramOrder,
        project,
        tok.value,
      );

    case 'OFFSET':
    case 'SAFE_OFFSET':
      // BQ: `arr[OFFSET(n)]` is 0-indexed; SAFE_OFFSET returns NULL on
      // out-of-range. DuckDB subscripts are 1-indexed and silently NULL on
      // out-of-range, so both BQ forms reduce to `n + 1` after the rewrite.
      return rewriteOneArg(
        tokens,
        parenIdx,
        endIdx,
        (n) => `(${n} + 1)`,
        out,
        paramOrder,
        project,
        tok.value,
      );

    case 'ORDINAL':
      // BQ: `arr[ORDINAL(n)]` is 1-indexed — matches DuckDB directly.
      return rewriteOneArg(
        tokens,
        parenIdx,
        endIdx,
        (n) => `(${n})`,
        out,
        paramOrder,
        project,
        tok.value,
      );

    case 'PARSE_JSON':
      // BQ: PARSE_JSON(str) → JSON. DuckDB: CAST(str AS JSON).
      return rewriteOneArg(
        tokens,
        parenIdx,
        endIdx,
        (x) => `CAST(${x} AS JSON)`,
        out,
        paramOrder,
        project,
        tok.value,
      );

    case 'BOOL':
    case 'INT64':
    case 'FLOAT64':
      // BQ: BOOL(json) / INT64(json) / FLOAT64(json) — extract a scalar.
      // DuckDB: CAST(json AS type) handles the same shape for primitives.
      return rewriteOneArg(
        tokens,
        parenIdx,
        endIdx,
        (x) =>
          `CAST(${x} AS ${upper === 'INT64' ? 'BIGINT' : upper === 'FLOAT64' ? 'DOUBLE' : 'BOOLEAN'})`,
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

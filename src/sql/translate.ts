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
  // BL-128/129 — GEOGRAPHY via the DuckDB spatial extension. DuckDB
  // uses ST_GeomFromText / ST_Point; BQ uses the ST_GEOG* spellings.
  // Most other ST_* names are identical (case-insensitive in DuckDB).
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
  // DuckDB has no SHA512.
  'SHA512',
  // APPROX_COUNT_DISTINCT is supported (BL-045) — pass-through to DuckDB.
  'APPROX_QUANTILES',
  'GENERATE_UUID',
  'NET.IP_FROM_STRING',
  'ML.PREDICT',
  'ML.EVALUATE',
  'SEARCH',
  'VECTOR_SEARCH',
]);

/**
 * Identifiers DuckDB reserves but BigQuery does not, so a user's BQ
 * query can legally reference a bare column with one of these names —
 * and DuckDB would parse-error before our translator could help.
 *
 * Excluded: identifiers reserved in both dialects (WINDOW, RANGE,
 * INTERVAL, QUALIFY, ...) — BQ users must backtick-quote those anyway,
 * and that path translates to DuckDB double-quotes. Also excluded:
 * DuckDB-only words used as operators / clause syntax we must emit
 * verbatim (PIVOT, UNPIVOT, GLOB, ILIKE, SIMILAR, TRY_CAST, BOTH,
 * LEADING, TRAILING, ASYMMETRIC, SYMMETRIC, PLACING, VARIADIC).
 */
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
  | 'TRUNCATE_TABLE'
  | 'CREATE_VIEW'
  | 'DROP_VIEW'
  | 'CREATE_MATERIALIZED_VIEW'
  | 'DROP_MATERIALIZED_VIEW'
  | 'CREATE_SCHEMA'
  | 'DROP_SCHEMA'
  | 'CREATE_FUNCTION'
  | 'DROP_FUNCTION'
  | 'CREATE_TABLE_FUNCTION'
  | 'DROP_TABLE_FUNCTION'
  | 'CREATE_PROCEDURE'
  | 'DROP_PROCEDURE'
  | 'SCRIPT';

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
  if (head === 'TRUNCATE') return 'TRUNCATE_TABLE';
  if (
    head === 'BEGIN' ||
    head === 'START' ||
    head === 'DECLARE' ||
    head === 'SET' ||
    head === 'IF' ||
    head === 'CALL' ||
    head === 'RETURN' ||
    head === 'LOOP' ||
    head === 'WHILE' ||
    head === 'REPEAT' ||
    head === 'FOR' ||
    head === 'EXECUTE'
  ) {
    return 'SCRIPT';
  }
  if (head === 'CREATE') {
    // Look ahead past OR REPLACE, TEMP|TEMPORARY for the object kind.
    const kindIdx = findNextKeyword(tokens, i + 1, [
      'VIEW',
      'TABLE',
      'SCHEMA',
      'FUNCTION',
      'PROCEDURE',
      'MATERIALIZED',
    ]);
    const kw = kindIdx !== null ? tokens[kindIdx]?.value.toUpperCase() : undefined;
    if (kw === 'MATERIALIZED' && kindIdx !== null) {
      // `MATERIALIZED VIEW` — distinct from `VIEW` (BL-101).
      const after = nextNonSkippable(tokens, kindIdx + 1);
      if (tokens[after]?.kind === 'identifier' && tokens[after]?.value.toUpperCase() === 'VIEW') {
        return 'CREATE_MATERIALIZED_VIEW';
      }
    }
    if (kw === 'VIEW') return 'CREATE_VIEW';
    if (kw === 'SCHEMA') return 'CREATE_SCHEMA';
    if (kw === 'FUNCTION') return 'CREATE_FUNCTION';
    if (kw === 'PROCEDURE') return 'CREATE_PROCEDURE';
    if (kw === 'TABLE' && kindIdx !== null) {
      // `TABLE FUNCTION` (TVF) — distinct from plain `CREATE TABLE`.
      const after = nextNonSkippable(tokens, kindIdx + 1);
      if (
        tokens[after]?.kind === 'identifier' &&
        tokens[after]?.value.toUpperCase() === 'FUNCTION'
      ) {
        return 'CREATE_TABLE_FUNCTION';
      }
    }
  }
  if (head === 'DROP') {
    const kindIdx = findNextKeyword(tokens, i + 1, [
      'VIEW',
      'TABLE',
      'SCHEMA',
      'FUNCTION',
      'PROCEDURE',
      'MATERIALIZED',
    ]);
    const kw = kindIdx !== null ? tokens[kindIdx]?.value.toUpperCase() : undefined;
    if (kw === 'MATERIALIZED' && kindIdx !== null) {
      const after = nextNonSkippable(tokens, kindIdx + 1);
      if (tokens[after]?.kind === 'identifier' && tokens[after]?.value.toUpperCase() === 'VIEW') {
        return 'DROP_MATERIALIZED_VIEW';
      }
    }
    if (kw === 'VIEW') return 'DROP_VIEW';
    if (kw === 'SCHEMA') return 'DROP_SCHEMA';
    if (kw === 'FUNCTION') return 'DROP_FUNCTION';
    if (kw === 'PROCEDURE') return 'DROP_PROCEDURE';
    if (kw === 'TABLE' && kindIdx !== null) {
      const after = nextNonSkippable(tokens, kindIdx + 1);
      if (
        tokens[after]?.kind === 'identifier' &&
        tokens[after]?.value.toUpperCase() === 'FUNCTION'
      ) {
        return 'DROP_TABLE_FUNCTION';
      }
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
  readonly kind:
    | 'CREATE_VIEW'
    | 'DROP_VIEW'
    | 'CREATE_MATERIALIZED_VIEW'
    | 'DROP_MATERIALIZED_VIEW';
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
  // Optional `MATERIALIZED` modifier — turns this into a MV DDL.
  const materializedKw = findNextKeyword(tokens, i + 1, ['MATERIALIZED']);
  const viewKw = findNextKeyword(tokens, i + 1, ['VIEW']);
  if (viewKw === null) {
    throw BqError.invalid('Expected VIEW keyword after CREATE / DROP.', 'query');
  }
  const materialized = materializedKw !== null && materializedKw < viewKw;
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
    return {
      kind: materialized ? 'DROP_MATERIALIZED_VIEW' : 'DROP_VIEW',
      project,
      datasetId,
      viewId,
    };
  }
  // CREATE: find the AS keyword and capture everything past it as the view body.
  const after = advancePastTarget(tokens, j);
  const asIdx = findNextKeyword(tokens, after, ['AS']);
  if (asIdx === null) {
    throw BqError.invalid('CREATE VIEW requires an AS <query> body.', 'query');
  }
  const bodyStart = tokens[asIdx]?.end ?? sql.length;
  const viewQuery = sql.slice(bodyStart).trim();
  return {
    kind: materialized ? 'CREATE_MATERIALIZED_VIEW' : 'CREATE_VIEW',
    project,
    datasetId,
    viewId,
    viewQuery,
  };
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

/**
 * Resolves `CREATE SCHEMA [IF NOT EXISTS] <name>` / `DROP SCHEMA
 * [IF EXISTS] <name> [CASCADE]` into its (project, datasetId) target.
 * Names may be backtick-quoted (`\`project.dataset\``) or bare
 * (`project.dataset` / `dataset`).
 */
export interface SchemaDdlTarget {
  readonly kind: 'CREATE_SCHEMA' | 'DROP_SCHEMA';
  readonly project: string;
  readonly datasetId: string;
  readonly ifExists: boolean;
  readonly ifNotExists: boolean;
  readonly cascade: boolean;
}

export function parseSchemaDdl(sql: string, defaultProject: string): SchemaDdlTarget {
  const tokens = tokenize(sql);
  let i = 0;
  while (i < tokens.length && isSkippable(tokens[i] as Token)) i += 1;
  const first = tokens[i];
  if (first === undefined || first.kind !== 'identifier') {
    throw BqError.invalid('Expected a CREATE SCHEMA or DROP SCHEMA statement.', 'query');
  }
  const head = first.value.toUpperCase();
  if (head !== 'CREATE' && head !== 'DROP') {
    throw BqError.invalid('Expected a CREATE SCHEMA or DROP SCHEMA statement.', 'query');
  }
  const schemaKw = findNextKeyword(tokens, i + 1, ['SCHEMA']);
  if (schemaKw === null) {
    throw BqError.invalid('Expected SCHEMA keyword after CREATE / DROP.', 'query');
  }
  let j = nextNonSkippable(tokens, schemaKw + 1);
  let ifNotExists = false;
  let ifExists = false;
  if (tokens[j]?.kind === 'identifier' && tokens[j]?.value.toUpperCase() === 'IF') {
    j = nextNonSkippable(tokens, j + 1);
    if (tokens[j]?.kind === 'identifier' && tokens[j]?.value.toUpperCase() === 'NOT') {
      j = nextNonSkippable(tokens, j + 1);
      if (tokens[j]?.kind === 'identifier' && tokens[j]?.value.toUpperCase() === 'EXISTS') {
        ifNotExists = true;
        j = nextNonSkippable(tokens, j + 1);
      }
    } else if (tokens[j]?.kind === 'identifier' && tokens[j]?.value.toUpperCase() === 'EXISTS') {
      ifExists = true;
      j = nextNonSkippable(tokens, j + 1);
    }
  }
  const { project, datasetId } = parseSchemaName(tokens, j, defaultProject);
  // Walk past the schema name to look for CASCADE.
  const after = advancePastTarget(tokens, j);
  let cascade = false;
  for (let k = after; k < tokens.length; k += 1) {
    const tok = tokens[k] as Token;
    if (tok.kind === 'identifier' && tok.value.toUpperCase() === 'CASCADE') {
      cascade = true;
      break;
    }
  }
  return {
    kind: head === 'CREATE' ? 'CREATE_SCHEMA' : 'DROP_SCHEMA',
    project,
    datasetId,
    ifExists,
    ifNotExists,
    cascade,
  };
}

function parseSchemaName(
  tokens: readonly Token[],
  start: number,
  defaultProject: string,
): { project: string; datasetId: string } {
  const tok = tokens[start];
  if (tok === undefined) {
    throw BqError.invalid('Expected a schema name.', 'query');
  }
  if (tok.kind === 'backtick-identifier') {
    const inner = tok.value.slice(1, -1);
    const parts = inner.split('.');
    if (parts.length === 2) {
      return { project: parts[0] as string, datasetId: parts[1] as string };
    }
    if (parts.length === 1) {
      return { project: defaultProject, datasetId: parts[0] as string };
    }
    throw BqError.invalid(
      `Unsupported schema reference \`${inner}\` — expected dataset or project.dataset.`,
      'query',
    );
  }
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
    if (parts.length === 2) {
      return { project: parts[0] as string, datasetId: parts[1] as string };
    }
    if (parts.length === 1) {
      return { project: defaultProject, datasetId: parts[0] as string };
    }
    throw BqError.invalid(
      `Schema reference "${parts.join('.')}" must be a dataset or project.dataset.`,
      'query',
    );
  }
  throw BqError.invalid(
    `Unexpected token "${tok.value}" where a schema name was expected.`,
    'query',
  );
}

/**
 * Resolves `CREATE [OR REPLACE] [TEMP|TEMPORARY] FUNCTION [IF NOT EXISTS]
 * <name>(<args>) [RETURNS <type>] AS (<expr>) | AS """<expr>"""` and the
 * corresponding `DROP FUNCTION` form into a structured target.
 *
 * Argument types and the RETURNS type are captured but DuckDB's CREATE
 * MACRO doesn't enforce them — the queryEngine wraps the body in
 * `CAST(... AS <duck_type>)` to honor RETURNS.
 *
 * For TEMP functions, BQ accepts an unqualified `<function_name>`. For
 * persistent ones, a `<dataset>.<name>` or `<project>.<dataset>.<name>`
 * reference is required.
 */
export interface FunctionDdlArg {
  readonly name: string;
  /** Raw BQ type text as written — e.g. "INT64", "ARRAY<STRING>". */
  readonly typeText: string;
}

export interface FunctionDdlTarget {
  readonly kind:
    | 'CREATE_FUNCTION'
    | 'DROP_FUNCTION'
    | 'CREATE_TABLE_FUNCTION'
    | 'DROP_TABLE_FUNCTION';
  readonly project: string;
  /** Undefined for TEMP functions, which don't live in a dataset. */
  readonly datasetId: string | undefined;
  readonly functionId: string;
  readonly isTemp: boolean;
  readonly isTableValued: boolean;
  readonly orReplace: boolean;
  readonly ifNotExists: boolean;
  readonly ifExists: boolean;
  /** Empty for DROP and TEMP without an explicit ARGS list, populated for CREATE. */
  readonly args: readonly FunctionDdlArg[];
  /** Raw BQ return type text, or undefined when not specified.
   *  For TVFs this is the `TABLE<col1 type1, ...>` text (informational only;
   *  DuckDB infers the schema from the body's SELECT). */
  readonly returnType: string | undefined;
  /** Body text (a scalar expression, or a SELECT for a TVF), without the
   *  wrapping parens or triple quotes. */
  readonly body: string | undefined;
}

export function parseFunctionDdl(sql: string, defaultProject: string): FunctionDdlTarget {
  const tokens = tokenize(sql);
  let i = 0;
  while (i < tokens.length && isSkippable(tokens[i] as Token)) i += 1;
  const first = tokens[i];
  if (first === undefined || first.kind !== 'identifier') {
    throw BqError.invalid('Expected a CREATE FUNCTION or DROP FUNCTION statement.', 'query');
  }
  const head = first.value.toUpperCase();
  if (head !== 'CREATE' && head !== 'DROP') {
    throw BqError.invalid('Expected a CREATE FUNCTION or DROP FUNCTION statement.', 'query');
  }

  let orReplace = false;
  let isTemp = false;
  let cursor = nextNonSkippable(tokens, i + 1);

  if (head === 'CREATE') {
    // OR REPLACE
    if (
      isIdentKeyword(tokens[cursor], 'OR') &&
      isIdentKeyword(tokens[nextNonSkippable(tokens, cursor + 1)], 'REPLACE')
    ) {
      orReplace = true;
      cursor = nextNonSkippable(tokens, nextNonSkippable(tokens, cursor + 1) + 1);
    }
    // TEMP / TEMPORARY
    if (isIdentKeyword(tokens[cursor], 'TEMP') || isIdentKeyword(tokens[cursor], 'TEMPORARY')) {
      isTemp = true;
      cursor = nextNonSkippable(tokens, cursor + 1);
    }
  }

  // BQ TVF: `TABLE FUNCTION` instead of just `FUNCTION`.
  let isTableValued = false;
  if (isIdentKeyword(tokens[cursor], 'TABLE')) {
    isTableValued = true;
    cursor = nextNonSkippable(tokens, cursor + 1);
  }
  if (!isIdentKeyword(tokens[cursor], 'FUNCTION')) {
    throw BqError.invalid('Expected FUNCTION keyword after CREATE / DROP.', 'query');
  }
  cursor = nextNonSkippable(tokens, cursor + 1);

  let ifNotExists = false;
  let ifExists = false;
  if (isIdentKeyword(tokens[cursor], 'IF')) {
    cursor = nextNonSkippable(tokens, cursor + 1);
    if (head === 'CREATE' && isIdentKeyword(tokens[cursor], 'NOT')) {
      cursor = nextNonSkippable(tokens, cursor + 1);
      if (isIdentKeyword(tokens[cursor], 'EXISTS')) {
        ifNotExists = true;
        cursor = nextNonSkippable(tokens, cursor + 1);
      }
    } else if (head === 'DROP' && isIdentKeyword(tokens[cursor], 'EXISTS')) {
      ifExists = true;
      cursor = nextNonSkippable(tokens, cursor + 1);
    }
  }

  const { project, datasetId, functionId } = parseFunctionName(
    tokens,
    cursor,
    defaultProject,
    isTemp,
  );
  cursor = advancePastTarget(tokens, cursor);

  if (head === 'DROP') {
    return {
      kind: isTableValued ? 'DROP_TABLE_FUNCTION' : 'DROP_FUNCTION',
      project,
      datasetId,
      functionId,
      isTemp,
      isTableValued,
      orReplace,
      ifNotExists: false,
      ifExists,
      args: [],
      returnType: undefined,
      body: undefined,
    };
  }

  // CREATE: parse `( arg_name arg_type, ... )` argument list.
  if (tokens[cursor]?.kind !== 'punctuation' || tokens[cursor]?.value !== '(') {
    throw BqError.invalid('Expected `(` after function name.', 'query');
  }
  const argsClose = findMatchingParenClose(tokens, cursor);
  const args = parseFunctionArgs(tokens, cursor + 1, argsClose);
  cursor = nextNonSkippable(tokens, argsClose + 1);

  // Optional RETURNS <type>
  let returnType: string | undefined;
  if (isIdentKeyword(tokens[cursor], 'RETURNS')) {
    cursor = nextNonSkippable(tokens, cursor + 1);
    const typeStart = cursor;
    cursor = consumeTypeText(tokens, cursor);
    returnType = joinTokenRange(tokens, typeStart, cursor, sql).trim();
  }

  // AS body — either `(expr)` or `"""expr"""` / `'''expr'''`.
  if (!isIdentKeyword(tokens[cursor], 'AS')) {
    throw BqError.invalid('Expected AS clause in CREATE FUNCTION.', 'query');
  }
  cursor = nextNonSkippable(tokens, cursor + 1);
  const bodyTok = tokens[cursor];
  let body: string | undefined;
  if (bodyTok?.kind === 'punctuation' && bodyTok.value === '(') {
    const close = findMatchingParenClose(tokens, cursor);
    // Inside the parens, slice from after `(` to before `)`.
    const startOff = tokens[cursor + 1]?.start ?? bodyTok.end;
    const endOff = tokens[close]?.start ?? sql.length;
    body = sql.slice(startOff, endOff).trim();
  } else if (bodyTok?.kind === 'string') {
    body = unwrapStringLiteral(bodyTok.value).trim();
  } else {
    throw BqError.invalid('Expected `(expr)` or `"""expr"""` body in CREATE FUNCTION.', 'query');
  }

  return {
    kind: isTableValued ? 'CREATE_TABLE_FUNCTION' : 'CREATE_FUNCTION',
    project,
    datasetId,
    functionId,
    isTemp,
    isTableValued,
    orReplace,
    ifNotExists,
    ifExists: false,
    args,
    returnType,
    body,
  };
}

/**
 * Parses CREATE / DROP PROCEDURE statements. Procedures have typed args
 * (no DEFAULT in v0; arg-mode keywords IN/OUT/INOUT recognized and the
 * mode captured), no RETURNS, and a `BEGIN … END` body that the script
 * interpreter executes when CALLed.
 */
export interface ProcedureArg {
  readonly name: string;
  /** Raw BQ type text. */
  readonly typeText: string;
  /** BQ-style parameter mode. Defaults to 'IN' when not specified. */
  readonly mode: 'IN' | 'OUT' | 'INOUT';
}

export interface ProcedureDdlTarget {
  readonly kind: 'CREATE_PROCEDURE' | 'DROP_PROCEDURE';
  readonly project: string;
  readonly datasetId: string;
  readonly procedureId: string;
  readonly orReplace: boolean;
  readonly ifNotExists: boolean;
  readonly ifExists: boolean;
  readonly args: readonly ProcedureArg[];
  /** Full `BEGIN … END` body text. Undefined for DROP. */
  readonly body: string | undefined;
}

export function parseProcedureDdl(sql: string, defaultProject: string): ProcedureDdlTarget {
  const tokens = tokenize(sql);
  let i = 0;
  while (i < tokens.length && isSkippable(tokens[i] as Token)) i += 1;
  const first = tokens[i];
  if (first === undefined || first.kind !== 'identifier') {
    throw BqError.invalid('Expected a CREATE PROCEDURE or DROP PROCEDURE statement.', 'query');
  }
  const head = first.value.toUpperCase();
  if (head !== 'CREATE' && head !== 'DROP') {
    throw BqError.invalid('Expected a CREATE PROCEDURE or DROP PROCEDURE statement.', 'query');
  }
  let orReplace = false;
  let cursor = nextNonSkippable(tokens, i + 1);
  if (head === 'CREATE') {
    if (
      isIdentKeyword(tokens[cursor], 'OR') &&
      isIdentKeyword(tokens[nextNonSkippable(tokens, cursor + 1)], 'REPLACE')
    ) {
      orReplace = true;
      cursor = nextNonSkippable(tokens, nextNonSkippable(tokens, cursor + 1) + 1);
    }
  }
  if (!isIdentKeyword(tokens[cursor], 'PROCEDURE')) {
    throw BqError.invalid('Expected PROCEDURE keyword after CREATE / DROP.', 'query');
  }
  cursor = nextNonSkippable(tokens, cursor + 1);

  let ifNotExists = false;
  let ifExists = false;
  if (isIdentKeyword(tokens[cursor], 'IF')) {
    cursor = nextNonSkippable(tokens, cursor + 1);
    if (head === 'CREATE' && isIdentKeyword(tokens[cursor], 'NOT')) {
      cursor = nextNonSkippable(tokens, cursor + 1);
      if (isIdentKeyword(tokens[cursor], 'EXISTS')) {
        ifNotExists = true;
        cursor = nextNonSkippable(tokens, cursor + 1);
      }
    } else if (head === 'DROP' && isIdentKeyword(tokens[cursor], 'EXISTS')) {
      ifExists = true;
      cursor = nextNonSkippable(tokens, cursor + 1);
    }
  }

  // A procedure name must be dataset-qualified. parseFunctionName with
  // isTemp=false enforces that.
  const named = parseFunctionName(tokens, cursor, defaultProject, false);
  cursor = advancePastTarget(tokens, cursor);
  if (named.datasetId === undefined) {
    throw BqError.invalid('Procedure name must be dataset-qualified.', 'query');
  }
  const datasetId = named.datasetId;

  if (head === 'DROP') {
    return {
      kind: 'DROP_PROCEDURE',
      project: named.project,
      datasetId,
      procedureId: named.functionId,
      orReplace,
      ifNotExists: false,
      ifExists,
      args: [],
      body: undefined,
    };
  }

  // CREATE: parse `( arg_name arg_type, ... )` argument list — with optional
  // IN / OUT / INOUT mode prefix.
  if (tokens[cursor]?.kind !== 'punctuation' || tokens[cursor]?.value !== '(') {
    throw BqError.invalid('Expected `(` after procedure name.', 'query');
  }
  const argsClose = findMatchingParenClose(tokens, cursor);
  const args = parseProcedureArgs(tokens, cursor + 1, argsClose);
  cursor = nextNonSkippable(tokens, argsClose + 1);

  // OPTIONS (…) is permitted by BQ but ignored in v0.
  if (isIdentKeyword(tokens[cursor], 'OPTIONS')) {
    const optsOpen = nextNonSkippable(tokens, cursor + 1);
    if (tokens[optsOpen]?.kind === 'punctuation' && tokens[optsOpen]?.value === '(') {
      const optsClose = findMatchingParenClose(tokens, optsOpen);
      cursor = nextNonSkippable(tokens, optsClose + 1);
    }
  }

  // Body — BEGIN … END (including the keywords, so the script interpreter
  // sees a proper block).
  if (!isIdentKeyword(tokens[cursor], 'BEGIN')) {
    throw BqError.invalid('CREATE PROCEDURE body must start with BEGIN.', 'query');
  }
  const bodyStart = cursor;
  const bodyEnd = findProcedureBodyEnd(tokens, cursor);
  const body = joinTokenRange(tokens, bodyStart, bodyEnd, sql);

  return {
    kind: 'CREATE_PROCEDURE',
    project: named.project,
    datasetId,
    procedureId: named.functionId,
    orReplace,
    ifNotExists,
    ifExists: false,
    args,
    body,
  };
}

function parseProcedureArgs(tokens: readonly Token[], start: number, end: number): ProcedureArg[] {
  const args: ProcedureArg[] = [];
  let i = start;
  while (i < end) {
    while (i < end && isSkippable(tokens[i] as Token)) i += 1;
    if (i >= end) break;
    // Optional mode prefix: IN / OUT / INOUT.
    let mode: 'IN' | 'OUT' | 'INOUT' = 'IN';
    let nameIdx = i;
    const peek = tokens[i] as Token;
    if (peek.kind === 'identifier') {
      const up = peek.value.toUpperCase();
      if (up === 'IN' || up === 'OUT' || up === 'INOUT') {
        const afterMode = nextNonSkippable(tokens, i + 1);
        const next = tokens[afterMode];
        // Only treat as a mode if the next token is an identifier (the arg
        // name). Otherwise the user might have named their var `in`.
        if (next?.kind === 'identifier') {
          mode = up as 'IN' | 'OUT' | 'INOUT';
          nameIdx = afterMode;
        }
      }
    }
    const nameTok = tokens[nameIdx];
    if (nameTok?.kind !== 'identifier') {
      throw BqError.invalid('Expected argument name in procedure definition.', 'query');
    }
    i = nextNonSkippable(tokens, nameIdx + 1);
    const typeStart = i;
    let depth = 0;
    while (i < end) {
      const tok = tokens[i] as Token;
      if (tok.kind === 'punctuation') {
        if (tok.value === '(' || tok.value === '<') depth += 1;
        else if (tok.value === ')' || tok.value === '>') depth -= 1;
        else if (tok.value === ',' && depth === 0) break;
      } else if (tok.kind === 'operator') {
        if (tok.value === '<') depth += 1;
        else if (tok.value === '>') depth -= 1;
      }
      i += 1;
    }
    const typeText = sliceTokens(tokens, typeStart, i).trim();
    args.push({ name: nameTok.value, typeText, mode });
    if (i < end && tokens[i]?.kind === 'punctuation' && tokens[i]?.value === ',') i += 1;
  }
  return args;
}

/** Find the index just past the matching END of a procedure body's
 *  `BEGIN … END` block. */
function findProcedureBodyEnd(tokens: readonly Token[], startIdx: number): number {
  let i = startIdx + 1;
  let depth = 1; // already inside the leading BEGIN
  while (i < tokens.length) {
    const t = tokens[i] as Token;
    if (t.kind === 'identifier') {
      const up = t.value.toUpperCase();
      if (
        up === 'BEGIN' ||
        up === 'IF' ||
        up === 'LOOP' ||
        up === 'WHILE' ||
        up === 'REPEAT' ||
        up === 'FOR'
      ) {
        depth += 1;
      } else if (up === 'END') {
        depth -= 1;
        if (depth === 0) return i + 1;
        // Step past matching keyword for END IF / LOOP / WHILE / REPEAT / FOR.
        const after = nextNonSkippable(tokens, i + 1);
        const next = tokens[after];
        const closesCompound =
          next?.kind === 'identifier' &&
          ['IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR'].includes(next.value.toUpperCase());
        if (closesCompound) i = after;
      }
    }
    i += 1;
  }
  return tokens.length;
}

function isIdentKeyword(tok: Token | undefined, kw: string): boolean {
  return tok?.kind === 'identifier' && tok.value.toUpperCase() === kw;
}

function findMatchingParenClose(tokens: readonly Token[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i += 1) {
    const tok = tokens[i] as Token;
    if (tok.kind === 'punctuation') {
      if (tok.value === '(') depth += 1;
      else if (tok.value === ')') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
  }
  throw BqError.invalid('Unmatched `(` in DDL.', 'query');
}

function parseFunctionArgs(tokens: readonly Token[], start: number, end: number): FunctionDdlArg[] {
  const args: FunctionDdlArg[] = [];
  let i = start;
  while (i < end) {
    while (i < end && isSkippable(tokens[i] as Token)) i += 1;
    if (i >= end) break;
    const nameTok = tokens[i];
    if (nameTok?.kind !== 'identifier') {
      throw BqError.invalid('Expected argument name in function definition.', 'query');
    }
    i = nextNonSkippable(tokens, i + 1);
    const typeStart = i;
    // Argument type runs until the next `,` (at the top level) or end.
    let depth = 0;
    while (i < end) {
      const tok = tokens[i] as Token;
      if (tok.kind === 'punctuation') {
        if (tok.value === '(' || tok.value === '<') depth += 1;
        else if (tok.value === ')' || tok.value === '>') depth -= 1;
        else if (tok.value === ',' && depth === 0) break;
      } else if (tok.kind === 'operator') {
        if (tok.value === '<') depth += 1;
        else if (tok.value === '>') depth -= 1;
      }
      i += 1;
    }
    const typeText = sliceTokens(tokens, typeStart, i).trim();
    args.push({ name: nameTok.value, typeText });
    if (i < end && tokens[i]?.kind === 'punctuation' && tokens[i]?.value === ',') i += 1;
  }
  return args;
}

function consumeTypeText(tokens: readonly Token[], start: number): number {
  let i = start;
  let depth = 0;
  while (i < tokens.length) {
    const tok = tokens[i] as Token;
    if (tok.kind === 'identifier' && depth === 0) {
      if (tok.value.toUpperCase() === 'AS') break;
    }
    if (tok.kind === 'operator') {
      if (tok.value === '<') depth += 1;
      else if (tok.value === '>') depth -= 1;
    }
    if (tok.kind === 'punctuation') {
      if (tok.value === '(' || tok.value === '<') depth += 1;
      else if (tok.value === ')' || tok.value === '>') depth -= 1;
    }
    i += 1;
  }
  return i;
}

function joinTokenRange(tokens: readonly Token[], start: number, end: number, sql: string): string {
  if (start >= end) return '';
  const a = (tokens[start] as Token).start;
  const b = (tokens[end - 1] as Token).end;
  return sql.slice(a, b);
}

function unwrapStringLiteral(value: string): string {
  // Triple-quoted: """...""" or '''...'''
  if (value.startsWith('"""') && value.endsWith('"""')) return value.slice(3, -3);
  if (value.startsWith("'''") && value.endsWith("'''")) return value.slice(3, -3);
  // Single-quoted (with backslash escapes already preserved verbatim).
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function parseFunctionName(
  tokens: readonly Token[],
  start: number,
  defaultProject: string,
  isTemp: boolean,
): { project: string; datasetId: string | undefined; functionId: string } {
  const tok = tokens[start];
  if (tok === undefined) {
    throw BqError.invalid('Expected a function name.', 'query');
  }
  if (tok.kind === 'backtick-identifier') {
    const inner = tok.value.slice(1, -1);
    const parts = inner.split('.');
    if (parts.length === 3) {
      return {
        project: parts[0] as string,
        datasetId: parts[1] as string,
        functionId: parts[2] as string,
      };
    }
    if (parts.length === 2) {
      return {
        project: defaultProject,
        datasetId: parts[0] as string,
        functionId: parts[1] as string,
      };
    }
    if (parts.length === 1 && isTemp) {
      return { project: defaultProject, datasetId: undefined, functionId: parts[0] as string };
    }
    throw BqError.invalid(`Unsupported function reference \`${inner}\`.`, 'query');
  }
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
        functionId: parts[2] as string,
      };
    }
    if (parts.length === 2) {
      return {
        project: defaultProject,
        datasetId: parts[0] as string,
        functionId: parts[1] as string,
      };
    }
    if (parts.length === 1 && isTemp) {
      return { project: defaultProject, datasetId: undefined, functionId: parts[0] as string };
    }
    throw BqError.invalid(
      `Function reference "${parts.join('.')}" must be dataset-qualified.`,
      'query',
    );
  }
  throw BqError.invalid(
    `Unexpected token "${tok.value}" where a function name was expected.`,
    'query',
  );
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
  /** Some views (JOBS*, SCHEMATA*) are project-scoped only — no
   * per-dataset filter applies even when the caller wrote
   * `dataset.INFORMATION_SCHEMA.X`. `undefined` means "ignore dataset
   * even if one was named". */
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
 * If the tokens starting at `i` form a `<prefix>.INFORMATION_SCHEMA.<view>`
 * reference, return the DuckDB-side rewrite plus the index to resume at.
 * Otherwise return null and let the regular translator path handle the
 * tokens.
 *
 * Accepts prefix shapes:
 *   `\`region-us\``                      — region-scoped, current project
 *   `\`project.region-us\``              — region-scoped, named project
 *   `\`project.dataset\``                — dataset-scoped, named project
 *   `dataset`                            — dataset-scoped, current project
 *   `project.dataset`                    — dataset-scoped, named project
 *
 * Region segments (any segment starting with `region-`) just drop out of
 * the filter — the emulator doesn't track regions, so a region-scoped
 * query returns all datasets in the project.
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

  // `TABLESAMPLE SYSTEM (n PERCENT)` — BQ's SYSTEM is storage-block-based,
  // matching DuckDB's SYSTEM. But DuckDB's SYSTEM only emits whole storage
  // blocks, which for small / in-memory tables means N% of "one block" rounds
  // to all-or-nothing. BERNOULLI is row-level uniform sampling and gives the
  // ~N%-of-rows result callers expect from `SYSTEM (n PERCENT)`.
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
    if (DUCKDB_RESERVED_BUT_BQ_ALLOWED.has(upper)) {
      out.push(`"${tok.value.replace(/"/g, '""')}"`);
      return i + 1;
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

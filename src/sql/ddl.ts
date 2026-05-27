/**
 * BigQuery DDL & statement-classification parsing. Splits CREATE/DROP for
 * views, schemas, functions, and procedures into structured targets, and
 * classifies a statement by its leading keyword. Token-walking only — no
 * SQL execution; the queryEngine consumes these results.
 */

import { BqError } from '../util/errors.ts';
import { type Token, isSkippable, nextNonSkippable, sliceTokens, tokenize } from './tokenize.ts';

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

// Resolves CREATE/DROP SCHEMA DDL into a (project, datasetId) target.
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

// Resolves CREATE/DROP FUNCTION DDL into a structured target. Arg/RETURNS
// types are captured but DuckDB's CREATE MACRO doesn't enforce them — the
// queryEngine wraps the body in CAST(... AS <type>) to honor RETURNS. TEMP
// functions may be unqualified; persistent ones need <dataset>.<name>.
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

/**
 * BL-066 — BigQuery scripting interpreter.
 *
 * Implements DECLARE / SET / IF (with ELSEIF / ELSE / END IF) and BEGIN…END
 * blocks. Everything else in a script is treated as a regular SQL statement
 * and handed to DuckDB after variable references are substituted with bound
 * `$N` parameters.
 *
 * Variables follow BQ semantics: declared with a type, optionally a DEFAULT,
 * referenced as bare identifiers (NOT `@@var` — that's BQ's read-only system
 * variables, a different concept). The scope is flat across the whole
 * script for now; nested BEGIN…END blocks don't get their own scope (a
 * future enhancement once we see real cases that need it).
 *
 * The interpreter returns the rows + schema of the *last* SELECT in the
 * script, matching the synchronous shape callers expect from
 * `POST /queries`. Other statements (DECLARE, SET, IF, DML, DDL) run for
 * their side effects.
 */

import type { Db } from '../storage/db.ts';
import { type BqField, type BqType, duckTypeToBq, normalizeBqType } from '../storage/types.ts';
import { BqError } from '../util/errors.ts';
import { type Token, tokenize } from './tokenize.ts';
import { translate } from './translate.ts';

// ---------------------------------------------------------------------------
// Variable scope
// ---------------------------------------------------------------------------

interface Variable {
  readonly name: string; // canonical (preserves user's casing)
  readonly bqType: BqType;
  value: unknown;
}

class Scope {
  // Keys lowercased so identifier lookups are case-insensitive (matches BQ).
  private readonly vars: Map<string, Variable> = new Map();

  declare(name: string, bqType: BqType, initialValue: unknown): void {
    const key = name.toLowerCase();
    if (this.vars.has(key)) {
      throw BqError.invalid(`Variable "${name}" is already declared in this scope.`, 'query');
    }
    this.vars.set(key, { name, bqType, value: initialValue });
  }

  get(name: string): Variable | undefined {
    return this.vars.get(name.toLowerCase());
  }

  set(name: string, value: unknown): void {
    const v = this.vars.get(name.toLowerCase());
    if (v === undefined) {
      throw BqError.invalid(`Variable "${name}" is not declared.`, 'query');
    }
    v.value = value;
  }

  has(name: string): boolean {
    return this.vars.has(name.toLowerCase());
  }
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type Stmt =
  | { kind: 'DECLARE'; names: string[]; bqType: BqType; duckType: string; defaultExpr?: string }
  | { kind: 'SET_SCALAR'; name: string; expr: string }
  | { kind: 'SET_TUPLE'; names: string[]; exprs: string[] }
  | { kind: 'SET_SUBQUERY'; names: string[]; selectSql: string }
  | { kind: 'IF'; branches: IfBranch[]; elseBody?: Stmt[] }
  | { kind: 'BLOCK'; body: Stmt[] }
  | { kind: 'SQL'; sql: string };

interface IfBranch {
  readonly cond: string;
  readonly body: Stmt[];
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface ScriptResult {
  readonly schema: readonly BqField[];
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function executeBqScript(
  db: Db,
  project: string,
  scriptSql: string,
): Promise<ScriptResult> {
  const tokens = tokenize(scriptSql);
  const program = parseStatements(scriptSql, tokens, 0, tokens.length);
  const scope = new Scope();
  let lastSelectResult: ScriptResult = { schema: [], rows: [] };

  const runList = async (stmts: readonly Stmt[]): Promise<void> => {
    for (const s of stmts) {
      const r = await runStmt(db, project, scope, s, runList);
      if (r !== undefined) lastSelectResult = r;
    }
  };

  await runList(program);
  return lastSelectResult;
}

async function runStmt(
  db: Db,
  project: string,
  scope: Scope,
  stmt: Stmt,
  runList: (stmts: readonly Stmt[]) => Promise<void>,
): Promise<ScriptResult | undefined> {
  switch (stmt.kind) {
    case 'DECLARE': {
      let initial: unknown = null;
      if (stmt.defaultExpr !== undefined) {
        initial = await evalScalarExpr(db, project, scope, stmt.defaultExpr, stmt.duckType);
      }
      for (const name of stmt.names) scope.declare(name, stmt.bqType, initial);
      return undefined;
    }
    case 'SET_SCALAR': {
      const v = scope.get(stmt.name);
      if (v === undefined) {
        throw BqError.invalid(`Variable "${stmt.name}" is not declared.`, 'query');
      }
      v.value = await evalScalarExpr(db, project, scope, stmt.expr, bqTypeToDuckShort(v.bqType));
      return undefined;
    }
    case 'SET_TUPLE': {
      if (stmt.names.length !== stmt.exprs.length) {
        throw BqError.invalid(
          `SET (x, …) = (…) requires matching counts: ${stmt.names.length} vars vs ${stmt.exprs.length} exprs.`,
          'query',
        );
      }
      const values: unknown[] = [];
      for (let i = 0; i < stmt.names.length; i += 1) {
        const name = stmt.names[i] as string;
        const expr = stmt.exprs[i] as string;
        const v = scope.get(name);
        if (v === undefined) throw BqError.invalid(`Variable "${name}" is not declared.`, 'query');
        values.push(await evalScalarExpr(db, project, scope, expr, bqTypeToDuckShort(v.bqType)));
      }
      // Apply atomically so failures don't leave a half-applied state.
      for (let i = 0; i < stmt.names.length; i += 1) {
        scope.set(stmt.names[i] as string, values[i]);
      }
      return undefined;
    }
    case 'SET_SUBQUERY': {
      const { sql, values } = substituteVars(stmt.selectSql, scope);
      const result = await db.queryWithSchema(translate(sql, { project }).sql, values);
      if (result.rows.length !== 1) {
        throw BqError.invalid(
          `SET (...) = (SELECT ...) expected exactly 1 row, got ${result.rows.length}.`,
          'query',
        );
      }
      if (result.columnNames.length !== stmt.names.length) {
        throw BqError.invalid(
          `SET (...) = (SELECT ...) expected ${stmt.names.length} columns, got ${result.columnNames.length}.`,
          'query',
        );
      }
      const row = result.rows[0] as Record<string, unknown>;
      for (let i = 0; i < stmt.names.length; i += 1) {
        const col = result.columnNames[i] as string;
        scope.set(stmt.names[i] as string, row[col]);
      }
      return undefined;
    }
    case 'IF': {
      for (const branch of stmt.branches) {
        const condVal = await evalScalarExpr(db, project, scope, branch.cond, 'BOOLEAN');
        if (condVal === true) {
          await runList(branch.body);
          return undefined;
        }
      }
      if (stmt.elseBody !== undefined) await runList(stmt.elseBody);
      return undefined;
    }
    case 'BLOCK': {
      await runList(stmt.body);
      return undefined;
    }
    case 'SQL': {
      // Distinguish SELECT from everything else: SELECTs surface results.
      const upper = leadingKeyword(stmt.sql);
      const { sql, values } = substituteVars(stmt.sql, scope);
      const translated = translate(sql, { project }).sql;
      if (upper === 'SELECT' || upper === 'WITH' || upper === 'VALUES') {
        const result = await db.queryWithSchema(translated, values);
        const schema: BqField[] = result.columnNames.map((name, i) =>
          duckTypeToBq(result.columnTypes[i] ?? 'VARCHAR', name),
        );
        return { schema, rows: result.rows };
      }
      // Non-SELECT: run for side effects.
      if (values.length === 0) await db.exec(translated);
      else await db.queryWithSchema(translated, values);
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Expression evaluation: SELECT (expr) → scalar value
// ---------------------------------------------------------------------------

async function evalScalarExpr(
  db: Db,
  project: string,
  scope: Scope,
  exprSql: string,
  castTo: string | undefined,
): Promise<unknown> {
  const { sql, values } = substituteVars(exprSql, scope);
  const wrapped = castTo === undefined ? `(${sql})` : `CAST((${sql}) AS ${castTo})`;
  const selectSql = `SELECT ${wrapped} AS r`;
  const translated = translate(selectSql, { project }).sql;
  let result;
  try {
    result = await db.queryWithSchema(translated, values);
  } catch (err) {
    throw BqError.invalid(
      err instanceof Error ? err.message : 'Expression evaluation failed.',
      'query',
    );
  }
  if (result.rows.length !== 1) {
    throw BqError.invalid('Scalar expression must return exactly 1 row.', 'query');
  }
  const row = result.rows[0] as Record<string, unknown>;
  return row['r'];
}

// ---------------------------------------------------------------------------
// Variable substitution
// ---------------------------------------------------------------------------

/**
 * Walk the SQL tokens and replace any bare identifier matching a declared
 * variable with a `$N` placeholder, collecting the values in order. Skips
 * identifiers inside string literals (the tokenizer already separates
 * those), and ones immediately preceded by `.` (qualified column refs
 * like `t.x`).
 */
function substituteVars(sql: string, scope: Scope): { sql: string; values: unknown[] } {
  const tokens = tokenize(sql);
  const parts: string[] = [];
  const values: unknown[] = [];
  // Track paren depth, and at the current depth whether we're inside a
  // SELECT projection list (between SELECT and the first FROM/WHERE/etc).
  // Reset to non-SELECT when paren depth changes, since `(SELECT ...)` is
  // its own context — for BL-066 we only alias at the outermost SELECT.
  let depth = 0;
  let inSelectList = false;
  let beforeFirstStmt = true;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i] as Token;
    if (tok.kind === 'punctuation') {
      if (tok.value === '(') depth += 1;
      else if (tok.value === ')') depth -= 1;
      parts.push(tok.value);
      continue;
    }
    if (tok.kind === 'identifier' && depth === 0) {
      const up = tok.value.toUpperCase();
      if (up === 'SELECT') {
        inSelectList = true;
        beforeFirstStmt = false;
        parts.push(tok.value);
        continue;
      }
      if (SELECT_LIST_TERMINATORS.has(up)) {
        inSelectList = false;
      } else if (TOP_LEVEL_NON_SELECT_KEYWORDS.has(up)) {
        inSelectList = false;
        beforeFirstStmt = false;
      }
    }
    if (tok.kind !== 'identifier') {
      parts.push(tok.value);
      continue;
    }
    const prevIdx = previousNonWs(tokens, i);
    if (
      prevIdx !== null &&
      tokens[prevIdx]?.kind === 'punctuation' &&
      tokens[prevIdx]?.value === '.'
    ) {
      parts.push(tok.value);
      continue;
    }
    const nextIdx = nextNonWs(tokens, i + 1);
    if (
      nextIdx !== null &&
      tokens[nextIdx]?.kind === 'punctuation' &&
      tokens[nextIdx]?.value === '.'
    ) {
      parts.push(tok.value);
      continue;
    }
    if (!scope.has(tok.value)) {
      parts.push(tok.value);
      continue;
    }
    const v = scope.get(tok.value);
    if (v === undefined) {
      parts.push(tok.value);
      continue;
    }
    values.push(prepareBindValue(v.value, v.bqType));
    const cast = placeholderCast(v.bqType);
    const placeholder = cast === '' ? `$${values.length}` : `$${values.length}${cast}`;
    // Alias the bound value only when we're at the outermost SELECT's
    // projection list — anywhere else (VALUES, WHERE, function args, …)
    // an `AS alias` is a syntax error.
    const aliased =
      depth === 0 && inSelectList && isBareSelectListItem(tokens, prevIdx, nextIdx);
    parts.push(aliased ? `${placeholder} AS ${quoteAlias(tok.value)}` : placeholder);
  }
  // Suppress an unused-var lint warning while still keeping `beforeFirstStmt`
  // available if future statement-classifier logic wants it.
  void beforeFirstStmt;
  return { sql: parts.join(''), values };
}

const TOP_LEVEL_NON_SELECT_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'VALUES',
  'CREATE',
  'DROP',
  'ALTER',
  'TRUNCATE',
  'CALL',
  'SET',
  'DECLARE',
  'IF',
  'BEGIN',
]);

/** DuckDB-Node binds JS values via the duckdb-node DuckDBValue type, which
 *  understands strings, numbers, bigints, booleans, Uint8Arrays. It does NOT
 *  understand JS Date objects for DATE/TIMESTAMP columns — they have to be
 *  passed as strings with an explicit `::DATE`/`::TIMESTAMPTZ` cast in the
 *  SQL (see `placeholderCast`). Convert here. */
function prepareBindValue(value: unknown, bqType: BqType): unknown {
  if (value instanceof Date) {
    if (bqType === 'DATE') return value.toISOString().slice(0, 10);
    if (bqType === 'TIMESTAMP' || bqType === 'DATETIME') return value.toISOString();
  }
  return value;
}

function placeholderCast(t: BqType): string {
  switch (t) {
    case 'TIMESTAMP':
      return '::TIMESTAMPTZ';
    case 'DATETIME':
      return '::TIMESTAMP';
    case 'DATE':
      return '::DATE';
    case 'TIME':
      return '::TIME';
    default:
      return '';
  }
}

const SELECT_LIST_TERMINATORS = new Set([
  'FROM',
  'WHERE',
  'GROUP',
  'ORDER',
  'HAVING',
  'LIMIT',
  'WINDOW',
  'QUALIFY',
  'UNION',
  'INTERSECT',
  'EXCEPT',
]);

function isBareSelectListItem(
  tokens: readonly Token[],
  prevIdx: number | null,
  nextIdx: number | null,
): boolean {
  // Bare item iff preceded by SELECT or `,`, AND followed by `,` / `;` / a
  // SELECT-list terminator (FROM / WHERE / …) / end-of-input. If the user
  // already wrote `... AS <alias>` (or implicit alias), let theirs win.
  if (prevIdx === null) return false;
  const prev = tokens[prevIdx] as Token;
  const okPrev =
    (prev.kind === 'identifier' && prev.value.toUpperCase() === 'SELECT') ||
    (prev.kind === 'punctuation' && prev.value === ',');
  if (!okPrev) return false;
  if (nextIdx === null) return true;
  const next = tokens[nextIdx] as Token;
  if (next.kind === 'punctuation') {
    return next.value === ',' || next.value === ';' || next.value === ')';
  }
  if (next.kind === 'identifier') {
    const up = next.value.toUpperCase();
    if (up === 'AS') return false;
    return SELECT_LIST_TERMINATORS.has(up);
  }
  return false;
}

function quoteAlias(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function previousNonWs(tokens: readonly Token[], from: number): number | null {
  for (let i = from - 1; i >= 0; i -= 1) {
    const t = tokens[i] as Token;
    if (t.kind !== 'whitespace' && t.kind !== 'line-comment' && t.kind !== 'block-comment') {
      return i;
    }
  }
  return null;
}

function nextNonWs(tokens: readonly Token[], from: number): number | null {
  for (let i = from; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    if (t.kind !== 'whitespace' && t.kind !== 'line-comment' && t.kind !== 'block-comment') {
      return i;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Statement parser
// ---------------------------------------------------------------------------

/**
 * Parse a list of statements from `tokens[startIdx .. endIdx)`. A statement
 * boundary is a top-level `;`; structured statements (IF, BEGIN) consume
 * up to their matching `END IF;` or `END;` terminator.
 */
function parseStatements(
  sql: string,
  tokens: readonly Token[],
  startIdx: number,
  endIdx: number,
): Stmt[] {
  const out: Stmt[] = [];
  let i = startIdx;
  while (i < endIdx) {
    while (i < endIdx && isTrivia(tokens[i] as Token)) i += 1;
    if (i >= endIdx) break;
    // Empty statement (lone `;`) — skip.
    if (isPunct(tokens[i], ';')) {
      i += 1;
      continue;
    }
    const result = parseSingleStmt(sql, tokens, i, endIdx);
    out.push(result.stmt);
    i = result.next;
    // Optional terminating `;` after a top-level statement.
    while (i < endIdx && isTrivia(tokens[i] as Token)) i += 1;
    if (isPunct(tokens[i], ';')) i += 1;
  }
  return out;
}

interface ParseOne {
  readonly stmt: Stmt;
  /** First index AFTER the statement (but possibly before its terminating `;`). */
  readonly next: number;
}

function parseSingleStmt(
  sql: string,
  tokens: readonly Token[],
  startIdx: number,
  endIdx: number,
): ParseOne {
  const first = tokens[startIdx] as Token;
  if (first.kind === 'identifier') {
    const kw = first.value.toUpperCase();
    if (kw === 'DECLARE') return parseDeclare(sql, tokens, startIdx, endIdx);
    if (kw === 'SET') return parseSet(sql, tokens, startIdx, endIdx);
    if (kw === 'IF') return parseIf(sql, tokens, startIdx, endIdx);
    if (kw === 'BEGIN') {
      // `BEGIN TRANSACTION` and friends are passed through to DuckDB as
      // plain SQL — only the bare `BEGIN <stmts> END` form is a block.
      const after = skipTrivia(tokens, startIdx + 1, endIdx);
      const peek = tokens[after];
      if (peek?.kind === 'identifier' && peek.value.toUpperCase() === 'TRANSACTION') {
        return parseSqlUntilSemi(sql, tokens, startIdx, endIdx);
      }
      return parseBlock(sql, tokens, startIdx, endIdx);
    }
  }
  return parseSqlUntilSemi(sql, tokens, startIdx, endIdx);
}

function parseDeclare(
  sql: string,
  tokens: readonly Token[],
  startIdx: number,
  endIdx: number,
): ParseOne {
  // DECLARE name1 [, name2, ...] <type> [DEFAULT <expr>] ;
  let i = skipTrivia(tokens, startIdx + 1, endIdx);
  const names: string[] = [];
  while (i < endIdx) {
    const t = tokens[i] as Token;
    if (t.kind !== 'identifier') {
      throw BqError.invalid('DECLARE expected a variable name.', 'query');
    }
    names.push(t.value);
    i = skipTrivia(tokens, i + 1, endIdx);
    if (isPunct(tokens[i], ',')) {
      i = skipTrivia(tokens, i + 1, endIdx);
      continue;
    }
    break;
  }
  if (names.length === 0) {
    throw BqError.invalid('DECLARE expected at least one variable name.', 'query');
  }
  // Type — consume until DEFAULT or `;` or end of statement.
  const typeStart = i;
  i = consumeUntilKeywordOrSemi(tokens, i, endIdx, ['DEFAULT']);
  const typeText = sliceTokenText(sql, tokens, typeStart, i).trim();
  if (typeText === '') {
    throw BqError.invalid('DECLARE expected a type.', 'query');
  }
  let defaultExpr: string | undefined;
  if (isKeyword(tokens[i], 'DEFAULT')) {
    i = skipTrivia(tokens, i + 1, endIdx);
    const exprStart = i;
    i = consumeUntilSemi(tokens, i, endIdx);
    defaultExpr = sliceTokenText(sql, tokens, exprStart, i).trim();
  }
  const bqType = normalizeBqType(stripLeadingType(typeText));
  const duckType = bqTypeShortDuck(bqType);
  return {
    stmt: {
      kind: 'DECLARE',
      names,
      bqType,
      duckType,
      ...(defaultExpr !== undefined && { defaultExpr }),
    },
    next: i,
  };
}

function parseSet(
  sql: string,
  tokens: readonly Token[],
  startIdx: number,
  endIdx: number,
): ParseOne {
  // Forms:
  //   SET name = expr ;
  //   SET (n1, n2, ...) = (e1, e2, ...) ;
  //   SET (n1, n2, ...) = (SELECT ...) ;
  let i = skipTrivia(tokens, startIdx + 1, endIdx);
  if (isPunct(tokens[i], '(')) {
    // Tuple form.
    const close = matchingParen(tokens, i, endIdx);
    const names = parseIdentList(tokens, i + 1, close);
    i = skipTrivia(tokens, close + 1, endIdx);
    if (!isOp(tokens[i], '=')) {
      throw BqError.invalid('SET (...) expects `=` after the variable list.', 'query');
    }
    i = skipTrivia(tokens, i + 1, endIdx);
    if (!isPunct(tokens[i], '(')) {
      throw BqError.invalid('SET (...) = expects a parenthesized RHS.', 'query');
    }
    const rhsOpen = i;
    const rhsClose = matchingParen(tokens, rhsOpen, endIdx);
    // Subquery vs comma-separated exprs: peek the first token inside the parens.
    const firstInside = skipTrivia(tokens, rhsOpen + 1, rhsClose);
    const firstTok = tokens[firstInside];
    if (
      firstTok?.kind === 'identifier' &&
      (firstTok.value.toUpperCase() === 'SELECT' || firstTok.value.toUpperCase() === 'WITH')
    ) {
      const selectSql = sliceTokenText(sql, tokens, rhsOpen + 1, rhsClose).trim();
      i = rhsClose + 1;
      return { stmt: { kind: 'SET_SUBQUERY', names, selectSql }, next: i };
    }
    const exprs = splitTopLevelCommas(sql, tokens, rhsOpen + 1, rhsClose);
    i = rhsClose + 1;
    return { stmt: { kind: 'SET_TUPLE', names, exprs }, next: i };
  }
  // Scalar form.
  const nameTok = tokens[i];
  if (nameTok?.kind !== 'identifier') {
    throw BqError.invalid('SET expects a variable name.', 'query');
  }
  i = skipTrivia(tokens, i + 1, endIdx);
  if (!isOp(tokens[i], '=')) {
    throw BqError.invalid('SET expects `=` after the variable name.', 'query');
  }
  i = skipTrivia(tokens, i + 1, endIdx);
  const exprStart = i;
  i = consumeUntilSemi(tokens, i, endIdx);
  const expr = sliceTokenText(sql, tokens, exprStart, i).trim();
  return { stmt: { kind: 'SET_SCALAR', name: nameTok.value, expr }, next: i };
}

function parseIf(
  sql: string,
  tokens: readonly Token[],
  startIdx: number,
  endIdx: number,
): ParseOne {
  // IF cond THEN <stmts>
  //   [ELSEIF cond THEN <stmts>]*
  //   [ELSE <stmts>]
  // END IF
  let i = skipTrivia(tokens, startIdx + 1, endIdx);
  const branches: IfBranch[] = [];
  let elseBody: Stmt[] | undefined;
  while (true) {
    const condStart = i;
    i = consumeUntilKeyword(tokens, i, endIdx, ['THEN']);
    if (!isKeyword(tokens[i], 'THEN')) {
      throw BqError.invalid('IF/ELSEIF expects THEN.', 'query');
    }
    const cond = sliceTokenText(sql, tokens, condStart, i).trim();
    i = skipTrivia(tokens, i + 1, endIdx);
    const bodyStart = i;
    i = findIfBranchEnd(tokens, i, endIdx);
    const body = parseStatements(sql, tokens, bodyStart, i);
    branches.push({ cond, body });
    const here = tokens[i];
    if (isKeyword(here, 'ELSEIF') || isKeyword(here, 'ELSE IF')) {
      i = skipTrivia(tokens, i + 1, endIdx);
      continue;
    }
    if (isKeyword(here, 'ELSE')) {
      i = skipTrivia(tokens, i + 1, endIdx);
      const elseStart = i;
      i = findIfBranchEnd(tokens, i, endIdx);
      elseBody = parseStatements(sql, tokens, elseStart, i);
    }
    if (!isKeyword(tokens[i], 'END')) {
      throw BqError.invalid('IF block must terminate with END IF.', 'query');
    }
    i = skipTrivia(tokens, i + 1, endIdx);
    if (!isKeyword(tokens[i], 'IF')) {
      throw BqError.invalid('IF block must terminate with END IF.', 'query');
    }
    i = i + 1;
    break;
  }
  return {
    stmt: { kind: 'IF', branches, ...(elseBody !== undefined && { elseBody }) },
    next: i,
  };
}

function parseBlock(
  sql: string,
  tokens: readonly Token[],
  startIdx: number,
  endIdx: number,
): ParseOne {
  // BEGIN <stmts> END
  let i = skipTrivia(tokens, startIdx + 1, endIdx);
  const bodyStart = i;
  i = findBlockEnd(tokens, i, endIdx);
  const body = parseStatements(sql, tokens, bodyStart, i);
  if (!isKeyword(tokens[i], 'END')) {
    throw BqError.invalid('BEGIN block must terminate with END.', 'query');
  }
  return { stmt: { kind: 'BLOCK', body }, next: i + 1 };
}

function parseSqlUntilSemi(
  sql: string,
  tokens: readonly Token[],
  startIdx: number,
  endIdx: number,
): ParseOne {
  const end = consumeUntilSemi(tokens, startIdx, endIdx);
  const text = sliceTokenText(sql, tokens, startIdx, end).trim();
  return { stmt: { kind: 'SQL', sql: text }, next: end };
}

// ---------------------------------------------------------------------------
// Token-walk helpers
// ---------------------------------------------------------------------------

function skipTrivia(tokens: readonly Token[], from: number, end: number): number {
  let i = from;
  while (i < end && isTrivia(tokens[i] as Token)) i += 1;
  return i;
}

function isTrivia(tok: Token): boolean {
  return tok.kind === 'whitespace' || tok.kind === 'line-comment' || tok.kind === 'block-comment';
}

function isPunct(tok: Token | undefined, ch: string): boolean {
  return tok?.kind === 'punctuation' && tok.value === ch;
}

function isOp(tok: Token | undefined, ch: string): boolean {
  return tok?.kind === 'operator' && tok.value === ch;
}

function isKeyword(tok: Token | undefined, kw: string): boolean {
  return tok?.kind === 'identifier' && tok.value.toUpperCase() === kw;
}

/** Consume tokens up to (but not including) the next top-level `;`. Tracks
 *  paren depth and IF / BEGIN nesting so semicolons inside a sub-block
 *  don't end the outer statement. */
function consumeUntilSemi(tokens: readonly Token[], from: number, end: number): number {
  let depth = 0;
  let blockDepth = 0;
  let i = from;
  while (i < end) {
    const t = tokens[i] as Token;
    if (t.kind === 'punctuation') {
      if (t.value === '(') depth += 1;
      else if (t.value === ')') depth -= 1;
      else if (t.value === ';' && depth === 0 && blockDepth === 0) return i;
    } else if (t.kind === 'identifier') {
      const up = t.value.toUpperCase();
      if (up === 'BEGIN' || up === 'IF') blockDepth += 1;
      else if (up === 'END') blockDepth = Math.max(0, blockDepth - 1);
    }
    i += 1;
  }
  return end;
}

function consumeUntilKeyword(
  tokens: readonly Token[],
  from: number,
  end: number,
  keywords: readonly string[],
): number {
  let depth = 0;
  let i = from;
  const upper = keywords.map((k) => k.toUpperCase());
  while (i < end) {
    const t = tokens[i] as Token;
    if (t.kind === 'punctuation') {
      if (t.value === '(') depth += 1;
      else if (t.value === ')') depth -= 1;
    }
    if (t.kind === 'identifier' && depth === 0 && upper.includes(t.value.toUpperCase())) return i;
    i += 1;
  }
  return end;
}

function consumeUntilKeywordOrSemi(
  tokens: readonly Token[],
  from: number,
  end: number,
  keywords: readonly string[],
): number {
  let depth = 0;
  let i = from;
  const upper = keywords.map((k) => k.toUpperCase());
  while (i < end) {
    const t = tokens[i] as Token;
    if (t.kind === 'punctuation') {
      if (t.value === '(') depth += 1;
      else if (t.value === ')') depth -= 1;
      else if (t.value === ';' && depth === 0) return i;
    } else if (t.kind === 'identifier' && depth === 0 && upper.includes(t.value.toUpperCase())) {
      return i;
    }
    i += 1;
  }
  return end;
}

/** Find the end of an IF-branch body: stop just before ELSEIF / ELSE / END
 *  at the same nesting level. */
function findIfBranchEnd(tokens: readonly Token[], from: number, end: number): number {
  let i = from;
  let depth = 0; // BEGIN/IF nesting inside the body
  while (i < end) {
    const t = tokens[i] as Token;
    if (t.kind === 'identifier') {
      const up = t.value.toUpperCase();
      if (up === 'BEGIN' || up === 'IF') {
        depth += 1;
      } else if (up === 'END' && depth > 0) {
        depth -= 1;
        // Consume the matching `IF` after `END IF`.
        const after = skipTrivia(tokens, i + 1, end);
        if (isKeyword(tokens[after], 'IF')) i = after;
      } else if (depth === 0 && (up === 'ELSEIF' || up === 'ELSE' || up === 'END')) {
        return i;
      }
    }
    i += 1;
  }
  return end;
}

function findBlockEnd(tokens: readonly Token[], from: number, end: number): number {
  let i = from;
  let depth = 0;
  while (i < end) {
    const t = tokens[i] as Token;
    if (t.kind === 'identifier') {
      const up = t.value.toUpperCase();
      if (up === 'BEGIN' || up === 'IF') {
        depth += 1;
      } else if (up === 'END') {
        if (depth === 0) return i;
        depth -= 1;
        const after = skipTrivia(tokens, i + 1, end);
        if (isKeyword(tokens[after], 'IF')) i = after;
      }
    }
    i += 1;
  }
  return end;
}

function matchingParen(tokens: readonly Token[], openIdx: number, end: number): number {
  let depth = 0;
  for (let i = openIdx; i < end; i += 1) {
    const t = tokens[i] as Token;
    if (t.kind === 'punctuation') {
      if (t.value === '(') depth += 1;
      else if (t.value === ')') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
  }
  throw BqError.invalid('Unmatched `(` in script.', 'query');
}

function parseIdentList(tokens: readonly Token[], from: number, end: number): string[] {
  const out: string[] = [];
  let i = from;
  while (i < end) {
    while (i < end && isTrivia(tokens[i] as Token)) i += 1;
    if (i >= end) break;
    const t = tokens[i] as Token;
    if (t.kind !== 'identifier') {
      throw BqError.invalid('Expected variable name in tuple.', 'query');
    }
    out.push(t.value);
    i = skipTrivia(tokens, i + 1, end);
    if (isPunct(tokens[i], ',')) i = skipTrivia(tokens, i + 1, end);
  }
  return out;
}

function splitTopLevelCommas(
  sql: string,
  tokens: readonly Token[],
  from: number,
  end: number,
): string[] {
  const out: string[] = [];
  let depth = 0;
  let segStart = from;
  for (let i = from; i < end; i += 1) {
    const t = tokens[i] as Token;
    if (t.kind === 'punctuation') {
      if (t.value === '(') depth += 1;
      else if (t.value === ')') depth -= 1;
      else if (t.value === ',' && depth === 0) {
        out.push(sliceTokenText(sql, tokens, segStart, i).trim());
        segStart = i + 1;
      }
    }
  }
  const last = sliceTokenText(sql, tokens, segStart, end).trim();
  if (last !== '') out.push(last);
  return out;
}

function sliceTokenText(sql: string, tokens: readonly Token[], from: number, to: number): string {
  if (from >= to) return '';
  const a = (tokens[from] as Token).start;
  const lastIdx = to - 1;
  const b = (tokens[lastIdx] as Token).end;
  return sql.slice(a, b);
}

function leadingKeyword(sql: string): string {
  const tokens = tokenize(sql);
  let i = 0;
  while (i < tokens.length && isTrivia(tokens[i] as Token)) i += 1;
  const t = tokens[i];
  return t?.kind === 'identifier' ? t.value.toUpperCase() : '';
}

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

/** Some DECLARE types are written as `ARRAY<X>` or `STRUCT<...>`. For the
 *  initial scope check (normalizeBqType is strict) we strip generic args
 *  and use the base name. */
function stripLeadingType(text: string): string {
  const idx = text.search(/[\s(<]/);
  return idx === -1 ? text : text.slice(0, idx);
}

function bqTypeShortDuck(t: BqType): string {
  switch (t) {
    case 'INT64':
      return 'BIGINT';
    case 'FLOAT64':
      return 'DOUBLE';
    case 'BOOL':
      return 'BOOLEAN';
    case 'STRING':
      return 'VARCHAR';
    case 'BYTES':
      return 'BLOB';
    case 'NUMERIC':
      return 'DECIMAL(38, 9)';
    case 'BIGNUMERIC':
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
      return 'VARCHAR';
    case 'STRUCT':
      return 'STRUCT';
  }
}

function bqTypeToDuckShort(t: BqType): string {
  return bqTypeShortDuck(t);
}

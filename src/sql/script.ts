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
import { getRoutine } from '../storage/meta.ts';
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

interface RowVariable {
  readonly name: string;
  /** Column name (canonical) → DuckDB row value. */
  row: Record<string, unknown>;
  /** Column name (lowercased) → BQ type — used for the placeholder cast. */
  colTypes: Record<string, BqType>;
}

class Scope {
  // Keys lowercased so identifier lookups are case-insensitive (matches BQ).
  private readonly vars: Map<string, Variable> = new Map();
  private readonly rows: Map<string, RowVariable> = new Map();

  declare(name: string, bqType: BqType, initialValue: unknown): void {
    const key = name.toLowerCase();
    if (this.vars.has(key) || this.rows.has(key)) {
      throw BqError.invalid(`Variable "${name}" is already declared in this scope.`, 'query');
    }
    this.vars.set(key, { name, bqType, value: initialValue });
  }

  /** Bind a FOR-loop row to a name. The same name can be re-bound across
   *  iterations of the loop — that's what FOR does. */
  bindRow(name: string, row: Record<string, unknown>, colTypes: Record<string, BqType>): void {
    const key = name.toLowerCase();
    if (this.vars.has(key)) {
      throw BqError.invalid(`Variable "${name}" is already declared in this scope.`, 'query');
    }
    this.rows.set(key, { name, row, colTypes });
  }

  unbindRow(name: string): void {
    this.rows.delete(name.toLowerCase());
  }

  get(name: string): Variable | undefined {
    return this.vars.get(name.toLowerCase());
  }

  getRow(name: string): RowVariable | undefined {
    return this.rows.get(name.toLowerCase());
  }

  set(name: string, value: unknown): void {
    const v = this.vars.get(name.toLowerCase());
    if (v === undefined) {
      throw BqError.invalid(`Variable "${name}" is not declared.`, 'query');
    }
    v.value = value;
  }

  has(name: string): boolean {
    return this.vars.has(name.toLowerCase()) || this.rows.has(name.toLowerCase());
  }
}

// ---------------------------------------------------------------------------
// Control-flow signals
// ---------------------------------------------------------------------------

class BreakSignal {}
class ContinueSignal {}
/** Thrown by `RETURN`; caught by the nearest CALL frame. Procedure bodies
 *  use it to exit early. At the top of the script (no enclosing CALL),
 *  RETURN becomes a clean script termination. */
class ReturnSignal {}

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
  | { kind: 'LOOP'; body: Stmt[] }
  | { kind: 'WHILE'; cond: string; body: Stmt[] }
  | { kind: 'REPEAT'; body: Stmt[]; untilCond: string }
  | { kind: 'FOR'; name: string; selectSql: string; body: Stmt[] }
  | { kind: 'BREAK' }
  | { kind: 'CONTINUE' }
  | { kind: 'RETURN' }
  | { kind: 'CALL'; project: string; datasetId: string; procedureId: string; argExprs: string[] }
  | {
      kind: 'EXECUTE_IMMEDIATE';
      sqlExpr: string;
      intoVars: readonly string[];
      usingClauses: readonly UsingClause[];
    }
  | { kind: 'SQL'; sql: string };

interface UsingClause {
  /** Caller-side expression to evaluate. */
  readonly expr: string;
  /** Optional `AS <name>` — when set, the value is bound as `@name` in
   *  the dynamic SQL. When absent, it's a positional `?` placeholder. */
  readonly name?: string;
}

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

  try {
    await runList(program);
  } catch (signal) {
    // RETURN at the top of a script (i.e. with no enclosing CALL) is a
    // clean early-exit, not an error. BREAK / CONTINUE outside any loop
    // are user errors though — propagate those.
    if (!(signal instanceof ReturnSignal)) throw signal;
  }
  return lastSelectResult;
}

/** Execute a dynamically-built SQL string. Optional INTO captures the
 *  result row's columns into named script variables (like `SET (a, b) =
 *  (SELECT …)`). Optional USING binds parameter values into the dynamic
 *  SQL — `?` positional or `AS <name>` for the `@name` form.
 *
 *  Side effects (DML / DDL) just run through DuckDB. SELECT-shaped
 *  dynamic SQL is read but its result rows aren't returned to the caller
 *  unless captured via INTO. */
async function runExecuteImmediate(
  db: Db,
  project: string,
  scope: Scope,
  stmt: Extract<Stmt, { kind: 'EXECUTE_IMMEDIATE' }>,
): Promise<ScriptResult | undefined> {
  // 1. Evaluate the SQL-text expression in the caller scope.
  const sqlText = await evalScalarExpr(db, project, scope, stmt.sqlExpr, 'VARCHAR');
  if (typeof sqlText !== 'string') {
    throw BqError.invalid('EXECUTE IMMEDIATE expression must evaluate to STRING.', 'query');
  }

  // 2. Evaluate USING expressions against the caller scope. Each binds as
  //    either a positional `?` (no name) or a named `@<name>` placeholder.
  const positionalUsing: unknown[] = [];
  const namedUsing = new Map<string, unknown>();
  for (const clause of stmt.usingClauses) {
    const val = await evalScalarExpr(db, project, scope, clause.expr, undefined);
    if (clause.name === undefined) positionalUsing.push(val);
    else namedUsing.set(clause.name.toLowerCase(), val);
  }

  // 3. Translate dynamic SQL — `@name` placeholders flow through translate()'s
  //    paramOrder; positional `?` we substitute ourselves with `$N`.
  const { sql: translatedSql, paramOrder } = translate(sqlText, { project });
  const { sql: withPositional, positionalCount } = replaceQuestionMarks(translatedSql, paramOrder);
  if (positionalCount !== positionalUsing.length) {
    throw BqError.invalid(
      `EXECUTE IMMEDIATE: dynamic SQL has ${positionalCount} positional placeholder(s) but USING supplied ${positionalUsing.length}.`,
      'query',
    );
  }
  // Build the bind values: named placeholders go in paramOrder slots; the
  // appended positional slots come after.
  const values: unknown[] = [];
  for (const name of paramOrder) {
    const v = namedUsing.get(name.toLowerCase());
    if (v === undefined) {
      throw BqError.invalid(
        `EXECUTE IMMEDIATE: dynamic SQL references @${name} but no matching USING clause was supplied.`,
        'query',
      );
    }
    values.push(v);
  }
  for (const v of positionalUsing) values.push(v);

  // 4. Execute and (optionally) capture results into the script-level vars.
  let result: Awaited<ReturnType<Db['queryWithSchema']>>;
  try {
    result = await db.queryWithSchema(withPositional, values);
  } catch (err) {
    throw BqError.invalid(
      err instanceof Error ? err.message : 'EXECUTE IMMEDIATE execution failed.',
      'query',
    );
  }

  if (stmt.intoVars.length > 0) {
    if (result.rows.length !== 1) {
      throw BqError.invalid(
        `EXECUTE IMMEDIATE INTO expected exactly 1 row, got ${result.rows.length}.`,
        'query',
      );
    }
    if (result.columnNames.length !== stmt.intoVars.length) {
      throw BqError.invalid(
        `EXECUTE IMMEDIATE INTO expected ${stmt.intoVars.length} columns, got ${result.columnNames.length}.`,
        'query',
      );
    }
    const row = result.rows[0] as Record<string, unknown>;
    for (let i = 0; i < stmt.intoVars.length; i += 1) {
      const col = result.columnNames[i] as string;
      scope.set(stmt.intoVars[i] as string, row[col]);
    }
  }
  return undefined;
}

/** Replace each top-level `?` with `$N` (continuing from the highest `$N`
 *  already present in the SQL). Skips `?` characters inside string literals
 *  and comments — we tokenize to find them. */
function replaceQuestionMarks(
  sql: string,
  existingParamOrder: readonly string[],
): { sql: string; positionalCount: number } {
  const tokens = tokenize(sql);
  const parts: string[] = [];
  let nextIdx = existingParamOrder.length + 1;
  let positionalCount = 0;
  for (const tok of tokens) {
    if (tok.kind === 'operator' && tok.value === '?') {
      parts.push(`$${nextIdx}`);
      nextIdx += 1;
      positionalCount += 1;
    } else {
      parts.push(tok.value);
    }
  }
  return { sql: parts.join(''), positionalCount };
}

/** Invoke a stored procedure: lookup the routine, validate arg count, create
 *  a fresh scope with the args declared as locals, run the body, catch
 *  RETURN. The last row-producing statement in the body (typically a
 *  SELECT) surfaces back to the caller — matching real BQ's behavior,
 *  where `CALL p()` shows up in the script's result set whenever the
 *  procedure body's last statement is a SELECT. */
async function runCall(
  db: Db,
  project: string,
  callerScope: Scope,
  stmt: Extract<Stmt, { kind: 'CALL' }>,
): Promise<ScriptResult | undefined> {
  // Parser leaves `project` empty when the user only wrote `dataset.proc`;
  // resolve against the request's default project here.
  const proj = stmt.project === '' ? project : stmt.project;
  const routine = await getRoutine(db, proj, stmt.datasetId, stmt.procedureId);
  if (routine === null) {
    throw BqError.notFound(`Procedure "${proj}:${stmt.datasetId}.${stmt.procedureId}" not found.`);
  }
  if (routine.routineType !== 'PROCEDURE') {
    throw BqError.invalid(
      `Routine "${stmt.project}:${stmt.datasetId}.${stmt.procedureId}" is not a procedure.`,
      'query',
    );
  }
  const args =
    (routine.arguments as Array<{ name: string; dataType?: { typeKind?: string } }>) ?? [];
  if (args.length !== stmt.argExprs.length) {
    throw BqError.invalid(
      `Procedure "${stmt.procedureId}" expected ${args.length} arg(s), got ${stmt.argExprs.length}.`,
      'query',
    );
  }
  // Evaluate caller-side arg expressions in the CALLER's scope, then build
  // a fresh procedure-local scope with the resulting values bound under
  // each formal parameter name.
  const evaluated: Array<{ name: string; type: BqType; value: unknown }> = [];
  for (let i = 0; i < args.length; i += 1) {
    const formal = args[i] as { name: string; dataType?: { typeKind?: string } };
    const typeText = formal.dataType?.typeKind ?? 'STRING';
    const bqType = normalizeBqType(typeText.split(/[<\s(]/)[0] ?? 'STRING');
    const duckType = bqTypeShortDuck(bqType);
    const argExpr = stmt.argExprs[i] as string;
    const v = await evalScalarExpr(db, project, callerScope, argExpr, duckType);
    evaluated.push({ name: formal.name, type: bqType, value: v });
  }
  const procScope = new Scope();
  for (const a of evaluated) procScope.declare(a.name, a.type, a.value);

  // Parse and execute the procedure body in the new scope. The body text
  // captured at CREATE PROCEDURE time is a `BEGIN … END` block.
  const bodyTokens = tokenize(routine.body);
  const program = parseStatements(routine.body, bodyTokens, 0, bodyTokens.length);

  let lastSelectResult: ScriptResult | undefined;
  const runList = async (stmts: readonly Stmt[]): Promise<void> => {
    for (const s of stmts) {
      const r = await runStmt(db, project, procScope, s, runList);
      if (r !== undefined) lastSelectResult = r;
    }
  };
  try {
    await runList(program);
  } catch (signal) {
    if (!(signal instanceof ReturnSignal)) throw signal;
    // RETURN exits the procedure cleanly.
  }
  return lastSelectResult;
}

async function runLoop(
  body: readonly Stmt[],
  runList: (stmts: readonly Stmt[]) => Promise<void>,
): Promise<void> {
  for (;;) {
    try {
      await runList(body);
    } catch (signal) {
      if (signal instanceof BreakSignal) return;
      if (signal instanceof ContinueSignal) continue;
      throw signal;
    }
  }
}

async function runWhile(
  db: Db,
  project: string,
  scope: Scope,
  cond: string,
  body: readonly Stmt[],
  runList: (stmts: readonly Stmt[]) => Promise<void>,
): Promise<void> {
  for (;;) {
    const c = await evalScalarExpr(db, project, scope, cond, 'BOOLEAN');
    if (c !== true) return;
    try {
      await runList(body);
    } catch (signal) {
      if (signal instanceof BreakSignal) return;
      if (signal instanceof ContinueSignal) continue;
      throw signal;
    }
  }
}

async function runRepeat(
  db: Db,
  project: string,
  scope: Scope,
  body: readonly Stmt[],
  untilCond: string,
  runList: (stmts: readonly Stmt[]) => Promise<void>,
): Promise<void> {
  for (;;) {
    try {
      await runList(body);
    } catch (signal) {
      if (signal instanceof BreakSignal) return;
      if (!(signal instanceof ContinueSignal)) throw signal;
      // CONTINUE inside REPEAT: still evaluate UNTIL before next iteration.
    }
    const done = await evalScalarExpr(db, project, scope, untilCond, 'BOOLEAN');
    if (done === true) return;
  }
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
    case 'LOOP':
      await runLoop(stmt.body, runList);
      return undefined;
    case 'WHILE':
      await runWhile(db, project, scope, stmt.cond, stmt.body, runList);
      return undefined;
    case 'REPEAT':
      await runRepeat(db, project, scope, stmt.body, stmt.untilCond, runList);
      return undefined;
    case 'FOR': {
      const { sql, values } = substituteVars(stmt.selectSql, scope);
      const result = await db.queryWithSchema(translate(sql, { project }).sql, values);
      const colTypes: Record<string, BqType> = {};
      for (let ci = 0; ci < result.columnNames.length; ci += 1) {
        const cname = result.columnNames[ci] as string;
        const ctype = result.columnTypes[ci] ?? 'VARCHAR';
        colTypes[cname.toLowerCase()] = duckTypeToBq(ctype, cname).type;
      }
      for (const row of result.rows) {
        scope.bindRow(stmt.name, row as Record<string, unknown>, colTypes);
        try {
          await runList(stmt.body);
        } catch (signal) {
          if (signal instanceof BreakSignal) {
            scope.unbindRow(stmt.name);
            return undefined;
          }
          if (signal instanceof ContinueSignal) {
            scope.unbindRow(stmt.name);
            continue;
          }
          scope.unbindRow(stmt.name);
          throw signal;
        }
        scope.unbindRow(stmt.name);
      }
      return undefined;
    }
    case 'BREAK':
      throw new BreakSignal();
    case 'CONTINUE':
      throw new ContinueSignal();
    case 'RETURN':
      throw new ReturnSignal();
    case 'CALL': {
      // runCall returns the body's last row-producing result (typically
      // a SELECT) so the outer script's runList can surface it.
      return await runCall(db, project, scope, stmt);
    }
    case 'EXECUTE_IMMEDIATE': {
      return runExecuteImmediate(db, project, scope, stmt);
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
  let result: Awaited<ReturnType<Db['queryWithSchema']>>;
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
  // Track positions where an identifier names a *column*, not a variable:
  //   1. INSERT INTO tbl (col1, col2) — paren depth that opens after
  //      INSERT [INTO] <table>. Identifiers inside are column names.
  //   2. UPDATE tbl SET col = ... — `col` here is a column name. Detected
  //      by "identifier followed by `=`" at depth=0 while seenUpdate set.
  // Both close at `VALUES` / `SELECT` / `WHERE` (post-SET) respectively.
  let insertColListDepth: number | null = null; // depth at which the column-list `(` opened
  // INSERT state machine:
  //   - `seenInsert` flips on at INSERT, off after VALUES / SELECT (or after
  //     the column-list `)` closes).
  //   - `seenValuesAfterInsert` flips on at VALUES; once true, the NEXT `(`
  //     is the value-list paren, NOT a column list — so we don't enter
  //     col-list mode for it. Handles the `INSERT INTO t VALUES (...)`
  //     shape (no explicit column list).
  let seenInsert = false;
  let seenValuesAfterInsert = false;
  let seenUpdateSet = false;
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i] as Token;
    if (tok.kind === 'punctuation') {
      if (tok.value === '(') {
        depth += 1;
        // First `(` after INSERT [INTO] <table>, BEFORE any VALUES,
        // is the column list. After VALUES it's a value-list paren
        // and we substitute freely inside it.
        if (seenInsert && !seenValuesAfterInsert && insertColListDepth === null) {
          insertColListDepth = depth;
        }
      } else if (tok.value === ')') {
        if (insertColListDepth !== null && depth === insertColListDepth) {
          insertColListDepth = null;
          seenInsert = false; // column list done; next paren is VALUES or SELECT.
        }
        depth -= 1;
      }
      parts.push(tok.value);
      i += 1;
      continue;
    }
    if (tok.kind === 'identifier' && depth === 0) {
      const up = tok.value.toUpperCase();
      if (up === 'SELECT') {
        inSelectList = true;
        seenInsert = false;
        seenValuesAfterInsert = false;
        seenUpdateSet = false;
        parts.push(tok.value);
        i += 1;
        continue;
      }
      if (up === 'INSERT') {
        seenInsert = true;
        seenValuesAfterInsert = false;
        inSelectList = false;
        seenUpdateSet = false;
      } else if (up === 'UPDATE') {
        seenUpdateSet = false; // resets until we see SET
      } else if (up === 'SET') {
        seenUpdateSet = true;
        inSelectList = false;
      } else if (up === 'VALUES') {
        // VALUES marks the end of the column list (if any) and the start
        // of the value-list paren. Substitute freely from here.
        seenValuesAfterInsert = true;
        seenInsert = false; // no further column-list parens.
        seenUpdateSet = false;
      } else if (up === 'WHERE' || up === 'FROM') {
        seenUpdateSet = false;
      }
      if (SELECT_LIST_TERMINATORS.has(up)) {
        inSelectList = false;
      } else if (TOP_LEVEL_NON_SELECT_KEYWORDS.has(up)) {
        inSelectList = false;
      }
    }
    if (tok.kind !== 'identifier') {
      parts.push(tok.value);
      i += 1;
      continue;
    }
    const prevIdx = previousNonWs(tokens, i);
    if (
      prevIdx !== null &&
      tokens[prevIdx]?.kind === 'punctuation' &&
      tokens[prevIdx]?.value === '.'
    ) {
      // RHS of a `.` reference (e.g. `t.col`) — not a variable lookup.
      parts.push(tok.value);
      i += 1;
      continue;
    }
    // INSERT column list: identifier is a column name, not a variable.
    if (insertColListDepth !== null && depth === insertColListDepth) {
      parts.push(tok.value);
      i += 1;
      continue;
    }
    // UPDATE SET column: identifier immediately followed by `=` at
    // depth=0 is a column name on the LHS of the assignment.
    if (seenUpdateSet && depth === 0) {
      const nxt = nextNonWs(tokens, i + 1);
      if (nxt !== null) {
        const t = tokens[nxt];
        if ((t?.kind === 'operator' || t?.kind === 'punctuation') && t.value === '=') {
          parts.push(tok.value);
          i += 1;
          continue;
        }
      }
    }
    const nextIdx = nextNonWs(tokens, i + 1);
    if (
      nextIdx !== null &&
      tokens[nextIdx]?.kind === 'punctuation' &&
      tokens[nextIdx]?.value === '.'
    ) {
      // LHS of a `.` — could be a row variable (FOR loop) or a table alias.
      const afterDot = nextNonWs(tokens, nextIdx + 1);
      const row = scope.getRow(tok.value);
      if (afterDot !== null && row !== undefined) {
        const colTok = tokens[afterDot];
        if (colTok?.kind === 'identifier') {
          const colName = colTok.value;
          const colKey = Object.keys(row.row).find(
            (k) => k.toLowerCase() === colName.toLowerCase(),
          );
          if (colKey !== undefined) {
            const colValue = row.row[colKey];
            const bqType = row.colTypes[colName.toLowerCase()] ?? 'STRING';
            values.push(prepareBindValue(colValue, bqType));
            const cast = placeholderCast(bqType);
            const placeholder = cast === '' ? `$${values.length}` : `$${values.length}${cast}`;
            const aliased =
              depth === 0 &&
              inSelectList &&
              isBareSelectListItem(tokens, prevIdx, nextNonWs(tokens, afterDot + 1));
            parts.push(aliased ? `${placeholder} AS ${quoteAlias(colName)}` : placeholder);
            i = afterDot + 1;
            continue;
          }
        }
      }
      parts.push(tok.value);
      i += 1;
      continue;
    }
    if (!scope.has(tok.value)) {
      parts.push(tok.value);
      i += 1;
      continue;
    }
    const v = scope.get(tok.value);
    if (v === undefined) {
      parts.push(tok.value);
      i += 1;
      continue;
    }
    values.push(prepareBindValue(v.value, v.bqType));
    const cast = placeholderCast(v.bqType);
    const placeholder = cast === '' ? `$${values.length}` : `$${values.length}${cast}`;
    const aliased = depth === 0 && inSelectList && isBareSelectListItem(tokens, prevIdx, nextIdx);
    parts.push(aliased ? `${placeholder} AS ${quoteAlias(tok.value)}` : placeholder);
    i += 1;
  }
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
    if (kw === 'LOOP') return parseLoop(sql, tokens, startIdx, endIdx);
    if (kw === 'WHILE') return parseWhile(sql, tokens, startIdx, endIdx);
    if (kw === 'REPEAT') return parseRepeat(sql, tokens, startIdx, endIdx);
    if (kw === 'FOR') return parseFor(sql, tokens, startIdx, endIdx);
    if (kw === 'BREAK' || kw === 'LEAVE') {
      return { stmt: { kind: 'BREAK' }, next: startIdx + 1 };
    }
    if (kw === 'CONTINUE' || kw === 'ITERATE') {
      return { stmt: { kind: 'CONTINUE' }, next: startIdx + 1 };
    }
    if (kw === 'RETURN') {
      return { stmt: { kind: 'RETURN' }, next: startIdx + 1 };
    }
    if (kw === 'CALL') return parseCall(sql, tokens, startIdx, endIdx);
    if (kw === 'EXECUTE') {
      const after = skipTrivia(tokens, startIdx + 1, endIdx);
      if (isKeyword(tokens[after], 'IMMEDIATE')) {
        return parseExecuteImmediate(sql, tokens, after, endIdx);
      }
    }
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

function parseLoop(
  sql: string,
  tokens: readonly Token[],
  startIdx: number,
  endIdx: number,
): ParseOne {
  // LOOP <body> END LOOP
  let i = skipTrivia(tokens, startIdx + 1, endIdx);
  const bodyStart = i;
  i = findCompoundEnd(tokens, i, endIdx, 'LOOP');
  const body = parseStatements(sql, tokens, bodyStart, i);
  if (!isKeyword(tokens[i], 'END')) {
    throw BqError.invalid('LOOP must terminate with END LOOP.', 'query');
  }
  i = skipTrivia(tokens, i + 1, endIdx);
  if (!isKeyword(tokens[i], 'LOOP')) {
    throw BqError.invalid('LOOP must terminate with END LOOP.', 'query');
  }
  return { stmt: { kind: 'LOOP', body }, next: i + 1 };
}

function parseWhile(
  sql: string,
  tokens: readonly Token[],
  startIdx: number,
  endIdx: number,
): ParseOne {
  // WHILE <cond> DO <body> END WHILE
  let i = skipTrivia(tokens, startIdx + 1, endIdx);
  const condStart = i;
  i = consumeUntilKeyword(tokens, i, endIdx, ['DO']);
  if (!isKeyword(tokens[i], 'DO')) {
    throw BqError.invalid('WHILE expects DO before the body.', 'query');
  }
  const cond = sliceTokenText(sql, tokens, condStart, i).trim();
  i = skipTrivia(tokens, i + 1, endIdx);
  const bodyStart = i;
  i = findCompoundEnd(tokens, i, endIdx, 'WHILE');
  const body = parseStatements(sql, tokens, bodyStart, i);
  if (!isKeyword(tokens[i], 'END')) {
    throw BqError.invalid('WHILE must terminate with END WHILE.', 'query');
  }
  i = skipTrivia(tokens, i + 1, endIdx);
  if (!isKeyword(tokens[i], 'WHILE')) {
    throw BqError.invalid('WHILE must terminate with END WHILE.', 'query');
  }
  return { stmt: { kind: 'WHILE', cond, body }, next: i + 1 };
}

function parseRepeat(
  sql: string,
  tokens: readonly Token[],
  startIdx: number,
  endIdx: number,
): ParseOne {
  // REPEAT <body> UNTIL <cond> END REPEAT
  let i = skipTrivia(tokens, startIdx + 1, endIdx);
  const bodyStart = i;
  i = findRepeatBodyEnd(tokens, i, endIdx);
  const body = parseStatements(sql, tokens, bodyStart, i);
  if (!isKeyword(tokens[i], 'UNTIL')) {
    throw BqError.invalid('REPEAT requires UNTIL <cond> END REPEAT.', 'query');
  }
  i = skipTrivia(tokens, i + 1, endIdx);
  const condStart = i;
  i = consumeUntilKeyword(tokens, i, endIdx, ['END']);
  const untilCond = sliceTokenText(sql, tokens, condStart, i).trim();
  if (!isKeyword(tokens[i], 'END')) {
    throw BqError.invalid('REPEAT must terminate with END REPEAT.', 'query');
  }
  i = skipTrivia(tokens, i + 1, endIdx);
  if (!isKeyword(tokens[i], 'REPEAT')) {
    throw BqError.invalid('REPEAT must terminate with END REPEAT.', 'query');
  }
  return { stmt: { kind: 'REPEAT', body, untilCond }, next: i + 1 };
}

function parseFor(
  sql: string,
  tokens: readonly Token[],
  startIdx: number,
  endIdx: number,
): ParseOne {
  // FOR <name> IN (<select>) DO <body> END FOR
  let i = skipTrivia(tokens, startIdx + 1, endIdx);
  const nameTok = tokens[i];
  if (nameTok?.kind !== 'identifier') {
    throw BqError.invalid('FOR expects a row variable name.', 'query');
  }
  const name = nameTok.value;
  i = skipTrivia(tokens, i + 1, endIdx);
  if (!isKeyword(tokens[i], 'IN')) {
    throw BqError.invalid('FOR expects IN after the row variable name.', 'query');
  }
  i = skipTrivia(tokens, i + 1, endIdx);
  if (!isPunct(tokens[i], '(')) {
    throw BqError.invalid('FOR ... IN expects a parenthesized SELECT.', 'query');
  }
  const open = i;
  const close = matchingParen(tokens, open, endIdx);
  const selectSql = sliceTokenText(sql, tokens, open + 1, close).trim();
  i = skipTrivia(tokens, close + 1, endIdx);
  if (!isKeyword(tokens[i], 'DO')) {
    throw BqError.invalid('FOR ... IN (...) DO ... END FOR — expected DO.', 'query');
  }
  i = skipTrivia(tokens, i + 1, endIdx);
  const bodyStart = i;
  i = findCompoundEnd(tokens, i, endIdx, 'FOR');
  const body = parseStatements(sql, tokens, bodyStart, i);
  if (!isKeyword(tokens[i], 'END')) {
    throw BqError.invalid('FOR must terminate with END FOR.', 'query');
  }
  i = skipTrivia(tokens, i + 1, endIdx);
  if (!isKeyword(tokens[i], 'FOR')) {
    throw BqError.invalid('FOR must terminate with END FOR.', 'query');
  }
  return { stmt: { kind: 'FOR', name, selectSql, body }, next: i + 1 };
}

function parseExecuteImmediate(
  sql: string,
  tokens: readonly Token[],
  immediateIdx: number,
  endIdx: number,
): ParseOne {
  // immediateIdx points at the `IMMEDIATE` token. The next non-WS token
  // begins the SQL-text expression, which runs up to `INTO`, `USING`, or `;`.
  let i = skipTrivia(tokens, immediateIdx + 1, endIdx);
  const sqlExprStart = i;
  i = consumeUntilKeywordOrSemi(tokens, i, endIdx, ['INTO', 'USING']);
  const sqlExpr = sliceTokenText(sql, tokens, sqlExprStart, i).trim();
  if (sqlExpr === '') {
    throw BqError.invalid('EXECUTE IMMEDIATE requires a SQL-text expression.', 'query');
  }

  const intoVars: string[] = [];
  if (isKeyword(tokens[i], 'INTO')) {
    i = skipTrivia(tokens, i + 1, endIdx);
    while (i < endIdx) {
      const t = tokens[i] as Token;
      if (t.kind !== 'identifier') {
        throw BqError.invalid('EXECUTE IMMEDIATE INTO expects variable names.', 'query');
      }
      intoVars.push(t.value);
      i = skipTrivia(tokens, i + 1, endIdx);
      if (isPunct(tokens[i], ',')) {
        i = skipTrivia(tokens, i + 1, endIdx);
        continue;
      }
      break;
    }
  }

  const usingClauses: UsingClause[] = [];
  if (isKeyword(tokens[i], 'USING')) {
    i = skipTrivia(tokens, i + 1, endIdx);
    while (i < endIdx) {
      // Each clause: <expr> [AS <name>], separated by `,`. The expression
      // runs until the next top-level `,` / `AS` / `;`.
      const exprStart = i;
      i = consumeUntilUsingBoundary(tokens, i, endIdx);
      const expr = sliceTokenText(sql, tokens, exprStart, i).trim();
      if (expr === '') {
        throw BqError.invalid('EXECUTE IMMEDIATE USING expects an expression.', 'query');
      }
      let name: string | undefined;
      if (isKeyword(tokens[i], 'AS')) {
        i = skipTrivia(tokens, i + 1, endIdx);
        const nameTok = tokens[i];
        if (nameTok?.kind !== 'identifier') {
          throw BqError.invalid('EXECUTE IMMEDIATE USING ... AS expects a name.', 'query');
        }
        name = nameTok.value;
        i = skipTrivia(tokens, i + 1, endIdx);
      }
      usingClauses.push(name === undefined ? { expr } : { expr, name });
      if (isPunct(tokens[i], ',')) {
        i = skipTrivia(tokens, i + 1, endIdx);
        continue;
      }
      break;
    }
  }
  return {
    stmt: { kind: 'EXECUTE_IMMEDIATE', sqlExpr, intoVars, usingClauses },
    next: i,
  };
}

function consumeUntilUsingBoundary(tokens: readonly Token[], from: number, end: number): number {
  let depth = 0;
  let i = from;
  while (i < end) {
    const t = tokens[i] as Token;
    if (t.kind === 'punctuation') {
      if (t.value === '(') depth += 1;
      else if (t.value === ')') depth -= 1;
      else if ((t.value === ',' || t.value === ';') && depth === 0) return i;
    } else if (t.kind === 'identifier' && depth === 0) {
      if (t.value.toUpperCase() === 'AS') return i;
    }
    i += 1;
  }
  return end;
}

function parseCall(
  sql: string,
  tokens: readonly Token[],
  startIdx: number,
  endIdx: number,
): ParseOne {
  // CALL <name>(arg_expr1, arg_expr2, ...)
  // Name resolution mirrors functions: dataset-qualified, backtick or
  // dotted-bare. We default to the request's project when the user only
  // wrote `dataset.proc`.
  let i = skipTrivia(tokens, startIdx + 1, endIdx);
  const nameTok = tokens[i];
  if (nameTok === undefined) {
    throw BqError.invalid('CALL expects a procedure name.', 'query');
  }
  const target = parseCallTarget(tokens, i);
  i = target.next;
  if (!isPunct(tokens[i], '(')) {
    throw BqError.invalid('CALL expects `(` after the procedure name.', 'query');
  }
  const close = matchingParen(tokens, i, endIdx);
  const argExprs = i + 1 === close ? [] : splitTopLevelCommas(sql, tokens, i + 1, close);
  return {
    stmt: {
      kind: 'CALL',
      project: target.project,
      datasetId: target.datasetId,
      procedureId: target.procedureId,
      argExprs,
    },
    next: close + 1,
  };
}

/** Parse a `[`proj.`]dataset.proc` reference and return the resolved triple
 *  plus the token index just past the name. The project defaults to the
 *  empty string — the caller (queryEngine) supplies the request-scope
 *  project when we don't see a 3-part form. */
function parseCallTarget(
  tokens: readonly Token[],
  start: number,
): { project: string; datasetId: string; procedureId: string; next: number } {
  const tok = tokens[start] as Token;
  if (tok.kind === 'backtick-identifier') {
    const inner = tok.value.slice(1, -1);
    const parts = inner.split('.');
    if (parts.length === 2) {
      return {
        project: '',
        datasetId: parts[0] as string,
        procedureId: parts[1] as string,
        next: skipTrivia(tokens, start + 1, tokens.length),
      };
    }
    if (parts.length === 3) {
      return {
        project: parts[0] as string,
        datasetId: parts[1] as string,
        procedureId: parts[2] as string,
        next: skipTrivia(tokens, start + 1, tokens.length),
      };
    }
    throw BqError.invalid(`Unsupported procedure reference \`${inner}\`.`, 'query');
  }
  if (tok.kind === 'identifier') {
    const parts: string[] = [tok.value];
    let i = skipTrivia(tokens, start + 1, tokens.length);
    while (tokens[i]?.kind === 'punctuation' && tokens[i]?.value === '.') {
      const nxt = skipTrivia(tokens, i + 1, tokens.length);
      const id = tokens[nxt];
      if (id?.kind !== 'identifier') break;
      parts.push(id.value);
      i = skipTrivia(tokens, nxt + 1, tokens.length);
    }
    if (parts.length === 2) {
      return {
        project: '',
        datasetId: parts[0] as string,
        procedureId: parts[1] as string,
        next: i,
      };
    }
    if (parts.length === 3) {
      return {
        project: parts[0] as string,
        datasetId: parts[1] as string,
        procedureId: parts[2] as string,
        next: i,
      };
    }
    throw BqError.invalid(
      `Procedure reference "${parts.join('.')}" must be dataset-qualified.`,
      'query',
    );
  }
  throw BqError.invalid('CALL expects a procedure name.', 'query');
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
      if (COMPOUND_OPENERS.has(up)) blockDepth += 1;
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
  let depth = 0; // Compound-stmt nesting inside the body (BEGIN/IF/LOOP/etc).
  while (i < end) {
    const t = tokens[i] as Token;
    if (t.kind === 'identifier') {
      const up = t.value.toUpperCase();
      if (COMPOUND_OPENERS.has(up)) {
        depth += 1;
      } else if (up === 'END' && depth > 0) {
        depth -= 1;
        const after = skipTrivia(tokens, i + 1, end);
        const afterTok = tokens[after];
        if (
          afterTok?.kind === 'identifier' &&
          COMPOUND_END_WORDS.has(afterTok.value.toUpperCase())
        ) {
          i = after;
        }
      } else if (depth === 0 && (up === 'ELSEIF' || up === 'ELSE' || up === 'END')) {
        return i;
      }
    }
    i += 1;
  }
  return end;
}

/** Compound-statement openers we have to track for matched-END nesting. */
const COMPOUND_OPENERS = new Set(['BEGIN', 'IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR']);

/** Compound-statement terminators that come after `END`. For BEGIN, the
 *  terminator is just `END` with no follow-on word. */
const COMPOUND_END_WORDS = new Set(['IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR']);

function findBlockEnd(tokens: readonly Token[], from: number, end: number): number {
  return findCompoundEnd(tokens, from, end, undefined);
}

/** Walk to the closing `END` (optionally followed by a specific keyword
 *  like LOOP/WHILE/REPEAT/FOR/IF) at the same nesting depth as the start.
 *  `expectedWord = undefined` matches a bare `END` (closing a BEGIN block). */
function findCompoundEnd(
  tokens: readonly Token[],
  from: number,
  end: number,
  expectedWord: string | undefined,
): number {
  let i = from;
  let depth = 0;
  while (i < end) {
    const t = tokens[i] as Token;
    if (t.kind === 'identifier') {
      const up = t.value.toUpperCase();
      if (COMPOUND_OPENERS.has(up)) {
        depth += 1;
      } else if (up === 'END') {
        const afterIdx = skipTrivia(tokens, i + 1, end);
        const after = tokens[afterIdx];
        const afterUp = after?.kind === 'identifier' ? after.value.toUpperCase() : undefined;
        const closes = afterUp !== undefined && COMPOUND_END_WORDS.has(afterUp);
        if (depth === 0) {
          if (expectedWord === undefined) {
            // Bare BEGIN..END close.
            if (!closes) return i;
          } else if (afterUp === expectedWord) {
            return i;
          }
        }
        if (depth > 0) {
          depth -= 1;
          if (closes) i = afterIdx; // step past `END <kind>`
        }
      }
    }
    i += 1;
  }
  return end;
}

/** Body-end finder for REPEAT — terminates at the matching UNTIL at depth 0. */
function findRepeatBodyEnd(tokens: readonly Token[], from: number, end: number): number {
  let i = from;
  let depth = 0;
  while (i < end) {
    const t = tokens[i] as Token;
    if (t.kind === 'identifier') {
      const up = t.value.toUpperCase();
      if (COMPOUND_OPENERS.has(up)) depth += 1;
      else if (up === 'END') {
        if (depth > 0) {
          depth -= 1;
          const afterIdx = skipTrivia(tokens, i + 1, end);
          const after = tokens[afterIdx];
          if (after?.kind === 'identifier' && COMPOUND_END_WORDS.has(after.value.toUpperCase())) {
            i = afterIdx;
          }
        }
      } else if (up === 'UNTIL' && depth === 0) {
        return i;
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
    case 'INTERVAL':
      return 'INTERVAL';
    case 'RANGE':
      return 'STRUCT("start" BIGINT, "end" BIGINT)';
    case 'STRUCT':
      return 'STRUCT';
  }
}

function bqTypeToDuckShort(t: BqType): string {
  return bqTypeShortDuck(t);
}

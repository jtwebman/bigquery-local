/**
 * Shared SQL execution engine — used by both `POST /queries` (BL-015) and
 * `POST /jobs` for `configuration.query` (BL-016). Takes a BigQuery SQL
 * string + parsed parameters, runs the full pipeline (translate → bind →
 * cast → execute → shape → persist), and returns everything the caller
 * needs to build its own wire response.
 *
 * Parameter parsing also lives here so the two routes can share it:
 * `parseQueryParameter(raw, path)` produces a `QueryParameterParsed`
 * record from the BQ wire shape.
 */

import { randomUUID } from 'node:crypto';

import { datasetSchemaName, ensureDatasetSchema, quoteIdent } from '../routes/tables.ts';
import type { Db, QueryResult } from '../storage/db.ts';
import {
  deleteDataset,
  deleteRoutine,
  deleteTable,
  getDataset,
  upsertDataset,
  upsertJob,
  upsertRoutine,
  upsertTable,
} from '../storage/meta.ts';
import {
  type BqField,
  type BqMode,
  type BqType,
  bqTypeToDuck,
  duckTypeToBq,
  duckValueToBq,
  normalizeBqType,
} from '../storage/types.ts';
import { BqError } from '../util/errors.ts';
import { tokenize } from './tokenize.ts';
import {
  type FunctionDdlTarget,
  type SchemaDdlTarget,
  type StatementType,
  type ViewDdlTarget,
  detectStatementType,
  parseFunctionDdl,
  parseSchemaDdl,
  parseViewDdl,
  translate,
} from './translate.ts';

// ---------------------------------------------------------------------------
// Parsed query parameter
// ---------------------------------------------------------------------------

export interface QueryParameterParsed {
  readonly name: string;
  readonly type: BqType;
  readonly arrayElementType?: BqType;
  /** Scalar value when `parameterValue.value` is set. */
  readonly scalar?: string;
  /** Element scalars when `parameterValue.arrayValues` is set. */
  readonly arrayScalars?: readonly string[];
}

// ---------------------------------------------------------------------------
// Wire-format helpers
// ---------------------------------------------------------------------------

export interface FieldWire {
  readonly name: string;
  readonly type: string;
  readonly mode?: BqMode;
  readonly fields?: readonly FieldWire[];
}

export function fieldToWire(field: BqField): FieldWire {
  return {
    name: field.name,
    type: field.type,
    ...(field.mode !== undefined && { mode: field.mode }),
    ...(field.fields !== undefined && {
      fields: field.fields.map(fieldToWire),
    }),
  };
}

export type RowWire = { readonly f: ReadonlyArray<{ readonly v: unknown }> };

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function asObject(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw BqError.invalid(`${path} must be a JSON object.`, path);
  }
  return value as Readonly<Record<string, unknown>>;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw BqError.invalid(`${path} must be a string.`, path);
  }
  return value;
}

export function parseQueryParameter(raw: unknown, path: string): QueryParameterParsed {
  const obj = asObject(raw, path);
  const name = expectString(obj['name'], `${path}.name`);
  const typeObj = asObject(obj['parameterType'], `${path}.parameterType`);
  const isArray =
    expectString(typeObj['type'], `${path}.parameterType.type`).toUpperCase() === 'ARRAY';
  const valueObj = asObject(obj['parameterValue'], `${path}.parameterValue`);

  if (isArray) {
    const elementTypeObj = asObject(typeObj['arrayType'], `${path}.parameterType.arrayType`);
    const elementType = normalizeBqType(
      expectString(elementTypeObj['type'], `${path}.parameterType.arrayType.type`),
    );
    const arrRaw = valueObj['arrayValues'];
    if (!Array.isArray(arrRaw)) {
      throw BqError.invalid(
        `${path}.parameterValue.arrayValues must be an array.`,
        `${path}.parameterValue.arrayValues`,
      );
    }
    const arrayScalars = arrRaw.map((entry, i) => {
      const entryObj = asObject(entry, `${path}.parameterValue.arrayValues[${i}]`);
      return expectString(entryObj['value'], `${path}.parameterValue.arrayValues[${i}].value`);
    });
    return {
      name,
      type: elementType,
      arrayElementType: elementType,
      arrayScalars,
    };
  }

  const scalarType = normalizeBqType(expectString(typeObj['type'], `${path}.parameterType.type`));
  const scalar = expectString(valueObj['value'], `${path}.parameterValue.value`);
  return { name, type: scalarType, scalar };
}

export function parseQueryParameters(rawParams: unknown, path: string): QueryParameterParsed[] {
  if (rawParams === undefined) return [];
  if (!Array.isArray(rawParams)) {
    throw BqError.invalid(`${path} must be an array.`, path);
  }
  return rawParams.map((p, i) => parseQueryParameter(p, `${path}[${i}]`));
}

// ---------------------------------------------------------------------------
// Parameter binding
// ---------------------------------------------------------------------------

function encodeScalarForBind(value: string, type: BqType): unknown {
  switch (type) {
    case 'INT64':
      return BigInt(value);
    case 'FLOAT64':
      return Number(value);
    case 'BOOL':
      return value.toLowerCase() === 'true';
    case 'STRING':
    case 'BYTES':
    case 'NUMERIC':
    case 'BIGNUMERIC':
    case 'TIMESTAMP':
    case 'DATETIME':
    case 'DATE':
    case 'TIME':
    case 'JSON':
    case 'GEOGRAPHY':
      return value;
    case 'STRUCT':
      throw BqError.invalid('STRUCT parameters are not supported in v0.', 'parameterType');
  }
}

function arrayElementForJson(value: string, type: BqType): unknown {
  switch (type) {
    case 'FLOAT64':
      return Number(value);
    case 'BOOL':
      return value.toLowerCase() === 'true';
    case 'STRUCT':
      throw BqError.invalid('STRUCT elements in ARRAY parameters are not supported in v0.');
    default:
      return value;
  }
}

function encodeArrayForBind(values: readonly string[], elementType: BqType): string {
  return JSON.stringify(values.map((v) => arrayElementForJson(v, elementType)));
}

function arrayPlaceholderCast(elementType: BqType): string {
  return `::JSON::${bqTypeToDuck({ name: 'x', type: elementType })}[]`;
}

/**
 * Cast applied to scalar `$N` placeholders for types that DuckDB does not
 * implicitly coerce from VARCHAR in every context. Equality and comparison
 * coerce fine, but arithmetic with `INTERVAL` (e.g. `@now - INTERVAL 1 HOUR`)
 * requires an explicit typed cast. The cast targets must match the
 * column types chosen by `bqTypeToDuck` so cross-type comparisons line up:
 *
 *   BQ TIMESTAMP → DuckDB TIMESTAMPTZ (tz-aware, like real BQ)
 *   BQ DATETIME  → DuckDB TIMESTAMP
 *   BQ DATE      → DuckDB DATE
 *   BQ TIME      → DuckDB TIME
 *
 * Returning `null` means no cast is needed — DuckDB will infer the right
 * type from the bound JS value.
 */
function scalarPlaceholderCast(type: BqType): string | null {
  switch (type) {
    case 'TIMESTAMP':
      return '::TIMESTAMPTZ';
    case 'DATETIME':
      return '::TIMESTAMP';
    case 'DATE':
      return '::DATE';
    case 'TIME':
      return '::TIME';
    default:
      return null;
  }
}

function mapParameters(
  paramOrder: readonly string[],
  parameters: readonly QueryParameterParsed[],
): unknown[] {
  const byName = new Map(parameters.map((p) => [p.name, p] as const));
  return paramOrder.map((name) => {
    const param = byName.get(name);
    if (param === undefined) {
      throw BqError.invalid(
        `Query parameter "@${name}" is referenced in the query but not provided.`,
        `queryParameters.${name}`,
      );
    }
    if (param.arrayScalars !== undefined && param.arrayElementType !== undefined) {
      return encodeArrayForBind(param.arrayScalars, param.arrayElementType);
    }
    if (param.scalar !== undefined) {
      return encodeScalarForBind(param.scalar, param.type);
    }
    /* node:coverage ignore next 4 */
    throw BqError.invalid(`Query parameter "@${name}" has no value.`, `queryParameters.${name}`);
  });
}

function augmentPlaceholderCasts(
  sql: string,
  paramOrder: readonly string[],
  parameters: readonly QueryParameterParsed[],
): string {
  const byName = new Map(parameters.map((p) => [p.name, p] as const));
  let result = sql;
  for (let i = 0; i < paramOrder.length; i += 1) {
    const name = paramOrder[i] as string;
    const param = byName.get(name);
    if (param === undefined) continue;
    let cast: string | null = null;
    if (param.arrayElementType !== undefined) {
      cast = arrayPlaceholderCast(param.arrayElementType);
    } else {
      cast = scalarPlaceholderCast(param.type);
    }
    if (cast === null) continue;
    const placeholderNumber = i + 1;
    const pattern = new RegExp(`\\$${placeholderNumber}(?!\\d)`, 'g');
    const replacement = `$${placeholderNumber}${cast}`;
    result = result.replace(pattern, () => replacement);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

function buildResultSchema(
  columnNames: readonly string[],
  columnTypes: readonly string[],
): BqField[] {
  return columnNames.map((name, i) => {
    const typeStr = columnTypes[i] ?? 'VARCHAR';
    return duckTypeToBq(typeStr, name);
  });
}

function rowsToWire(
  rows: ReadonlyArray<Record<string, unknown>>,
  schema: readonly BqField[],
): RowWire[] {
  return rows.map((row) => ({
    f: schema.map((field) => ({ v: duckValueToBq(row[field.name], field) })),
  }));
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export interface QueryExecution {
  readonly jobId: string;
  readonly statementType: StatementType;
  readonly schema: readonly BqField[];
  readonly wireRows: readonly RowWire[];
  readonly startedMs: number;
  readonly endedMs: number;
  readonly totalRows: number;
  /** Rows touched by an INSERT/UPDATE/DELETE/MERGE. Undefined for SELECT. */
  readonly dmlAffectedRows?: number;
}

/**
 * Run the full BQ → DuckDB pipeline for a query and persist it as a
 * completed job. Returns enough to build either the `bigquery#queryResponse`
 * shape (BL-015) or the `bigquery#job` shape (BL-016).
 *
 * `jobId` may be passed in (e.g. when the request supplied
 * `jobReference.jobId`) or omitted to generate a fresh UUID.
 */
export async function executeQuery(
  db: Db,
  project: string,
  query: string,
  parameters: readonly QueryParameterParsed[],
  options: { readonly jobId?: string } = {},
): Promise<QueryExecution> {
  const statementType = detectStatementType(query);
  const expanded = await expandWildcardTables(query, db, project);
  const translated = translate(expanded, { project });
  const values = mapParameters(translated.paramOrder, parameters);
  const sqlWithCasts = augmentPlaceholderCasts(translated.sql, translated.paramOrder, parameters);

  if (statementType === 'CREATE_VIEW' || statementType === 'DROP_VIEW') {
    return executeViewDdl(db, project, query, sqlWithCasts, statementType, options);
  }
  if (statementType === 'CREATE_SCHEMA' || statementType === 'DROP_SCHEMA') {
    return executeSchemaDdl(db, project, query, statementType, options);
  }
  if (statementType === 'SCRIPT') {
    return executeScript(db, project, query, sqlWithCasts, options);
  }
  if (statementType === 'CREATE_FUNCTION' || statementType === 'DROP_FUNCTION') {
    return executeFunctionDdl(db, project, query, statementType, options);
  }

  let result: QueryResult;
  try {
    result = await db.queryWithSchema(sqlWithCasts, values);
  } catch (err) {
    throw BqError.invalid(err instanceof Error ? err.message : 'Query execution failed.', 'query');
  }

  const jobId = options.jobId ?? randomUUID();
  const startedMs = Date.now();
  const endedMs = startedMs;

  if (statementType !== 'SELECT') {
    // DuckDB DML returns a single row { Count: BIGINT }. BQ's wire shape for
    // DML has no schema and no rows — just `numDmlAffectedRows` in stats.
    const affected = readDmlCount(result);
    await upsertJob(db, {
      project,
      jobId,
      state: 'DONE',
      statementType,
      query,
      params: parameters,
      startedMs,
      endedMs,
      resultSchema: { fields: [] },
      resultTotalRows: 0,
      dmlAffectedRows: affected,
    });
    return {
      jobId,
      statementType,
      schema: [],
      wireRows: [],
      startedMs,
      endedMs,
      totalRows: 0,
      dmlAffectedRows: affected,
    };
  }

  const schema = buildResultSchema(result.columnNames, result.columnTypes);
  const wireRows = rowsToWire(result.rows, schema);

  await upsertJob(db, {
    project,
    jobId,
    state: 'DONE',
    statementType: 'SELECT',
    query,
    params: parameters,
    startedMs,
    endedMs,
    resultSchema: { fields: schema },
    resultTotalRows: result.rows.length,
  });
  for (let i = 0; i < wireRows.length; i += 1) {
    await db.exec(
      'INSERT INTO _bq.job_rows (project, job_id, row_index, row) VALUES ($1, $2, $3::BIGINT, $4::JSON)',
      [project, jobId, BigInt(i), JSON.stringify(wireRows[i])],
    );
  }

  return {
    jobId,
    statementType: 'SELECT',
    schema,
    wireRows,
    startedMs,
    endedMs,
    totalRows: result.rows.length,
  };
}

function readDmlCount(result: QueryResult): number {
  const first = result.rows[0];
  if (first === undefined) return 0;
  const raw = first['Count'] ?? first[result.columnNames[0] ?? ''];
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return Number(raw);
  return 0;
}

// ---------------------------------------------------------------------------
// DDL: VIEW
// ---------------------------------------------------------------------------

async function executeViewDdl(
  db: Db,
  project: string,
  originalQuery: string,
  translatedSql: string,
  statementType: 'CREATE_VIEW' | 'DROP_VIEW',
  options: { readonly jobId?: string },
): Promise<QueryExecution> {
  const target = parseViewDdl(originalQuery, project);
  // Dataset must exist (mirrors REST tables.insert behavior).
  const dataset = await getDataset(db, target.project, target.datasetId);
  if (dataset === null) {
    throw BqError.notFound(`Dataset "${target.project}:${target.datasetId}" not found.`);
  }
  await ensureDatasetSchema(db, target.project, target.datasetId);

  try {
    await db.exec(translatedSql);
  } catch (err) {
    throw BqError.invalid(err instanceof Error ? err.message : 'DDL execution failed.', 'query');
  }

  if (statementType === 'CREATE_VIEW') {
    await registerViewMetadata(db, target);
  } else {
    await deleteTable(db, target.project, target.datasetId, target.viewId);
  }

  const jobId = options.jobId ?? randomUUID();
  const now = Date.now();
  await upsertJob(db, {
    project,
    jobId,
    state: 'DONE',
    statementType,
    query: originalQuery,
    startedMs: now,
    endedMs: now,
    resultSchema: { fields: [] },
    resultTotalRows: 0,
  });

  return {
    jobId,
    statementType,
    schema: [],
    wireRows: [],
    startedMs: now,
    endedMs: now,
    totalRows: 0,
  };
}

async function executeScript(
  db: Db,
  project: string,
  originalQuery: string,
  translatedSql: string,
  options: { readonly jobId?: string },
): Promise<QueryExecution> {
  // Multi-statement script: BEGIN [TRANSACTION] ; … ; COMMIT|ROLLBACK ;
  // DuckDB executes the whole string in one go. If a statement fails
  // mid-script the transaction stays open — explicitly ROLLBACK so the
  // shared connection isn't left in a half-applied state where the next
  // query sees uncommitted inserts. The synchronous response carries no
  // rows (real BQ models per-statement child jobs we don't represent
  // in v0).
  try {
    await db.exec(translatedSql);
  } catch (err) {
    try {
      await db.exec('ROLLBACK');
    } catch {
      // No transaction was open (e.g. the BEGIN itself failed) — nothing to undo.
    }
    throw BqError.invalid(err instanceof Error ? err.message : 'Script execution failed.', 'query');
  }
  const jobId = options.jobId ?? randomUUID();
  const now = Date.now();
  await upsertJob(db, {
    project,
    jobId,
    state: 'DONE',
    statementType: 'SCRIPT',
    query: originalQuery,
    startedMs: now,
    endedMs: now,
    resultSchema: { fields: [] },
    resultTotalRows: 0,
  });
  return {
    jobId,
    statementType: 'SCRIPT',
    schema: [],
    wireRows: [],
    startedMs: now,
    endedMs: now,
    totalRows: 0,
  };
}

async function executeSchemaDdl(
  db: Db,
  project: string,
  originalQuery: string,
  statementType: 'CREATE_SCHEMA' | 'DROP_SCHEMA',
  options: { readonly jobId?: string },
): Promise<QueryExecution> {
  const target = parseSchemaDdl(originalQuery, project);
  if (statementType === 'CREATE_SCHEMA') {
    await runCreateSchema(db, target);
  } else {
    await runDropSchema(db, target);
  }

  const jobId = options.jobId ?? randomUUID();
  const now = Date.now();
  await upsertJob(db, {
    project,
    jobId,
    state: 'DONE',
    statementType,
    query: originalQuery,
    startedMs: now,
    endedMs: now,
    resultSchema: { fields: [] },
    resultTotalRows: 0,
  });
  return {
    jobId,
    statementType,
    schema: [],
    wireRows: [],
    startedMs: now,
    endedMs: now,
    totalRows: 0,
  };
}

async function runCreateSchema(db: Db, target: SchemaDdlTarget): Promise<void> {
  const existing = await getDataset(db, target.project, target.datasetId);
  if (existing !== null) {
    if (target.ifNotExists) return;
    throw BqError.duplicate(`Dataset "${target.project}:${target.datasetId}" already exists.`);
  }
  await upsertDataset(db, { project: target.project, datasetId: target.datasetId });
  await ensureDatasetSchema(db, target.project, target.datasetId);
}

async function runDropSchema(db: Db, target: SchemaDdlTarget): Promise<void> {
  const existing = await getDataset(db, target.project, target.datasetId);
  if (existing === null) {
    if (target.ifExists) return;
    throw BqError.notFound(`Dataset "${target.project}:${target.datasetId}" not found.`);
  }
  // For CASCADE, surface the actual DuckDB error (e.g. "schema not empty")
  // before any metadata removal happens — otherwise a half-cleared state
  // would survive a failed DROP. So: DROP first in DuckDB, reconcile metadata
  // only on success.
  const schemaName = datasetSchemaName(target.project, target.datasetId);
  const cascadeKw = target.cascade ? ' CASCADE' : '';
  try {
    await db.exec(`DROP SCHEMA IF EXISTS ${quoteIdent(schemaName)}${cascadeKw}`);
  } catch (err) {
    throw BqError.invalid(err instanceof Error ? err.message : 'DDL execution failed.', 'query');
  }
  // CASCADE took the underlying tables with it; mirror that in _bq.tables.
  if (target.cascade) {
    await db.exec('DELETE FROM _bq.tables WHERE project = $1 AND dataset_id = $2', [
      target.project,
      target.datasetId,
    ]);
  }
  await deleteDataset(db, target.project, target.datasetId);
}

// ---------------------------------------------------------------------------
// DDL: FUNCTION (SQL UDF)
// ---------------------------------------------------------------------------

async function executeFunctionDdl(
  db: Db,
  project: string,
  originalQuery: string,
  statementType: 'CREATE_FUNCTION' | 'DROP_FUNCTION',
  options: { readonly jobId?: string },
): Promise<QueryExecution> {
  const target = parseFunctionDdl(originalQuery, project);
  if (statementType === 'CREATE_FUNCTION') {
    await runCreateFunction(db, target);
  } else {
    await runDropFunction(db, target);
  }
  const jobId = options.jobId ?? randomUUID();
  const now = Date.now();
  await upsertJob(db, {
    project,
    jobId,
    state: 'DONE',
    statementType,
    query: originalQuery,
    startedMs: now,
    endedMs: now,
    resultSchema: { fields: [] },
    resultTotalRows: 0,
  });
  return {
    jobId,
    statementType,
    schema: [],
    wireRows: [],
    startedMs: now,
    endedMs: now,
    totalRows: 0,
  };
}

async function runCreateFunction(db: Db, target: FunctionDdlTarget): Promise<void> {
  // Persistent functions live in their dataset; TEMP lives in DuckDB's
  // session-temp schema (closest analogue to BQ session-scoped TEMP).
  if (!target.isTemp) {
    if (target.datasetId === undefined) {
      throw BqError.invalid(
        'CREATE FUNCTION requires a dataset-qualified name unless TEMP.',
        'query',
      );
    }
    const ds = await getDataset(db, target.project, target.datasetId);
    if (ds === null) {
      throw BqError.notFound(`Dataset "${target.project}:${target.datasetId}" not found.`);
    }
    await ensureDatasetSchema(db, target.project, target.datasetId);
  }
  const macroSql = buildCreateMacroSql(target);
  try {
    await db.exec(macroSql);
  } catch (err) {
    throw BqError.invalid(err instanceof Error ? err.message : 'DDL execution failed.', 'query');
  }
  // Only persist non-TEMP routines — DuckDB owns the lifecycle of TEMP macros,
  // and a process-restart drops the in-memory state anyway.
  if (!target.isTemp && target.datasetId !== undefined && target.body !== undefined) {
    await upsertRoutine(db, {
      project: target.project,
      datasetId: target.datasetId,
      routineId: target.functionId,
      routineType: 'SCALAR_FUNCTION',
      language: 'SQL',
      arguments: target.args.map((a) => ({ name: a.name, dataType: { typeKind: a.typeText } })),
      ...(target.returnType !== undefined && {
        returnType: { typeKind: target.returnType },
      }),
      body: target.body,
    });
  }
}

async function runDropFunction(db: Db, target: FunctionDdlTarget): Promise<void> {
  // TEMP path: drop via DuckDB directly; nothing to reconcile in _bq.routines.
  if (target.isTemp || target.datasetId === undefined) {
    const guard = target.ifExists ? 'IF EXISTS ' : '';
    try {
      await db.exec(`DROP MACRO ${guard}${quoteIdent(target.functionId)}`);
    } catch (err) {
      throw BqError.invalid(err instanceof Error ? err.message : 'DDL execution failed.', 'query');
    }
    return;
  }
  const existing = await getRoutineSafe(db, target.project, target.datasetId, target.functionId);
  if (existing === null) {
    if (target.ifExists) return;
    throw BqError.notFound(
      `Routine "${target.project}:${target.datasetId}.${target.functionId}" not found.`,
    );
  }
  const dsName = datasetSchemaName(target.project, target.datasetId);
  try {
    await db.exec(`DROP MACRO IF EXISTS ${quoteIdent(dsName)}.${quoteIdent(target.functionId)}`);
  } catch (err) {
    throw BqError.invalid(err instanceof Error ? err.message : 'DDL execution failed.', 'query');
  }
  await deleteRoutine(db, target.project, target.datasetId, target.functionId);
}

async function getRoutineSafe(
  db: Db,
  project: string,
  datasetId: string,
  routineId: string,
): Promise<unknown | null> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT routine_id FROM _bq.routines
      WHERE project = $1 AND dataset_id = $2 AND routine_id = $3`,
    [project, datasetId, routineId],
  );
  return rows[0] ?? null;
}

/**
 * Build the DuckDB `CREATE [OR REPLACE] [TEMP] MACRO [IF NOT EXISTS] ...`
 * statement for a BQ UDF definition. Argument types are dropped (DuckDB
 * doesn't enforce them on macros); the RETURNS type is honored by wrapping
 * the body in `CAST(... AS <duckType>)`.
 */
function buildCreateMacroSql(target: FunctionDdlTarget): string {
  const orReplace = target.orReplace ? 'OR REPLACE ' : '';
  const temp = target.isTemp ? 'TEMP ' : '';
  const ifNotExists = target.ifNotExists ? 'IF NOT EXISTS ' : '';
  const qualifiedName = target.isTemp
    ? quoteIdent(target.functionId)
    : `${quoteIdent(datasetSchemaName(target.project, target.datasetId as string))}.${quoteIdent(
        target.functionId,
      )}`;
  const argList = target.args.map((a) => quoteIdent(a.name)).join(', ');
  const body = target.body ?? '';
  const wrapped =
    target.returnType !== undefined
      ? `CAST((${body}) AS ${bqTypeTextToDuck(target.returnType)})`
      : `(${body})`;
  return `CREATE ${orReplace}${temp}MACRO ${ifNotExists}${qualifiedName}(${argList}) AS ${wrapped}`;
}

/**
 * Lightweight BQ → DuckDB type-text translation for use in CAST.
 * Covers the common scalar names and ARRAY<…>. Anything else passes through
 * verbatim, which works for DuckDB-compatible spellings the user wrote.
 */
function bqTypeTextToDuck(text: string): string {
  let s = text.trim();
  s = s.replace(/ARRAY\s*<\s*([^>]+)\s*>/gi, '$1[]');
  s = s.replace(/\bINT64\b/gi, 'BIGINT');
  s = s.replace(/\bFLOAT64\b/gi, 'DOUBLE');
  s = s.replace(/\bBOOL\b/gi, 'BOOLEAN');
  s = s.replace(/\bSTRING\b/gi, 'VARCHAR');
  s = s.replace(/\bBYTES\b/gi, 'BLOB');
  s = s.replace(/\bNUMERIC\b/gi, 'DECIMAL(38, 9)');
  return s;
}

async function registerViewMetadata(db: Db, target: ViewDdlTarget): Promise<void> {
  const dsName = datasetSchemaName(target.project, target.datasetId);
  const described = await db.query<Record<string, unknown>>(
    `DESCRIBE ${quoteIdent(dsName)}.${quoteIdent(target.viewId)}`,
  );
  const fields = described.map((row) => {
    const name = String(row['column_name']);
    const type = String(row['column_type']);
    return duckTypeToBq(type, name);
  });
  await upsertTable(db, {
    project: target.project,
    datasetId: target.datasetId,
    tableId: target.viewId,
    type: 'VIEW',
    schema: { fields },
    ...(target.viewQuery !== undefined && { viewQuery: target.viewQuery }),
  });
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

export interface DryRunResult {
  readonly statementType: StatementType;
  readonly schema: readonly BqField[];
}

/**
 * Validate + plan a query without executing it. Returns the result schema
 * the query would produce. Matches BigQuery's `dryRun: true` semantics:
 * the query is parsed, bound, and planned — but no rows are read, no job is
 * persisted, and no result page is allocated.
 *
 * Implementation rides on DuckDB's `DESCRIBE <query>`, which does the full
 * bind step (so unknown columns / type mismatches / unknown tables surface
 * here exactly as they would at execute time) and returns column metadata
 * without running the plan.
 *
 * Parameters still go through the same translate → augment → bind pipeline
 * so `@param` placeholders resolve cleanly. The bound values don't influence
 * the output schema, but they have to be valid for DESCRIBE to succeed.
 */
export async function executeQueryDryRun(
  db: Db,
  project: string,
  query: string,
  parameters: readonly QueryParameterParsed[],
): Promise<DryRunResult> {
  const statementType = detectStatementType(query);
  const expanded = await expandWildcardTables(query, db, project);
  const translated = translate(expanded, { project });
  const values = mapParameters(translated.paramOrder, parameters);
  const sqlWithCasts = augmentPlaceholderCasts(translated.sql, translated.paramOrder, parameters);

  if (statementType !== 'SELECT') {
    // DESCRIBE doesn't parse DML in DuckDB; EXPLAIN plans the statement
    // without mutating rows, which still surfaces unknown tables / columns /
    // type mismatches as proper errors here.
    try {
      await db.query(`EXPLAIN ${sqlWithCasts}`, values);
    } catch (err) {
      throw BqError.invalid(
        err instanceof Error ? err.message : 'Query validation failed.',
        'query',
      );
    }
    return { statementType, schema: [] };
  }

  // DuckDB accepts DESCRIBE on a query string; the parameter bindings flow
  // through the same prepared-statement path the executor uses.
  const describeSql = `DESCRIBE ${sqlWithCasts}`;

  let described: ReadonlyArray<Record<string, unknown>>;
  try {
    described = await db.query(describeSql, values);
  } catch (err) {
    throw BqError.invalid(err instanceof Error ? err.message : 'Query validation failed.', 'query');
  }

  const schema = described.map((row) => {
    const name = String(row['column_name']);
    const type = String(row['column_type']);
    return duckTypeToBq(type, name);
  });

  return { statementType, schema };
}

// ---------------------------------------------------------------------------
// Wildcard tables: `ds.prefix_*` → (SELECT *, '<suffix>' AS _TABLE_SUFFIX FROM `ds.prefix_X` UNION ALL …)
// ---------------------------------------------------------------------------

/**
 * Resolves BQ wildcard table references at the SQL-string level, before
 * translation. For each backtick of the form `\`[proj.]ds.prefix_*\``, looks
 * up matching tables in `_bq.tables`, and substitutes the wildcard with a
 * UNION ALL subquery that surfaces the `_TABLE_SUFFIX` pseudo-column:
 *
 *   `ds.events_*`  →  (SELECT *, '20240101' AS _TABLE_SUFFIX FROM `ds.events_20240101`
 *                       UNION ALL
 *                      SELECT *, '20240102' AS _TABLE_SUFFIX FROM `ds.events_20240102`)
 *
 * The result is still BQ SQL (backticks intact), so `translate()` does the
 * usual project-qualified rewrite on the substituted parts.
 */
async function expandWildcardTables(
  query: string,
  db: Db,
  defaultProject: string,
): Promise<string> {
  if (!query.includes('*')) return query;
  const tokens = tokenize(query);
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const tok of tokens) {
    if (tok.kind !== 'backtick-identifier') continue;
    const inner = tok.value.slice(1, -1);
    if (!inner.endsWith('*')) continue;
    const parts = inner.slice(0, -1).split('.');
    let proj: string;
    let ds: string;
    let prefix: string;
    if (parts.length === 2) {
      proj = defaultProject;
      ds = parts[0] as string;
      prefix = parts[1] as string;
    } else if (parts.length === 3) {
      proj = parts[0] as string;
      ds = parts[1] as string;
      prefix = parts[2] as string;
    } else {
      throw BqError.invalid(
        `Wildcard table \`${inner}\` must be dataset.prefix_* or project.dataset.prefix_*.`,
        'query',
      );
    }
    const rows = await db.query<{ table_id: string }>(
      `SELECT table_id FROM _bq.tables
        WHERE project = $1 AND dataset_id = $2
          AND table_id LIKE $3
          AND type = 'TABLE'
        ORDER BY table_id`,
      [proj, ds, `${prefix}%`],
    );
    if (rows.length === 0) {
      throw BqError.notFound(`No tables match wildcard \`${inner}\` in dataset "${proj}:${ds}".`);
    }
    const unionParts = rows.map((r) => {
      const suffix = r.table_id.slice(prefix.length);
      return `SELECT *, ${quoteStringLiteral(suffix)} AS _TABLE_SUFFIX FROM \`${ds}.${r.table_id}\``;
    });
    replacements.push({
      start: tok.start,
      end: tok.end,
      text: `(${unionParts.join(' UNION ALL ')})`,
    });
  }
  if (replacements.length === 0) return query;
  // Apply tail-to-head so earlier offsets stay valid as we splice.
  let out = query;
  for (let i = replacements.length - 1; i >= 0; i -= 1) {
    const r = replacements[i] as { start: number; end: number; text: string };
    out = `${out.slice(0, r.start)}${r.text}${out.slice(r.end)}`;
  }
  return out;
}

function quoteStringLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

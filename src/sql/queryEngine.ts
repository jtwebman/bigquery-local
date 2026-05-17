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

import type { Db, QueryResult } from '../storage/db.ts';
import { upsertJob } from '../storage/meta.ts';
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
import { translate } from './translate.ts';

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
    ...(field.fields !== undefined && { fields: field.fields.map(fieldToWire) }),
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
    return { name, type: elementType, arrayElementType: elementType, arrayScalars };
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
  readonly schema: readonly BqField[];
  readonly wireRows: readonly RowWire[];
  readonly startedMs: number;
  readonly endedMs: number;
  readonly totalRows: number;
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
  const translated = translate(query, { project });
  const values = mapParameters(translated.paramOrder, parameters);
  const sqlWithCasts = augmentPlaceholderCasts(translated.sql, translated.paramOrder, parameters);

  let result: QueryResult;
  try {
    result = await db.queryWithSchema(sqlWithCasts, values);
  } catch (err) {
    throw BqError.invalid(err instanceof Error ? err.message : 'Query execution failed.', 'query');
  }

  const schema = buildResultSchema(result.columnNames, result.columnTypes);
  const wireRows = rowsToWire(result.rows, schema);
  const jobId = options.jobId ?? randomUUID();
  const startedMs = Date.now();
  const endedMs = startedMs;

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
    schema,
    wireRows,
    startedMs,
    endedMs,
    totalRows: result.rows.length,
  };
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

export interface DryRunResult {
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
  const translated = translate(query, { project });
  const values = mapParameters(translated.paramOrder, parameters);
  const sqlWithCasts = augmentPlaceholderCasts(translated.sql, translated.paramOrder, parameters);
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

  return { schema };
}

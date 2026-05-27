/**
 * Shared SQL execution engine for `POST /queries` and `POST /jobs`. Runs the
 * full pipeline (translate → bind → cast → execute → shape → persist) and also
 * houses parameter parsing so both routes can share it.
 */

import { randomUUID } from 'node:crypto';

import { datasetSchemaName, ensureDatasetSchema, quoteIdent } from '../routes/tables.ts';
import type { Db, QueryResult } from '../storage/db.ts';
import {
  deleteDataset,
  deleteRoutine,
  deleteTable,
  getDataset,
  getTable,
  upsertDataset,
  upsertJob,
  upsertRoutine,
  upsertTable,
} from '../storage/meta.ts';
import {
  type BqField,
  type BqMode,
  type BqType,
  bqIntervalToDuckBindString,
  bqTypeToDuck,
  bqTypeToWire,
  duckTypeToBq,
  duckValueToBq,
  normalizeBqType,
} from '../storage/types.ts';
import { BqError } from '../util/errors.ts';
import { type ScriptResult, executeBqScript } from './script.ts';
import { tokenize } from './tokenize.ts';
import {
  type FunctionDdlTarget,
  type ProcedureDdlTarget,
  type SchemaDdlTarget,
  type StatementType,
  type ViewDdlTarget,
  detectStatementType,
  parseFunctionDdl,
  parseProcedureDdl,
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
  readonly rangeElementType?: { readonly type: string };
}

export function fieldToWire(field: BqField): FieldWire {
  return {
    name: field.name,
    type: bqTypeToWire(field.type),
    ...(field.mode !== undefined && { mode: field.mode }),
    ...(field.fields !== undefined && {
      fields: field.fields.map(fieldToWire),
    }),
    ...(field.rangeElementType !== undefined && {
      rangeElementType: { type: field.rangeElementType.type },
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
      return coerceParameterValue(
        entryObj['value'],
        `${path}.parameterValue.arrayValues[${i}].value`,
      );
    });
    return {
      name,
      type: elementType,
      arrayElementType: elementType,
      arrayScalars,
    };
  }

  const scalarType = normalizeBqType(expectString(typeObj['type'], `${path}.parameterType.type`));
  const scalar = coerceParameterValue(valueObj['value'], `${path}.parameterValue.value`);
  return { name, type: scalarType, scalar };
}

/** Accept both the BQ wire form (`"42"`) and the Python-client form (native
 *  JSON number/boolean); coerce to string for the downstream binding pipeline. */
function coerceParameterValue(value: unknown, path: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  throw BqError.invalid(`${path} must be a string, number, or boolean.`, path);
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
    case 'INTERVAL':
      // Pre-translate BQ wire form ("Y-M D H:M:S") to a DuckDB-parseable literal
      // so the `::INTERVAL` cast in scalarPlaceholderCast can accept it.
      return bqIntervalToDuckBindString(value);
    case 'RANGE':
      throw BqError.invalid(
        'RANGE query parameters are not yet supported. Reference RANGE values via SELECT against a table column.',
        'parameterType',
      );
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
 * Cast for scalar `$N` placeholders whose types DuckDB won't implicitly coerce
 * from VARCHAR in arithmetic contexts (e.g. `@now - INTERVAL 1 HOUR`). Targets
 * must match the column types `bqTypeToDuck` picks so comparisons line up: BQ
 * TIMESTAMP → DuckDB TIMESTAMPTZ (tz-aware, like real BQ), DATETIME → TIMESTAMP,
 * DATE → DATE, TIME → TIME. `null` means DuckDB infers the type from the value.
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
    case 'INTERVAL':
      return '::INTERVAL';
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
 * Per-server query result cache (BL-157). Keyed by project + normalized SQL +
 * params; identical SELECTs within a server lifetime skip DuckDB but still get
 * a fresh jobId and `_bq.job_rows` so pagination works like a miss. No TTL and
 * no per-table invalidation — unlike real BQ a cached SELECT can go stale after
 * an INSERT; clients needing fresh data pass `useQueryCache: false`.
 */
interface CachedResult {
  readonly statementType: StatementType;
  readonly schema: readonly BqField[];
  readonly wireRows: readonly RowWire[];
}
const queryCache: Map<string, CachedResult> = new Map();

function cacheKey(
  project: string,
  query: string,
  parameters: readonly QueryParameterParsed[],
): string {
  // Collapse whitespace + trim so semantically-identical SQL hashes the same.
  const normalized = query.replace(/\s+/g, ' ').trim();
  return `${project}\x00${normalized}\x00${JSON.stringify(parameters)}`;
}

/** Test-only: clear the cache between unit tests. */
export function _resetQueryCacheForTests(): void {
  queryCache.clear();
}

/** Clear the entire query cache. Called by any path that mutates persisted
 *  data; v0 doesn't track per-table dependencies, so we drop everything. */
export function invalidateQueryCache(): void {
  queryCache.clear();
}

/** Build a fresh job from a cached SELECT result: new unique jobId, rows
 *  re-inserted into `_bq.job_rows`, and `cacheHit=true` for the wire response. */
async function returnCachedSelect(
  db: Db,
  project: string,
  jobId: string,
  query: string,
  parameters: readonly QueryParameterParsed[],
  cached: CachedResult,
): Promise<QueryExecution> {
  const now = Date.now();
  await upsertJob(db, {
    project,
    jobId,
    state: 'DONE',
    statementType: 'SELECT',
    query,
    params: parameters,
    startedMs: now,
    endedMs: now,
    resultSchema: { fields: cached.schema },
    resultTotalRows: cached.wireRows.length,
    cacheHit: true,
  });
  for (let i = 0; i < cached.wireRows.length; i += 1) {
    await db.exec(
      'INSERT INTO _bq.job_rows (project, job_id, row_index, row) VALUES ($1, $2, $3::BIGINT, $4::JSON)',
      [project, jobId, BigInt(i), JSON.stringify(cached.wireRows[i])],
    );
  }
  return {
    jobId,
    statementType: 'SELECT',
    schema: cached.schema,
    wireRows: cached.wireRows,
    startedMs: now,
    endedMs: now,
    totalRows: cached.wireRows.length,
  };
}

export async function executeQuery(
  db: Db,
  project: string,
  query: string,
  parameters: readonly QueryParameterParsed[],
  options: {
    readonly jobId?: string;
    readonly labels?: Readonly<Record<string, string>>;
    /** Job-level region (defaults to 'US'). A query referencing a dataset in a
     *  different `location` fails with `invalid`. */
    readonly location?: string;
    /** When `false`, skip the cache (don't read or store). Default `true`. */
    readonly useQueryCache?: boolean;
  } = {},
): Promise<QueryExecution> {
  const statementType = detectStatementType(query);
  await enforceJobLocation(db, project, query, options.location);

  // Seed the job row up front so labels/location persist through later
  // branch-specific upsertJob calls (which COALESCE on those fields).
  const jobId = options.jobId ?? randomUUID();
  const optionsWithJobId = { ...options, jobId };
  if (options.labels !== undefined || options.location !== undefined) {
    await upsertJob(db, {
      project,
      jobId,
      state: 'RUNNING',
      ...(options.labels !== undefined && { labels: options.labels }),
      ...(options.location !== undefined && { location: options.location }),
    });
  }

  // Only SELECT is cacheable; every other statement type mutates state, so
  // clear the cache up front.
  const useCache = options.useQueryCache !== false;
  if (statementType !== 'SELECT') {
    invalidateQueryCache();
  } else if (useCache) {
    const cached = queryCache.get(cacheKey(project, query, parameters));
    if (cached !== undefined) {
      return await returnCachedSelect(db, project, jobId, query, parameters, cached);
    }
  }

  const expanded = await expandWildcardTables(query, db, project);
  const translated = translate(expanded, { project });
  const values = mapParameters(translated.paramOrder, parameters);
  const sqlWithCasts = augmentPlaceholderCasts(translated.sql, translated.paramOrder, parameters);

  if (statementType === 'CREATE_VIEW' || statementType === 'DROP_VIEW') {
    return executeViewDdl(db, project, query, sqlWithCasts, statementType, optionsWithJobId);
  }
  if (statementType === 'CREATE_MATERIALIZED_VIEW' || statementType === 'DROP_MATERIALIZED_VIEW') {
    return executeMaterializedViewDdl(db, project, query, statementType, optionsWithJobId);
  }
  if (statementType === 'CREATE_SCHEMA' || statementType === 'DROP_SCHEMA') {
    return executeSchemaDdl(db, project, query, statementType, optionsWithJobId);
  }
  if (statementType === 'SCRIPT') {
    // `CALL BQ.REFRESH_MATERIALIZED_VIEW('ds.mv')` is the only BQ built-in
    // procedure we support; everything else flows to the scripting runtime.
    const mvRefresh = parseRefreshMaterializedViewCall(query, project);
    if (mvRefresh !== null) {
      return executeRefreshMaterializedView(db, project, query, mvRefresh, optionsWithJobId);
    }
    return executeScript(db, project, query, optionsWithJobId);
  }
  if (
    statementType === 'CREATE_FUNCTION' ||
    statementType === 'DROP_FUNCTION' ||
    statementType === 'CREATE_TABLE_FUNCTION' ||
    statementType === 'DROP_TABLE_FUNCTION'
  ) {
    return executeFunctionDdl(db, project, query, statementType, optionsWithJobId);
  }
  if (statementType === 'CREATE_PROCEDURE' || statementType === 'DROP_PROCEDURE') {
    return executeProcedureDdl(db, project, query, statementType, optionsWithJobId);
  }

  let result: QueryResult;
  try {
    result = await db.queryWithSchema(sqlWithCasts, values);
  } catch (err) {
    throw BqError.invalid(err instanceof Error ? err.message : 'Query execution failed.', 'query');
  }

  const startedMs = Date.now();
  const endedMs = startedMs;

  if (statementType !== 'SELECT') {
    // DuckDB DML returns a single { Count: BIGINT } row; BQ's DML wire shape has
    // no schema/rows, just `numDmlAffectedRows` in stats.
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
    cacheHit: false,
  });
  for (let i = 0; i < wireRows.length; i += 1) {
    await db.exec(
      'INSERT INTO _bq.job_rows (project, job_id, row_index, row) VALUES ($1, $2, $3::BIGINT, $4::JSON)',
      [project, jobId, BigInt(i), JSON.stringify(wireRows[i])],
    );
  }
  if (useCache) {
    queryCache.set(cacheKey(project, query, parameters), {
      statementType: 'SELECT',
      schema,
      wireRows,
    });
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

/**
 * Materialized-view DDL. CREATE translates the SELECT body, materializes it via
 * `CREATE TABLE <dest> AS SELECT ...`, and registers `type='MATERIALIZED_VIEW'`
 * metadata; DROP removes the backing table and metadata. Rows are a point-in-time
 * snapshot (matching a freshly-created BQ MV) until an explicit refresh.
 */
async function executeMaterializedViewDdl(
  db: Db,
  project: string,
  originalQuery: string,
  statementType: 'CREATE_MATERIALIZED_VIEW' | 'DROP_MATERIALIZED_VIEW',
  options: { readonly jobId?: string },
): Promise<QueryExecution> {
  const target = parseViewDdl(originalQuery, project);
  const dataset = await getDataset(db, target.project, target.datasetId);
  if (dataset === null) {
    throw BqError.notFound(`Dataset "${target.project}:${target.datasetId}" not found.`);
  }
  await ensureDatasetSchema(db, target.project, target.datasetId);

  const dsName = datasetSchemaName(target.project, target.datasetId);
  const qualified = `${quoteIdent(dsName)}.${quoteIdent(target.viewId)}`;

  if (statementType === 'CREATE_MATERIALIZED_VIEW') {
    if (target.viewQuery === undefined) {
      throw BqError.invalid('CREATE MATERIALIZED VIEW requires an AS <query> body.', 'query');
    }
    const existing = await getTable(db, target.project, target.datasetId, target.viewId);
    if (existing !== null) {
      throw BqError.duplicate(
        `Materialized view "${target.project}:${target.datasetId}.${target.viewId}" already exists.`,
      );
    }
    const translatedBody = translate(target.viewQuery, { project: target.project }).sql;
    try {
      await db.exec(`CREATE TABLE ${qualified} AS SELECT * FROM (${translatedBody})`);
    } catch (err) {
      throw BqError.invalid(
        err instanceof Error ? err.message : 'Materialized view creation failed.',
        'query',
      );
    }
    const described = await db.query<Record<string, unknown>>(`DESCRIBE ${qualified}`);
    const fields = described.map((row) =>
      duckTypeToBq(String(row['column_type']), String(row['column_name'])),
    );
    await upsertTable(db, {
      project: target.project,
      datasetId: target.datasetId,
      tableId: target.viewId,
      type: 'MATERIALIZED_VIEW',
      schema: { fields },
      viewQuery: target.viewQuery,
    });
  } else {
    const existing = await getTable(db, target.project, target.datasetId, target.viewId);
    if (existing === null) {
      throw BqError.notFound(
        `Materialized view "${target.project}:${target.datasetId}.${target.viewId}" not found.`,
      );
    }
    if (existing.type !== 'MATERIALIZED_VIEW') {
      throw BqError.invalid(
        `Table "${target.project}:${target.datasetId}.${target.viewId}" is not a materialized view.`,
        'query',
      );
    }
    await db.exec(`DROP TABLE ${qualified}`);
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

/**
 * Cross-location guard. BQ scopes datasets to a region and rejects queries
 * referencing a dataset in a different location than the job. The emulator
 * doesn't physically partition, but enforces the contract: walk backticked
 * refs and check each dataset's stored `location` against the job's. An unset
 * location on either side is treated as compatible (lenient by design).
 */
async function enforceJobLocation(
  db: Db,
  defaultProject: string,
  query: string,
  jobLocation: string | undefined,
): Promise<void> {
  if (jobLocation === undefined) return;
  const tokens = tokenize(query);
  const seen = new Set<string>();
  for (const tok of tokens) {
    if (tok.kind !== 'backtick-identifier') continue;
    const inner = tok.value.slice(1, -1);
    const parts = inner.split('.').filter((p) => p !== '');
    let proj: string;
    let ds: string;
    if (parts.length >= 3) {
      proj = parts[0] as string;
      ds = parts[1] as string;
    } else if (parts.length === 2) {
      proj = defaultProject;
      ds = parts[0] as string;
    } else {
      continue;
    }
    const key = `${proj}:${ds}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dataset = await getDataset(db, proj, ds);
    if (dataset === null) continue;
    if (dataset.location === undefined) continue;
    if (dataset.location !== jobLocation) {
      throw BqError.invalid(
        `Cannot run job in location "${jobLocation}" against dataset "${proj}:${ds}" in location "${dataset.location}".`,
        'jobReference.location',
      );
    }
  }
}

/**
 * Recognizes `CALL BQ.REFRESH_MATERIALIZED_VIEW('<name>')` where `<name>` is
 * `dataset.mv` or `project.dataset.mv`. Returns the parsed triple, or null if
 * the SQL isn't this specific procedure call.
 */
interface RefreshMvTarget {
  readonly project: string;
  readonly datasetId: string;
  readonly mvId: string;
}

function parseRefreshMaterializedViewCall(
  sql: string,
  defaultProject: string,
): RefreshMvTarget | null {
  const tokens = tokenize(sql);
  let i = 0;
  while (i < tokens.length && (tokens[i] as { kind: string }).kind === 'whitespace') i += 1;
  const t0 = tokens[i];
  if (t0 === undefined || t0.kind !== 'identifier' || t0.value.toUpperCase() !== 'CALL') {
    return null;
  }
  i += 1;
  while (i < tokens.length && (tokens[i] as { kind: string }).kind === 'whitespace') i += 1;
  const t1 = tokens[i];
  if (t1 === undefined || t1.kind !== 'identifier' || t1.value.toUpperCase() !== 'BQ') {
    return null;
  }
  i += 1;
  while (i < tokens.length && (tokens[i] as { kind: string }).kind === 'whitespace') i += 1;
  const t2 = tokens[i];
  if (t2 === undefined || t2.kind !== 'punctuation' || t2.value !== '.') return null;
  i += 1;
  while (i < tokens.length && (tokens[i] as { kind: string }).kind === 'whitespace') i += 1;
  const t3 = tokens[i];
  if (
    t3 === undefined ||
    t3.kind !== 'identifier' ||
    t3.value.toUpperCase() !== 'REFRESH_MATERIALIZED_VIEW'
  ) {
    return null;
  }
  i += 1;
  while (i < tokens.length && (tokens[i] as { kind: string }).kind === 'whitespace') i += 1;
  const t4 = tokens[i];
  if (t4 === undefined || t4.kind !== 'punctuation' || t4.value !== '(') return null;
  i += 1;
  while (i < tokens.length && (tokens[i] as { kind: string }).kind === 'whitespace') i += 1;
  const nameTok = tokens[i];
  if (nameTok === undefined || nameTok.kind !== 'string') return null;
  const rawValue = nameTok.value;
  const stripped = rawValue.replace(/^['"]|['"]$/g, '');
  const parts = stripped.split('.');
  let projectId: string;
  let datasetId: string;
  let mvId: string;
  if (parts.length === 3) {
    [projectId, datasetId, mvId] = parts as [string, string, string];
  } else if (parts.length === 2) {
    projectId = defaultProject;
    [datasetId, mvId] = parts as [string, string];
  } else {
    return null;
  }
  return { project: projectId, datasetId, mvId };
}

/** Run a single MV refresh: clear the backing table, then re-INSERT from the
 *  stored source query. Reported as a SCRIPT-shaped job. */
async function executeRefreshMaterializedView(
  db: Db,
  project: string,
  originalQuery: string,
  target: RefreshMvTarget,
  options: { readonly jobId?: string },
): Promise<QueryExecution> {
  const existing = await getTable(db, target.project, target.datasetId, target.mvId);
  if (existing === null) {
    throw BqError.notFound(
      `Materialized view "${target.project}:${target.datasetId}.${target.mvId}" not found.`,
    );
  }
  if (existing.type !== 'MATERIALIZED_VIEW') {
    throw BqError.invalid(
      `Table "${target.project}:${target.datasetId}.${target.mvId}" is not a materialized view.`,
      'query',
    );
  }
  if (existing.viewQuery === undefined) {
    /* node:coverage ignore next 3 */
    throw BqError.internalError(
      `Materialized view "${target.mvId}" has no stored source query — cannot refresh.`,
    );
  }

  const qualified = `${quoteIdent(datasetSchemaName(target.project, target.datasetId))}.${quoteIdent(target.mvId)}`;
  const translatedBody = translate(existing.viewQuery, { project: target.project }).sql;

  try {
    await db.exec(`DELETE FROM ${qualified}`);
    await db.exec(`INSERT INTO ${qualified} SELECT * FROM (${translatedBody})`);
  } catch (err) {
    throw BqError.invalid(
      err instanceof Error ? err.message : 'Materialized view refresh failed.',
      'query',
    );
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

async function executeScript(
  db: Db,
  project: string,
  originalQuery: string,
  options: { readonly jobId?: string },
): Promise<QueryExecution> {
  // The interpreter (src/sql/script.ts) walks DECLARE/SET/IF/BEGIN constructs
  // and dispatches plain SQL to DuckDB. On a mid-script failure we explicitly
  // ROLLBACK so the shared connection doesn't carry over an open transaction.
  let result: ScriptResult;
  try {
    result = await executeBqScript(db, project, originalQuery);
  } catch (err) {
    try {
      await db.exec('ROLLBACK');
    } catch {
      // No open transaction — nothing to undo.
    }
    if (err instanceof BqError) throw err;
    throw BqError.invalid(err instanceof Error ? err.message : 'Script execution failed.', 'query');
  }
  const jobId = options.jobId ?? randomUUID();
  const now = Date.now();
  const wireRows = rowsToWire(result.rows, result.schema);
  await upsertJob(db, {
    project,
    jobId,
    state: 'DONE',
    statementType: 'SCRIPT',
    query: originalQuery,
    startedMs: now,
    endedMs: now,
    resultSchema: { fields: result.schema },
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
    statementType: 'SCRIPT',
    schema: result.schema,
    wireRows,
    startedMs: now,
    endedMs: now,
    totalRows: result.rows.length,
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
  // DROP in DuckDB first, reconcile metadata only on success — otherwise a
  // failed DROP (e.g. "schema not empty") would leave a half-cleared state.
  const schemaName = datasetSchemaName(target.project, target.datasetId);
  const cascadeKw = target.cascade ? ' CASCADE' : '';
  try {
    await db.exec(`DROP SCHEMA IF EXISTS ${quoteIdent(schemaName)}${cascadeKw}`);
  } catch (err) {
    throw BqError.invalid(err instanceof Error ? err.message : 'DDL execution failed.', 'query');
  }
  // CASCADE dropped the underlying tables; mirror that in _bq.tables.
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
  statementType:
    | 'CREATE_FUNCTION'
    | 'DROP_FUNCTION'
    | 'CREATE_TABLE_FUNCTION'
    | 'DROP_TABLE_FUNCTION',
  options: { readonly jobId?: string },
): Promise<QueryExecution> {
  const target = parseFunctionDdl(originalQuery, project);
  if (statementType === 'CREATE_FUNCTION' || statementType === 'CREATE_TABLE_FUNCTION') {
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

// ---------------------------------------------------------------------------
// DDL: PROCEDURE
// ---------------------------------------------------------------------------

async function executeProcedureDdl(
  db: Db,
  project: string,
  originalQuery: string,
  statementType: 'CREATE_PROCEDURE' | 'DROP_PROCEDURE',
  options: { readonly jobId?: string },
): Promise<QueryExecution> {
  const target = parseProcedureDdl(originalQuery, project);
  if (statementType === 'CREATE_PROCEDURE') {
    await runCreateProcedure(db, target);
  } else {
    await runDropProcedure(db, target);
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

async function runCreateProcedure(db: Db, target: ProcedureDdlTarget): Promise<void> {
  const ds = await getDataset(db, target.project, target.datasetId);
  if (ds === null) {
    throw BqError.notFound(`Dataset "${target.project}:${target.datasetId}" not found.`);
  }
  if (target.body === undefined) {
    throw BqError.invalid('CREATE PROCEDURE requires a body.', 'query');
  }
  const existing = await getRoutineSafe(db, target.project, target.datasetId, target.procedureId);
  if (existing !== null && !target.orReplace) {
    if (target.ifNotExists) return;
    throw BqError.duplicate(
      `Procedure "${target.project}:${target.datasetId}.${target.procedureId}" already exists.`,
    );
  }
  await upsertRoutine(db, {
    project: target.project,
    datasetId: target.datasetId,
    routineId: target.procedureId,
    routineType: 'PROCEDURE',
    language: 'SQL',
    arguments: target.args.map((a) => ({
      name: a.name,
      mode: a.mode,
      dataType: { typeKind: a.typeText },
    })),
    body: target.body,
  });
}

async function runDropProcedure(db: Db, target: ProcedureDdlTarget): Promise<void> {
  const existing = await getRoutineSafe(db, target.project, target.datasetId, target.procedureId);
  if (existing === null) {
    if (target.ifExists) return;
    throw BqError.notFound(
      `Procedure "${target.project}:${target.datasetId}.${target.procedureId}" not found.`,
    );
  }
  await deleteRoutine(db, target.project, target.datasetId, target.procedureId);
}

async function runCreateFunction(db: Db, target: FunctionDdlTarget): Promise<void> {
  // TEMP functions live in DuckDB's session-temp schema (closest analogue to
  // BQ's session-scoped TEMP); persistent ones live in their dataset.
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
  // Only persist non-TEMP routines — DuckDB owns the TEMP macro lifecycle.
  if (!target.isTemp && target.datasetId !== undefined && target.body !== undefined) {
    await upsertRoutine(db, {
      project: target.project,
      datasetId: target.datasetId,
      routineId: target.functionId,
      routineType: target.isTableValued ? 'TABLE_VALUED_FUNCTION' : 'SCALAR_FUNCTION',
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
  // DuckDB has separate DROP keywords for scalar vs table macros.
  const macroKind = target.isTableValued ? 'MACRO TABLE' : 'MACRO';
  if (target.isTemp || target.datasetId === undefined) {
    // TEMP path: drop via DuckDB directly; nothing to reconcile in _bq.routines.
    const guard = target.ifExists ? 'IF EXISTS ' : '';
    try {
      await db.exec(`DROP ${macroKind} ${guard}${quoteIdent(target.functionId)}`);
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
    await db.exec(
      `DROP ${macroKind} IF EXISTS ${quoteIdent(dsName)}.${quoteIdent(target.functionId)}`,
    );
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
 * Build the DuckDB `CREATE [OR REPLACE] [TEMP] MACRO ...` statement for a BQ
 * UDF. Argument types are dropped (DuckDB doesn't enforce them on macros); the
 * RETURNS type is honored by wrapping the body in `CAST(... AS <duckType>)`.
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
  // Run the body through the translator so backtick refs and other BQ-isms
  // become DuckDB-resolvable SQL.
  const rawBody = target.body ?? '';
  const body = rawBody === '' ? '' : translate(rawBody, { project: target.project }).sql;
  // TVF uses DuckDB's `AS TABLE <select>` form; the RETURNS TABLE<…> clause is
  // captured in metadata but not enforced.
  if (target.isTableValued) {
    return `CREATE ${orReplace}${temp}MACRO ${ifNotExists}${qualifiedName}(${argList}) AS TABLE (${body})`;
  }
  const wrapped =
    target.returnType !== undefined
      ? `CAST((${body}) AS ${bqTypeTextToDuck(target.returnType)})`
      : `(${body})`;
  return `CREATE ${orReplace}${temp}MACRO ${ifNotExists}${qualifiedName}(${argList}) AS ${wrapped}`;
}

/**
 * Lightweight BQ → DuckDB type-text translation for CAST. Covers common scalar
 * names and ARRAY<…>; anything else passes through verbatim.
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
  /** Estimated bytes processed at execute time. For SELECT, `output-row-count ×
   *  estimated-bytes-per-row`, so WHERE/partition filters shrink the estimate.
   *  DML returns 0 (it plans without scanning). */
  readonly totalBytesProcessed: number;
}

/** Rough fixed bytes-per-value per BQ type for the dry-run estimator; the goal
 *  is monotonicity with row count, not accuracy. */
const BQ_TYPE_BYTES: Readonly<Record<string, number>> = {
  STRING: 16,
  BYTES: 32,
  INT64: 8,
  FLOAT64: 8,
  BOOL: 1,
  NUMERIC: 16,
  BIGNUMERIC: 16,
  TIMESTAMP: 8,
  DATETIME: 8,
  DATE: 4,
  TIME: 8,
  JSON: 64,
  GEOGRAPHY: 64,
  STRUCT: 32,
};

function estimateRowBytes(schema: readonly BqField[]): number {
  let total = 0;
  for (const field of schema) {
    const base = BQ_TYPE_BYTES[field.type] ?? 16;
    // REPEATED columns assume a conservative average length of 3.
    total += field.mode === 'REPEATED' ? base * 3 : base;
  }
  // Floor of 1 so empty-schema queries (SCRIPT etc.) don't underflow to 0.
  return total === 0 ? 1 : total;
}

/**
 * Validate + plan a query without executing it (BQ `dryRun: true`): parse, bind,
 * and plan, but read no rows and persist no job. Rides on DuckDB's
 * `DESCRIBE <query>`, whose full bind step surfaces unknown columns/tables and
 * type mismatches exactly as execute time would. Params still flow through the
 * normal translate → augment → bind pipeline and must be valid for DESCRIBE.
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
    // DESCRIBE doesn't parse DML in DuckDB; EXPLAIN plans it without mutating
    // rows while still surfacing unknown tables/columns/type mismatches.
    try {
      await db.query(`EXPLAIN ${sqlWithCasts}`, values);
    } catch (err) {
      throw BqError.invalid(
        err instanceof Error ? err.message : 'Query validation failed.',
        'query',
      );
    }
    return { statementType, schema: [], totalBytesProcessed: 0 };
  }

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

  // Estimate `totalBytesProcessed` as output-row-count × bytes-per-row by
  // wrapping the query in `SELECT count(*) FROM (<orig>)`; WHERE/partition
  // pruning shrinks the count and thus the estimate.
  let totalBytesProcessed = 0;
  try {
    const countResult = await db.query<{ n: bigint }>(
      `SELECT count(*)::BIGINT AS n FROM (${sqlWithCasts}) _est`,
      values,
    );
    const rowCount = Number(countResult[0]?.n ?? 0);
    totalBytesProcessed = rowCount * estimateRowBytes(schema);
  } catch {
    // Some queries won't survive the COUNT wrap; fall back to 0 since DESCRIBE
    // already validated the query (under-reporting beats erroring).
    totalBytesProcessed = 0;
  }

  return { statementType, schema, totalBytesProcessed };
}

// ---------------------------------------------------------------------------
// Wildcard tables: `ds.prefix_*` → (SELECT *, '<suffix>' AS _TABLE_SUFFIX FROM `ds.prefix_X` UNION ALL …)
// ---------------------------------------------------------------------------

/**
 * Resolves BQ wildcard table refs (`\`[proj.]ds.prefix_*\``) at the SQL-string
 * level before translation: looks up matching `_bq.tables` and substitutes a
 * UNION ALL subquery surfacing the `_TABLE_SUFFIX` pseudo-column. The result is
 * still BQ SQL (backticks intact), so `translate()` rewrites the substituted parts.
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
  // Splice tail-to-head so earlier offsets stay valid.
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

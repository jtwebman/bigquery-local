/**
 * Metadata schema + CRUD.
 *
 * On startup, `ensureMetaSchema(db)` creates the `_bq` schema and the four
 * metadata tables (`datasets`, `tables`, `jobs`, `job_rows`). All BigQuery
 * resource metadata flows through this module; user-visible BQ datasets get
 * their own DuckDB schemas elsewhere.
 *
 * **Timestamp columns** (`created_at`, `updated_at`, `started_at`,
 * `ended_at`, `expires_at`) are stored as DuckDB native `TIMESTAMP`, so
 * future SQL surfaces — INFORMATION_SCHEMA views, time-based filters,
 * ad-hoc dev queries — can use them directly. The JS-facing API stays on
 * millisecond `number`s; conversion happens in the SQL via DuckDB's
 * `epoch_ms()` (bidirectional: `BIGINT ms → TIMESTAMP` on insert,
 * `TIMESTAMP → BIGINT ms` on select).
 *
 * Each resource exposes a small CRUD surface (`get*`, `upsert*`,
 * `delete*` where applicable). `upsert*` accepts an optional `ifMatch`
 * argument and surfaces `BqError.conditionNotMet` (HTTP 412) on a stale
 * ETag, or `BqError.notFound` when If-Match is sent against a missing
 * resource (matching BigQuery's behavior).
 */

import type { Db } from './db.ts';
import { BqError } from '../util/errors.ts';
import { checkIfMatch, etag } from '../util/etag.ts';

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

const DDL_STATEMENTS: readonly string[] = [
  `CREATE SCHEMA IF NOT EXISTS _bq`,
  `CREATE TABLE IF NOT EXISTS _bq.datasets (
    project VARCHAR NOT NULL,
    dataset_id VARCHAR NOT NULL,
    etag VARCHAR NOT NULL,
    location VARCHAR,
    friendly_name VARCHAR,
    description VARCHAR,
    labels JSON,
    default_table_expiration_ms BIGINT,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    PRIMARY KEY (project, dataset_id)
  )`,
  `CREATE TABLE IF NOT EXISTS _bq.tables (
    project VARCHAR NOT NULL,
    dataset_id VARCHAR NOT NULL,
    table_id VARCHAR NOT NULL,
    type VARCHAR NOT NULL,
    etag VARCHAR NOT NULL,
    "schema" JSON,
    description VARCHAR,
    num_rows BIGINT,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    expires_at TIMESTAMP,
    partitioning JSON,
    clustering JSON,
    PRIMARY KEY (project, dataset_id, table_id)
  )`,
  `CREATE TABLE IF NOT EXISTS _bq.jobs (
    project VARCHAR NOT NULL,
    job_id VARCHAR NOT NULL,
    state VARCHAR NOT NULL,
    statement_type VARCHAR,
    error JSON,
    query VARCHAR,
    params JSON,
    types JSON,
    created_at TIMESTAMP NOT NULL,
    started_at TIMESTAMP,
    ended_at TIMESTAMP,
    result_schema JSON,
    result_total_rows BIGINT,
    PRIMARY KEY (project, job_id)
  )`,
  `CREATE TABLE IF NOT EXISTS _bq.job_rows (
    project VARCHAR NOT NULL,
    job_id VARCHAR NOT NULL,
    row_index BIGINT NOT NULL,
    row JSON NOT NULL,
    PRIMARY KEY (project, job_id, row_index)
  )`,
];

export async function ensureMetaSchema(db: Db): Promise<void> {
  for (const stmt of DDL_STATEMENTS) {
    await db.exec(stmt);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PartialField<K extends string, V> = Partial<Record<K, V>>;

/** Spread helper for optional fields: produces `{ [key]: value }` when value
 * is defined, or `{}` otherwise. Plays nicely with `exactOptionalPropertyTypes`. */
function optional<K extends string, V>(key: K, value: V | null | undefined): PartialField<K, V> {
  if (value === null || value === undefined) return {};
  return { [key]: value } as Record<K, V>;
}

function toNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : (value as number);
}

function optionalNumber<K extends string>(key: K, value: unknown): PartialField<K, number> {
  if (value === null || value === undefined) return {};
  return { [key]: toNumber(value) } as Record<K, number>;
}

function parseJson<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

function optionalJson<K extends string, V>(key: K, value: unknown): PartialField<K, V> {
  const parsed = parseJson<V>(value);
  return parsed === undefined ? {} : ({ [key]: parsed } as Record<K, V>);
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/** Bind a millisecond timestamp / count as DuckDB BIGINT — DuckDB-Node's
 * default coercion of JS `number` is INTEGER (32-bit), which truncates
 * `Date.now()` values. Always wrap BIGINT-typed columns (and BIGINT inputs
 * to `epoch_ms()` for TIMESTAMP columns) through this. */
function bigintOrNull(value: number | undefined): bigint | null {
  return value === undefined ? null : BigInt(value);
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

export interface DatasetMetaInput {
  readonly project: string;
  readonly datasetId: string;
  readonly location?: string;
  readonly friendlyName?: string;
  readonly description?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly defaultTableExpirationMs?: number;
}

export interface DatasetMeta extends DatasetMetaInput {
  readonly etag: string;
  readonly createdMs: number;
  readonly updatedMs: number;
}

const SELECT_DATASET = `SELECT
  project, dataset_id, etag, location, friendly_name, description,
  labels, default_table_expiration_ms,
  epoch_ms(created_at) AS created_ms,
  epoch_ms(updated_at) AS updated_ms
FROM _bq.datasets
WHERE project = $1 AND dataset_id = $2`;

export async function getDataset(
  db: Db,
  project: string,
  datasetId: string,
): Promise<DatasetMeta | null> {
  const rows = await db.query<Record<string, unknown>>(SELECT_DATASET, [project, datasetId]);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    project: row['project'] as string,
    datasetId: row['dataset_id'] as string,
    etag: row['etag'] as string,
    createdMs: toNumber(row['created_ms']),
    updatedMs: toNumber(row['updated_ms']),
    ...optional('location', row['location'] as string | null),
    ...optional('friendlyName', row['friendly_name'] as string | null),
    ...optional('description', row['description'] as string | null),
    ...optionalJson<'labels', Record<string, string>>('labels', row['labels']),
    ...optionalNumber('defaultTableExpirationMs', row['default_table_expiration_ms']),
  };
}

export async function upsertDataset(
  db: Db,
  input: DatasetMetaInput,
  ifMatch?: string,
): Promise<DatasetMeta> {
  const existing = await getDataset(db, input.project, input.datasetId);
  if (existing !== null) {
    checkIfMatch(existing.etag, ifMatch);
  } else if (ifMatch !== undefined) {
    // BigQuery returns 404 when If-Match is supplied for a missing resource.
    throw BqError.notFound(`Dataset "${input.project}:${input.datasetId}" not found.`);
  }
  const newEtag = etag(input);
  const now = Date.now();
  const createdMs = existing?.createdMs ?? now;
  await db.exec(
    `INSERT INTO _bq.datasets (
      project, dataset_id, etag, location, friendly_name, description,
      labels, default_table_expiration_ms, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, epoch_ms($9::BIGINT), epoch_ms($10::BIGINT))
    ON CONFLICT (project, dataset_id) DO UPDATE SET
      etag = EXCLUDED.etag,
      location = EXCLUDED.location,
      friendly_name = EXCLUDED.friendly_name,
      description = EXCLUDED.description,
      labels = EXCLUDED.labels,
      default_table_expiration_ms = EXCLUDED.default_table_expiration_ms,
      updated_at = EXCLUDED.updated_at`,
    [
      input.project,
      input.datasetId,
      newEtag,
      input.location ?? null,
      input.friendlyName ?? null,
      input.description ?? null,
      jsonOrNull(input.labels),
      bigintOrNull(input.defaultTableExpirationMs),
      BigInt(createdMs),
      BigInt(now),
    ],
  );
  return {
    ...input,
    etag: newEtag,
    createdMs,
    updatedMs: now,
  };
}

export async function deleteDataset(
  db: Db,
  project: string,
  datasetId: string,
  ifMatch?: string,
): Promise<boolean> {
  const existing = await getDataset(db, project, datasetId);
  if (existing === null) return false;
  checkIfMatch(existing.etag, ifMatch);
  await db.exec('DELETE FROM _bq.datasets WHERE project = $1 AND dataset_id = $2', [
    project,
    datasetId,
  ]);
  return true;
}

/** Paginated list of datasets in a project, ordered by `dataset_id`.
 * `offset` is a non-negative integer; callers translate `pageToken` to it. */
export async function listDatasets(
  db: Db,
  project: string,
  options: { readonly offset: number; readonly limit: number },
): Promise<{ readonly datasets: readonly DatasetMeta[]; readonly nextOffset: number | null }> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT
       project, dataset_id, etag, location, friendly_name, description,
       labels, default_table_expiration_ms,
       epoch_ms(created_at) AS created_ms,
       epoch_ms(updated_at) AS updated_ms
     FROM _bq.datasets
     WHERE project = $1
     ORDER BY dataset_id
     LIMIT $2::BIGINT OFFSET $3::BIGINT`,
    [project, BigInt(options.limit + 1), BigInt(options.offset)],
  );
  // Read one extra to know if there's a next page without a separate count query.
  const hasMore = rows.length > options.limit;
  const sliced = hasMore ? rows.slice(0, options.limit) : rows;
  const datasets = sliced.map((row) => ({
    project: row['project'] as string,
    datasetId: row['dataset_id'] as string,
    etag: row['etag'] as string,
    createdMs: toNumber(row['created_ms']),
    updatedMs: toNumber(row['updated_ms']),
    ...optional('location', row['location'] as string | null),
    ...optional('friendlyName', row['friendly_name'] as string | null),
    ...optional('description', row['description'] as string | null),
    ...optionalJson<'labels', Record<string, string>>('labels', row['labels']),
    ...optionalNumber('defaultTableExpirationMs', row['default_table_expiration_ms']),
  }));
  return { datasets, nextOffset: hasMore ? options.offset + options.limit : null };
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface TableMetaInput {
  readonly project: string;
  readonly datasetId: string;
  readonly tableId: string;
  readonly type: string;
  readonly schema?: unknown;
  readonly description?: string;
  readonly numRows?: number;
  readonly expirationMs?: number;
  readonly partitioning?: unknown;
  readonly clustering?: unknown;
}

export interface TableMeta extends TableMetaInput {
  readonly etag: string;
  readonly createdMs: number;
  readonly updatedMs: number;
}

const SELECT_TABLE = `SELECT
  project, dataset_id, table_id, type, etag, "schema", description,
  num_rows, partitioning, clustering,
  epoch_ms(created_at) AS created_ms,
  epoch_ms(updated_at) AS updated_ms,
  epoch_ms(expires_at) AS expiration_ms
FROM _bq.tables
WHERE project = $1 AND dataset_id = $2 AND table_id = $3`;

export async function getTable(
  db: Db,
  project: string,
  datasetId: string,
  tableId: string,
): Promise<TableMeta | null> {
  const rows = await db.query<Record<string, unknown>>(SELECT_TABLE, [project, datasetId, tableId]);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    project: row['project'] as string,
    datasetId: row['dataset_id'] as string,
    tableId: row['table_id'] as string,
    type: row['type'] as string,
    etag: row['etag'] as string,
    createdMs: toNumber(row['created_ms']),
    updatedMs: toNumber(row['updated_ms']),
    ...optionalJson<'schema', unknown>('schema', row['schema']),
    ...optional('description', row['description'] as string | null),
    ...optionalNumber('numRows', row['num_rows']),
    ...optionalNumber('expirationMs', row['expiration_ms']),
    ...optionalJson<'partitioning', unknown>('partitioning', row['partitioning']),
    ...optionalJson<'clustering', unknown>('clustering', row['clustering']),
  };
}

export async function upsertTable(
  db: Db,
  input: TableMetaInput,
  ifMatch?: string,
): Promise<TableMeta> {
  const existing = await getTable(db, input.project, input.datasetId, input.tableId);
  if (existing !== null) {
    checkIfMatch(existing.etag, ifMatch);
  } else if (ifMatch !== undefined) {
    throw BqError.notFound(
      `Table "${input.project}:${input.datasetId}.${input.tableId}" not found.`,
    );
  }
  const newEtag = etag(input);
  const now = Date.now();
  const createdMs = existing?.createdMs ?? now;
  const expiresAtParam = input.expirationMs === undefined ? null : BigInt(input.expirationMs);
  await db.exec(
    `INSERT INTO _bq.tables (
      project, dataset_id, table_id, type, etag, "schema", description,
      num_rows, created_at, updated_at, expires_at, partitioning, clustering
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, epoch_ms($9::BIGINT), epoch_ms($10::BIGINT),
      CASE WHEN $11 IS NULL THEN NULL ELSE epoch_ms($11::BIGINT) END,
      $12, $13
    )
    ON CONFLICT (project, dataset_id, table_id) DO UPDATE SET
      type = EXCLUDED.type,
      etag = EXCLUDED.etag,
      "schema" = EXCLUDED."schema",
      description = EXCLUDED.description,
      num_rows = EXCLUDED.num_rows,
      updated_at = EXCLUDED.updated_at,
      expires_at = EXCLUDED.expires_at,
      partitioning = EXCLUDED.partitioning,
      clustering = EXCLUDED.clustering`,
    [
      input.project,
      input.datasetId,
      input.tableId,
      input.type,
      newEtag,
      jsonOrNull(input.schema),
      input.description ?? null,
      bigintOrNull(input.numRows),
      BigInt(createdMs),
      BigInt(now),
      expiresAtParam,
      jsonOrNull(input.partitioning),
      jsonOrNull(input.clustering),
    ],
  );
  return {
    ...input,
    etag: newEtag,
    createdMs,
    updatedMs: now,
  };
}

export async function deleteTable(
  db: Db,
  project: string,
  datasetId: string,
  tableId: string,
  ifMatch?: string,
): Promise<boolean> {
  const existing = await getTable(db, project, datasetId, tableId);
  if (existing === null) return false;
  checkIfMatch(existing.etag, ifMatch);
  await db.exec(
    `DELETE FROM _bq.tables
     WHERE project = $1 AND dataset_id = $2 AND table_id = $3`,
    [project, datasetId, tableId],
  );
  return true;
}

/** Paginated list of tables in a dataset, ordered by `table_id`.
 * Mirrors `listDatasets`. The route layer is responsible for confirming
 * the parent dataset exists (so an empty list isn't ambiguous with a
 * missing dataset). */
export async function listTables(
  db: Db,
  project: string,
  datasetId: string,
  options: { readonly offset: number; readonly limit: number },
): Promise<{ readonly tables: readonly TableMeta[]; readonly nextOffset: number | null }> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT
       project, dataset_id, table_id, type, etag, "schema", description,
       num_rows, partitioning, clustering,
       epoch_ms(created_at) AS created_ms,
       epoch_ms(updated_at) AS updated_ms,
       epoch_ms(expires_at) AS expiration_ms
     FROM _bq.tables
     WHERE project = $1 AND dataset_id = $2
     ORDER BY table_id
     LIMIT $3::BIGINT OFFSET $4::BIGINT`,
    [project, datasetId, BigInt(options.limit + 1), BigInt(options.offset)],
  );
  const hasMore = rows.length > options.limit;
  const sliced = hasMore ? rows.slice(0, options.limit) : rows;
  const tables = sliced.map((row) => ({
    project: row['project'] as string,
    datasetId: row['dataset_id'] as string,
    tableId: row['table_id'] as string,
    type: row['type'] as string,
    etag: row['etag'] as string,
    createdMs: toNumber(row['created_ms']),
    updatedMs: toNumber(row['updated_ms']),
    ...optionalJson<'schema', unknown>('schema', row['schema']),
    ...optional('description', row['description'] as string | null),
    ...optionalNumber('numRows', row['num_rows']),
    ...optionalNumber('expirationMs', row['expiration_ms']),
    ...optionalJson<'partitioning', unknown>('partitioning', row['partitioning']),
    ...optionalJson<'clustering', unknown>('clustering', row['clustering']),
  }));
  return { tables, nextOffset: hasMore ? options.offset + options.limit : null };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export type JobState = 'PENDING' | 'RUNNING' | 'DONE';

export interface JobMetaInput {
  readonly project: string;
  readonly jobId: string;
  readonly state: JobState;
  readonly statementType?: string;
  readonly error?: unknown;
  readonly query?: string;
  readonly params?: unknown;
  readonly types?: unknown;
  readonly startedMs?: number;
  readonly endedMs?: number;
  readonly resultSchema?: unknown;
  readonly resultTotalRows?: number;
}

export interface JobMeta extends JobMetaInput {
  readonly createdMs: number;
}

const SELECT_JOB = `SELECT
  project, job_id, state, statement_type, error, query, params, types,
  result_schema, result_total_rows,
  epoch_ms(created_at) AS created_ms,
  epoch_ms(started_at) AS started_ms,
  epoch_ms(ended_at) AS ended_ms
FROM _bq.jobs
WHERE project = $1 AND job_id = $2`;

export async function getJob(db: Db, project: string, jobId: string): Promise<JobMeta | null> {
  const rows = await db.query<Record<string, unknown>>(SELECT_JOB, [project, jobId]);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    project: row['project'] as string,
    jobId: row['job_id'] as string,
    state: row['state'] as JobState,
    createdMs: toNumber(row['created_ms']),
    ...optional('statementType', row['statement_type'] as string | null),
    ...optionalJson<'error', unknown>('error', row['error']),
    ...optional('query', row['query'] as string | null),
    ...optionalJson<'params', unknown>('params', row['params']),
    ...optionalJson<'types', unknown>('types', row['types']),
    ...optionalNumber('startedMs', row['started_ms']),
    ...optionalNumber('endedMs', row['ended_ms']),
    ...optionalJson<'resultSchema', unknown>('resultSchema', row['result_schema']),
    ...optionalNumber('resultTotalRows', row['result_total_rows']),
  };
}

export async function upsertJob(db: Db, input: JobMetaInput): Promise<JobMeta> {
  const existing = await getJob(db, input.project, input.jobId);
  const now = Date.now();
  const createdMs = existing?.createdMs ?? now;
  const startedAtParam = input.startedMs === undefined ? null : BigInt(input.startedMs);
  const endedAtParam = input.endedMs === undefined ? null : BigInt(input.endedMs);
  await db.exec(
    `INSERT INTO _bq.jobs (
      project, job_id, state, statement_type, error, query, params, types,
      created_at, started_at, ended_at, result_schema, result_total_rows
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      epoch_ms($9::BIGINT),
      CASE WHEN $10 IS NULL THEN NULL ELSE epoch_ms($10::BIGINT) END,
      CASE WHEN $11 IS NULL THEN NULL ELSE epoch_ms($11::BIGINT) END,
      $12, $13
    )
    ON CONFLICT (project, job_id) DO UPDATE SET
      state = EXCLUDED.state,
      statement_type = EXCLUDED.statement_type,
      error = EXCLUDED.error,
      query = EXCLUDED.query,
      params = EXCLUDED.params,
      types = EXCLUDED.types,
      started_at = EXCLUDED.started_at,
      ended_at = EXCLUDED.ended_at,
      result_schema = EXCLUDED.result_schema,
      result_total_rows = EXCLUDED.result_total_rows`,
    [
      input.project,
      input.jobId,
      input.state,
      input.statementType ?? null,
      jsonOrNull(input.error),
      input.query ?? null,
      jsonOrNull(input.params),
      jsonOrNull(input.types),
      BigInt(createdMs),
      startedAtParam,
      endedAtParam,
      jsonOrNull(input.resultSchema),
      bigintOrNull(input.resultTotalRows),
    ],
  );
  return {
    ...input,
    createdMs,
  };
}

/** Paginated list of jobs in a project, ordered by `created_at` DESC then `job_id`
 * (matching BigQuery, where newest jobs come first). Optional filters:
 *
 *   - `states`: include only these states (PENDING/RUNNING/DONE). Empty = all.
 *   - `minCreatedMs` / `maxCreatedMs`: inclusive bounds on creation time.
 *
 * Mirrors `listDatasets`/`listTables` — reads N+1 to detect "has more". */
export async function listJobs(
  db: Db,
  project: string,
  options: {
    readonly offset: number;
    readonly limit: number;
    readonly states?: readonly JobState[];
    readonly minCreatedMs?: number;
    readonly maxCreatedMs?: number;
  },
): Promise<{ readonly jobs: readonly JobMeta[]; readonly nextOffset: number | null }> {
  const where: string[] = ['project = $1'];
  const params: unknown[] = [project];
  let next = 2;
  if (options.states !== undefined && options.states.length > 0) {
    // DuckDB rejects a JS array bound as a parameter (it lands as ANY).
    // Same trick as the query engine: pass the array as JSON, cast to
    // VARCHAR[] in the SQL.
    where.push(`state = ANY ($${next}::JSON::VARCHAR[])`);
    params.push(JSON.stringify(options.states));
    next += 1;
  }
  if (options.minCreatedMs !== undefined) {
    where.push(`created_at >= epoch_ms($${next}::BIGINT)`);
    params.push(BigInt(options.minCreatedMs));
    next += 1;
  }
  if (options.maxCreatedMs !== undefined) {
    where.push(`created_at <= epoch_ms($${next}::BIGINT)`);
    params.push(BigInt(options.maxCreatedMs));
    next += 1;
  }
  const limitParam = `$${next}`;
  const offsetParam = `$${next + 1}`;
  params.push(BigInt(options.limit + 1));
  params.push(BigInt(options.offset));

  const sql = `SELECT
       project, job_id, state, statement_type, error, query, params, types,
       result_schema, result_total_rows,
       epoch_ms(created_at) AS created_ms,
       epoch_ms(started_at) AS started_ms,
       epoch_ms(ended_at) AS ended_ms
     FROM _bq.jobs
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, job_id
     LIMIT ${limitParam}::BIGINT OFFSET ${offsetParam}::BIGINT`;

  const rows = await db.query<Record<string, unknown>>(sql, params);
  const hasMore = rows.length > options.limit;
  const sliced = hasMore ? rows.slice(0, options.limit) : rows;
  const jobs = sliced.map((row) => ({
    project: row['project'] as string,
    jobId: row['job_id'] as string,
    state: row['state'] as JobState,
    createdMs: toNumber(row['created_ms']),
    ...optional('statementType', row['statement_type'] as string | null),
    ...optionalJson<'error', unknown>('error', row['error']),
    ...optional('query', row['query'] as string | null),
    ...optionalJson<'params', unknown>('params', row['params']),
    ...optionalJson<'types', unknown>('types', row['types']),
    ...optionalNumber('startedMs', row['started_ms']),
    ...optionalNumber('endedMs', row['ended_ms']),
    ...optionalJson<'resultSchema', unknown>('resultSchema', row['result_schema']),
    ...optionalNumber('resultTotalRows', row['result_total_rows']),
  }));
  return { jobs, nextOffset: hasMore ? options.offset + options.limit : null };
}

/** Cancel a job. If it's PENDING or RUNNING, transition it to DONE with an
 * `error` payload of `{ reason: 'stopped' }`. Already-DONE jobs are returned
 * as-is (matching real BigQuery, where cancelling a finished job is a no-op).
 * Returns null if the job doesn't exist. */
export async function cancelJob(db: Db, project: string, jobId: string): Promise<JobMeta | null> {
  const existing = await getJob(db, project, jobId);
  if (existing === null) return null;
  if (existing.state === 'DONE') return existing;
  const now = Date.now();
  const error = { reason: 'stopped', message: 'Job cancelled by request.' };
  await db.exec(
    `UPDATE _bq.jobs
        SET state = 'DONE',
            error = $1::JSON,
            ended_at = epoch_ms($2::BIGINT)
      WHERE project = $3 AND job_id = $4`,
    [JSON.stringify(error), BigInt(now), project, jobId],
  );
  return { ...existing, state: 'DONE', error, endedMs: now };
}

/** Remove a job record. Returns `true` if a row was deleted, `false` if the
 * job didn't exist. Also drops any persisted result rows (see job_rows). */
export async function deleteJob(db: Db, project: string, jobId: string): Promise<boolean> {
  const existing = await getJob(db, project, jobId);
  if (existing === null) return false;
  await db.exec('DELETE FROM _bq.job_rows WHERE project = $1 AND job_id = $2', [project, jobId]);
  await db.exec('DELETE FROM _bq.jobs WHERE project = $1 AND job_id = $2', [project, jobId]);
  return true;
}

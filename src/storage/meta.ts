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
import { type BqField, renderBqType } from './types.ts';
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
    view_query VARCHAR,
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
    dml_affected_rows BIGINT,
    PRIMARY KEY (project, job_id)
  )`,
  `CREATE TABLE IF NOT EXISTS _bq.job_rows (
    project VARCHAR NOT NULL,
    job_id VARCHAR NOT NULL,
    row_index BIGINT NOT NULL,
    row JSON NOT NULL,
    PRIMARY KEY (project, job_id, row_index)
  )`,
  `CREATE TABLE IF NOT EXISTS _bq.routines (
    project VARCHAR NOT NULL,
    dataset_id VARCHAR NOT NULL,
    routine_id VARCHAR NOT NULL,
    routine_type VARCHAR NOT NULL,
    language VARCHAR NOT NULL,
    arguments JSON,
    return_type JSON,
    body VARCHAR NOT NULL,
    etag VARCHAR NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    PRIMARY KEY (project, dataset_id, routine_id)
  )`,
  // BL-072 — models metadata. No training happens here; this is purely
  // a REST surface so clients listing or describing models against the
  // emulator get realistic shapes. feature_columns / label_columns are
  // opaque JSON arrays (BQ wire shape).
  `CREATE TABLE IF NOT EXISTS _bq.models (
    project VARCHAR NOT NULL,
    dataset_id VARCHAR NOT NULL,
    model_id VARCHAR NOT NULL,
    model_type VARCHAR NOT NULL,
    description VARCHAR,
    friendly_name VARCHAR,
    labels JSON,
    location VARCHAR,
    feature_columns JSON,
    label_columns JSON,
    etag VARCHAR NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    expires_at TIMESTAMP,
    PRIMARY KEY (project, dataset_id, model_id)
  )`,
  // Denormalized projections of _bq.tables' schema JSON, refreshed by
  // upsertTable / deleteTable. They keep INFORMATION_SCHEMA.COLUMNS &
  // COLUMN_FIELD_PATHS as plain SQL views — no JSON unnesting at query
  // time. The is_partitioning_column / clustering_ordinal_position values
  // are computed from _bq.tables.partitioning / .clustering when these
  // rows are written.
  `CREATE TABLE IF NOT EXISTS _bq.table_columns (
    project VARCHAR NOT NULL,
    dataset_id VARCHAR NOT NULL,
    table_id VARCHAR NOT NULL,
    column_name VARCHAR NOT NULL,
    ordinal_position BIGINT NOT NULL,
    is_nullable VARCHAR NOT NULL,
    data_type VARCHAR NOT NULL,
    is_partitioning_column VARCHAR NOT NULL,
    clustering_ordinal_position BIGINT,
    description VARCHAR,
    PRIMARY KEY (project, dataset_id, table_id, column_name)
  )`,
  `CREATE TABLE IF NOT EXISTS _bq.table_field_paths (
    project VARCHAR NOT NULL,
    dataset_id VARCHAR NOT NULL,
    table_id VARCHAR NOT NULL,
    column_name VARCHAR NOT NULL,
    field_path VARCHAR NOT NULL,
    data_type VARCHAR NOT NULL,
    description VARCHAR,
    PRIMARY KEY (project, dataset_id, table_id, column_name, field_path)
  )`,
  // INFORMATION_SCHEMA views — read-only projections over the metadata
  // tables. The query translator rewrites
  //   `region-us`.INFORMATION_SCHEMA.TABLES
  //   <dataset>.INFORMATION_SCHEMA.TABLES
  // into SELECTs against these views (with table_catalog / table_schema
  // filters applied as a WHERE).
  `CREATE OR REPLACE VIEW _bq.info_tables AS
   SELECT
     project AS table_catalog,
     dataset_id AS table_schema,
     table_id AS table_name,
     CASE type
       WHEN 'TABLE' THEN 'BASE TABLE'
       WHEN 'VIEW' THEN 'VIEW'
       WHEN 'MATERIALIZED_VIEW' THEN 'MATERIALIZED VIEW'
       WHEN 'EXTERNAL' THEN 'EXTERNAL'
       WHEN 'SNAPSHOT' THEN 'SNAPSHOT'
       ELSE type
     END AS table_type,
     CASE WHEN type = 'TABLE' THEN 'YES' ELSE 'NO' END AS is_insertable_into,
     'NO' AS is_typed,
     created_at AS creation_time,
     CAST(NULL AS VARCHAR) AS base_table_catalog,
     CAST(NULL AS VARCHAR) AS base_table_schema,
     CAST(NULL AS VARCHAR) AS base_table_name,
     CAST(NULL AS BIGINT) AS snapshot_time_ms,
     view_query AS ddl,
     CAST(NULL AS VARCHAR) AS default_collation_name,
     CAST(NULL AS TIMESTAMP) AS upsert_stream_apply_watermark
   FROM _bq.tables`,
  `CREATE OR REPLACE VIEW _bq.info_columns AS
   SELECT
     c.project AS table_catalog,
     c.dataset_id AS table_schema,
     c.table_id AS table_name,
     c.column_name,
     c.ordinal_position,
     c.is_nullable,
     c.data_type,
     'NEVER' AS is_generated,
     CAST(NULL AS VARCHAR) AS generation_expression,
     'NEVER' AS is_stored,
     'NO' AS is_hidden,
     CASE WHEN t.type = 'VIEW' THEN 'NO' ELSE 'YES' END AS is_updatable,
     'NO' AS is_system_defined,
     c.is_partitioning_column,
     c.clustering_ordinal_position,
     CAST(NULL AS VARCHAR) AS collation_name,
     CAST(NULL AS VARCHAR) AS column_default,
     CAST(NULL AS VARCHAR) AS rounding_mode
   FROM _bq.table_columns c
   JOIN _bq.tables t
     ON t.project = c.project
    AND t.dataset_id = c.dataset_id
    AND t.table_id = c.table_id`,
  `CREATE OR REPLACE VIEW _bq.info_column_field_paths AS
   SELECT
     project AS table_catalog,
     dataset_id AS table_schema,
     table_id AS table_name,
     column_name,
     field_path,
     data_type,
     description,
     CAST(NULL AS VARCHAR) AS collation_name,
     CAST(NULL AS VARCHAR) AS rounding_mode
   FROM _bq.table_field_paths`,
  // TABLE_OPTIONS exposes per-table options as (option_name, option_type,
  // option_value) rows. We populate the ones we currently store on
  // _bq.tables (description, expiration_timestamp). Labels become
  // available when BL-154 lands; the view will pick them up automatically
  // once the column exists in _bq.tables.
  // INFORMATION_SCHEMA.VIEWS — one row per `type = 'VIEW'` table, exposing
  // the SQL body in `view_definition`. `check_option` is always NULL in BQ
  // (no WITH CHECK OPTION clause exists); `use_standard_sql` is always
  // 'YES' since legacy SQL is deprecated and we don't accept it.
  `CREATE OR REPLACE VIEW _bq.info_views AS
   SELECT
     project AS table_catalog,
     dataset_id AS table_schema,
     table_id AS table_name,
     view_query AS view_definition,
     CAST(NULL AS VARCHAR) AS check_option,
     'YES' AS use_standard_sql
   FROM _bq.tables
   WHERE type = 'VIEW'`,
  // INFORMATION_SCHEMA.MATERIALIZED_VIEWS — populated once BL-101 stores
  // MVs with `type = 'MATERIALIZED_VIEW'`. The view is wired now so
  // clients querying it today get a clean empty result instead of an
  // unsupportedFeature error (matches real BQ behavior for projects with
  // no MVs).
  `CREATE OR REPLACE VIEW _bq.info_materialized_views AS
   SELECT
     project AS table_catalog,
     dataset_id AS table_schema,
     table_id AS table_name,
     view_query AS view_definition,
     updated_at AS last_refresh_time,
     CAST(NULL AS TIMESTAMP) AS refresh_watermark
   FROM _bq.tables
   WHERE type = 'MATERIALIZED_VIEW'`,
  // INFORMATION_SCHEMA.ROUTINES — one row per persistent routine (SQL
  // UDFs, TVFs, procedures). BQ collapses both function flavors to
  // `routine_type = 'FUNCTION'`; only `PROCEDURE` stands alone. `data_type`
  // is the return-type kind for FUNCTION rows, NULL for PROCEDURE and
  // table-valued functions. `routine_body` distinguishes SQL ('SQL') from
  // external-language bodies ('EXTERNAL', currently unused — lands when
  // BL-070 JS UDFs do).
  `CREATE OR REPLACE VIEW _bq.info_routines AS
   SELECT
     project AS specific_catalog,
     dataset_id AS specific_schema,
     routine_id AS specific_name,
     project AS routine_catalog,
     dataset_id AS routine_schema,
     routine_id AS routine_name,
     CASE routine_type WHEN 'PROCEDURE' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS routine_type,
     CASE
       WHEN routine_type = 'SCALAR_FUNCTION' THEN json_extract_string(return_type, '$.typeKind')
       ELSE NULL
     END AS data_type,
     CASE language WHEN 'SQL' THEN 'SQL' ELSE 'EXTERNAL' END AS routine_body,
     body AS routine_definition,
     CASE language WHEN 'SQL' THEN NULL ELSE language END AS external_language,
     'YES' AS is_deterministic,
     CAST(NULL AS VARCHAR) AS security_type,
     created_at AS created,
     updated_at AS last_altered,
     body AS ddl
   FROM _bq.routines`,
  // INFORMATION_SCHEMA.PARAMETERS — unnests the routine `arguments` JSON
  // into one row per parameter. Argument shape (set by queryEngine when
  // it persists a routine): `[{ name, mode?, dataType: { typeKind } }]`.
  // Procedures may carry mode = IN / OUT / INOUT; functions default to IN.
  `CREATE OR REPLACE VIEW _bq.info_parameters AS
   SELECT
     r.project AS specific_catalog,
     r.dataset_id AS specific_schema,
     r.routine_id AS specific_name,
     CAST(a.key AS BIGINT) + 1 AS ordinal_position,
     COALESCE(json_extract_string(a.value, '$.mode'), 'IN') AS parameter_mode,
     'NO' AS is_result,
     json_extract_string(a.value, '$.name') AS parameter_name,
     json_extract_string(a.value, '$.dataType.typeKind') AS data_type
   FROM _bq.routines r,
        json_each(r.arguments) a
   WHERE r.arguments IS NOT NULL`,
  // INFORMATION_SCHEMA.ROUTINE_OPTIONS — we don't currently persist any
  // options on routines, so the view returns no rows. Wired so clients
  // get an empty result rather than an unsupportedFeature error.
  `CREATE OR REPLACE VIEW _bq.info_routine_options AS
   SELECT
     project AS specific_catalog,
     dataset_id AS specific_schema,
     routine_id AS specific_name,
     CAST(NULL AS VARCHAR) AS option_name,
     CAST(NULL AS VARCHAR) AS option_type,
     CAST(NULL AS VARCHAR) AS option_value
   FROM _bq.routines
   WHERE FALSE`,
  // INFORMATION_SCHEMA.JOBS — base shape over _bq.jobs. BQ scopes this
  // by visibility (your jobs vs. all in project vs. all in org); we
  // don't track user identity, so JOBS / JOBS_BY_USER / JOBS_BY_PROJECT /
  // JOBS_BY_ORGANIZATION all return the same rows. Columns we don't yet
  // populate (slot ms, bytes processed, labels, cache_hit) are NULL —
  // schema parity is what matters for dbt + BI tools introspecting.
  `CREATE OR REPLACE VIEW _bq.info_jobs AS
   SELECT
     created_at AS creation_time,
     project AS project_id,
     CAST(NULL AS BIGINT) AS project_number,
     CAST(NULL AS VARCHAR) AS user_email,
     job_id,
     'QUERY' AS job_type,
     statement_type,
     'INTERACTIVE' AS priority,
     started_at AS start_time,
     ended_at AS end_time,
     query,
     state,
     CAST(NULL AS VARCHAR) AS reservation_id,
     CAST(NULL AS BIGINT) AS total_bytes_processed,
     CAST(NULL AS BIGINT) AS total_slot_ms,
     error AS error_result,
     CAST(NULL AS BOOLEAN) AS cache_hit,
     CAST(NULL AS VARCHAR) AS destination_table,
     CAST(NULL AS VARCHAR) AS referenced_tables,
     CAST(NULL AS VARCHAR) AS labels,
     CAST(NULL AS VARCHAR) AS parent_job_id,
     dml_affected_rows AS total_modified_partitions
   FROM _bq.jobs`,
  `CREATE OR REPLACE VIEW _bq.info_jobs_by_user AS SELECT * FROM _bq.info_jobs`,
  `CREATE OR REPLACE VIEW _bq.info_jobs_by_project AS SELECT * FROM _bq.info_jobs`,
  `CREATE OR REPLACE VIEW _bq.info_jobs_by_organization AS SELECT * FROM _bq.info_jobs`,
  // INFORMATION_SCHEMA.JOBS_TIMELINE_* — one row per (job, 1-minute
  // bucket from job start). period_slot_ms is 0 since we don't track
  // slot consumption — backlog acceptance only asks for "plausible
  // numbers". elapsed_ms is real (job end − start).
  `CREATE OR REPLACE VIEW _bq.info_jobs_timeline AS
   SELECT
     date_trunc('minute', created_at) AS period_start,
     project AS project_id,
     CAST(NULL AS BIGINT) AS project_number,
     CAST(NULL AS VARCHAR) AS user_email,
     job_id,
     'QUERY' AS job_type,
     statement_type,
     state,
     CAST(epoch_ms(COALESCE(ended_at, started_at, created_at)) - epoch_ms(created_at) AS BIGINT)
       AS elapsed_ms,
     0::BIGINT AS period_slot_ms,
     CAST(NULL AS BIGINT) AS period_shuffle_ram_usage_ratio,
     CAST(NULL AS BIGINT) AS period_estimated_runnable_units
   FROM _bq.jobs`,
  `CREATE OR REPLACE VIEW _bq.info_jobs_timeline_by_user AS SELECT * FROM _bq.info_jobs_timeline`,
  `CREATE OR REPLACE VIEW _bq.info_jobs_timeline_by_project AS SELECT * FROM _bq.info_jobs_timeline`,
  `CREATE OR REPLACE VIEW _bq.info_jobs_timeline_by_organization AS SELECT * FROM _bq.info_jobs_timeline`,
  // INFORMATION_SCHEMA.SCHEMATA — datasets visible at the project level.
  // catalog_name = project, schema_name = dataset.
  `CREATE OR REPLACE VIEW _bq.info_schemata AS
   SELECT
     project AS catalog_name,
     dataset_id AS schema_name,
     COALESCE(location, 'US') AS location,
     created_at AS creation_time,
     updated_at AS last_modified_time,
     CAST(NULL AS VARCHAR) AS ddl,
     CAST(NULL AS VARCHAR) AS default_collation_name
   FROM _bq.datasets`,
  // INFORMATION_SCHEMA.SCHEMATA_OPTIONS — dataset options as
  // (option_name, option_type, option_value) rows. We expose what we
  // store today: description (when set) and default_table_expiration_days
  // (when default_table_expiration_ms is set; BQ surface uses days as
  // FLOAT64).
  `CREATE OR REPLACE VIEW _bq.info_schemata_options AS
   SELECT project AS catalog_name, dataset_id AS schema_name,
          'description' AS option_name, 'STRING' AS option_type,
          '"' || replace(description, '"', '\\"') || '"' AS option_value
     FROM _bq.datasets
    WHERE description IS NOT NULL
   UNION ALL
   SELECT project AS catalog_name, dataset_id AS schema_name,
          'default_table_expiration_days' AS option_name, 'FLOAT64' AS option_type,
          CAST(CAST(default_table_expiration_ms AS DOUBLE) / 86400000 AS VARCHAR) AS option_value
     FROM _bq.datasets
    WHERE default_table_expiration_ms IS NOT NULL`,
  `CREATE OR REPLACE VIEW _bq.info_table_options AS
   SELECT project AS table_catalog, dataset_id AS table_schema, table_id AS table_name,
          'description' AS option_name, 'STRING' AS option_type,
          '"' || replace(description, '"', '\\"') || '"' AS option_value
     FROM _bq.tables
    WHERE description IS NOT NULL
   UNION ALL
   SELECT project AS table_catalog, dataset_id AS table_schema, table_id AS table_name,
          'expiration_timestamp' AS option_name, 'TIMESTAMP' AS option_type,
          'TIMESTAMP "' || strftime(expires_at, '%Y-%m-%d %H:%M:%S+00') || '"' AS option_value
     FROM _bq.tables
    WHERE expires_at IS NOT NULL`,
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
): Promise<{
  readonly datasets: readonly DatasetMeta[];
  readonly nextOffset: number | null;
}> {
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
  return {
    datasets,
    nextOffset: hasMore ? options.offset + options.limit : null,
  };
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
  /** Raw view body when `type === 'VIEW'`. */
  readonly viewQuery?: string;
}

export interface TableMeta extends TableMetaInput {
  readonly etag: string;
  readonly createdMs: number;
  readonly updatedMs: number;
}

const SELECT_TABLE = `SELECT
  project, dataset_id, table_id, type, etag, "schema", description,
  num_rows, partitioning, clustering, view_query,
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
    ...optional('viewQuery', row['view_query'] as string | null),
  };
}

/** Top-level row for `_bq.table_columns`. */
interface ColumnRow {
  readonly columnName: string;
  readonly ordinalPosition: number;
  readonly isNullable: 'YES' | 'NO';
  readonly dataType: string;
  readonly isPartitioningColumn: 'YES' | 'NO';
  readonly clusteringOrdinalPosition: number | null;
  readonly description: string | null;
}

/** Row for `_bq.table_field_paths` — one per top-level column and one
 * per nested STRUCT path within it. */
interface FieldPathRow {
  readonly columnName: string;
  readonly fieldPath: string;
  readonly dataType: string;
  readonly description: string | null;
}

/** Flatten a stored table schema into the rows that back the
 * `_bq.table_columns` and `_bq.table_field_paths` projections. The shape
 * mirrors what `INFORMATION_SCHEMA.COLUMNS` and `COLUMN_FIELD_PATHS`
 * expose, with `is_partitioning_column` / `clustering_ordinal_position`
 * derived from the table's partitioning + clustering JSON. */
function flattenSchemaForInfo(
  schema: unknown,
  partitioning: unknown,
  clustering: unknown,
): { columns: ColumnRow[]; fieldPaths: FieldPathRow[] } {
  const fields = (schema as { fields?: readonly BqField[] } | undefined)?.fields ?? [];
  const partitionField = readPartitionField(partitioning);
  const clusterFields = readClusterFields(clustering);
  const columns: ColumnRow[] = [];
  const fieldPaths: FieldPathRow[] = [];
  fields.forEach((field, idx) => {
    const dataType = renderBqType(field);
    columns.push({
      columnName: field.name,
      ordinalPosition: idx + 1,
      isNullable: field.mode === 'REQUIRED' ? 'NO' : 'YES',
      dataType,
      isPartitioningColumn: partitionField === field.name ? 'YES' : 'NO',
      clusteringOrdinalPosition: clusterFieldOrdinal(clusterFields, field.name),
      description: field.description ?? null,
    });
    collectFieldPaths(field, field.name, columns[columns.length - 1] as ColumnRow, fieldPaths);
  });
  return { columns, fieldPaths };
}

function readPartitionField(partitioning: unknown): string | null {
  const p = partitioning as { field?: string } | undefined;
  return p?.field ?? null;
}

function readClusterFields(clustering: unknown): readonly string[] {
  const c = clustering as { fields?: readonly string[] } | undefined;
  return c?.fields ?? [];
}

function clusterFieldOrdinal(clusterFields: readonly string[], name: string): number | null {
  const idx = clusterFields.indexOf(name);
  return idx === -1 ? null : idx + 1;
}

function collectFieldPaths(
  field: BqField,
  currentPath: string,
  column: ColumnRow,
  out: FieldPathRow[],
): void {
  out.push({
    columnName: column.columnName,
    fieldPath: currentPath,
    dataType: renderBqType(field),
    description: field.description ?? null,
  });
  if (field.type !== 'STRUCT' || field.fields === undefined) return;
  for (const child of field.fields) {
    collectFieldPaths(child, `${currentPath}.${child.name}`, column, out);
  }
}

async function refreshTableInfoProjections(db: Db, input: TableMetaInput): Promise<void> {
  await db.exec(
    `DELETE FROM _bq.table_columns WHERE project = $1 AND dataset_id = $2 AND table_id = $3`,
    [input.project, input.datasetId, input.tableId],
  );
  await db.exec(
    `DELETE FROM _bq.table_field_paths WHERE project = $1 AND dataset_id = $2 AND table_id = $3`,
    [input.project, input.datasetId, input.tableId],
  );
  const { columns, fieldPaths } = flattenSchemaForInfo(
    input.schema,
    input.partitioning,
    input.clustering,
  );
  for (const col of columns) {
    await db.exec(
      `INSERT INTO _bq.table_columns (
        project, dataset_id, table_id, column_name, ordinal_position,
        is_nullable, data_type, is_partitioning_column,
        clustering_ordinal_position, description
      ) VALUES ($1, $2, $3, $4, $5::BIGINT, $6, $7, $8, $9, $10)`,
      [
        input.project,
        input.datasetId,
        input.tableId,
        col.columnName,
        BigInt(col.ordinalPosition),
        col.isNullable,
        col.dataType,
        col.isPartitioningColumn,
        col.clusteringOrdinalPosition === null ? null : BigInt(col.clusteringOrdinalPosition),
        col.description,
      ],
    );
  }
  for (const fp of fieldPaths) {
    await db.exec(
      `INSERT INTO _bq.table_field_paths (
        project, dataset_id, table_id, column_name, field_path, data_type, description
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.project,
        input.datasetId,
        input.tableId,
        fp.columnName,
        fp.fieldPath,
        fp.dataType,
        fp.description,
      ],
    );
  }
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
      num_rows, created_at, updated_at, expires_at, partitioning, clustering,
      view_query
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, epoch_ms($9::BIGINT), epoch_ms($10::BIGINT),
      CASE WHEN $11 IS NULL THEN NULL ELSE epoch_ms($11::BIGINT) END,
      $12, $13, $14
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
      clustering = EXCLUDED.clustering,
      view_query = EXCLUDED.view_query`,
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
      input.viewQuery ?? null,
    ],
  );
  await refreshTableInfoProjections(db, input);
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
  await db.exec(
    `DELETE FROM _bq.table_columns
     WHERE project = $1 AND dataset_id = $2 AND table_id = $3`,
    [project, datasetId, tableId],
  );
  await db.exec(
    `DELETE FROM _bq.table_field_paths
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
): Promise<{
  readonly tables: readonly TableMeta[];
  readonly nextOffset: number | null;
}> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT
       project, dataset_id, table_id, type, etag, "schema", description,
       num_rows, partitioning, clustering, view_query,
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
    ...optional('viewQuery', row['view_query'] as string | null),
  }));
  return {
    tables,
    nextOffset: hasMore ? options.offset + options.limit : null,
  };
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
  readonly dmlAffectedRows?: number;
}

export interface JobMeta extends JobMetaInput {
  readonly createdMs: number;
}

const SELECT_JOB = `SELECT
  project, job_id, state, statement_type, error, query, params, types,
  result_schema, result_total_rows, dml_affected_rows,
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
    ...optionalNumber('dmlAffectedRows', row['dml_affected_rows']),
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
      created_at, started_at, ended_at, result_schema, result_total_rows,
      dml_affected_rows
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      epoch_ms($9::BIGINT),
      CASE WHEN $10 IS NULL THEN NULL ELSE epoch_ms($10::BIGINT) END,
      CASE WHEN $11 IS NULL THEN NULL ELSE epoch_ms($11::BIGINT) END,
      $12, $13, $14
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
      result_total_rows = EXCLUDED.result_total_rows,
      dml_affected_rows = EXCLUDED.dml_affected_rows`,
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
      bigintOrNull(input.dmlAffectedRows),
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
): Promise<{
  readonly jobs: readonly JobMeta[];
  readonly nextOffset: number | null;
}> {
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
       result_schema, result_total_rows, dml_affected_rows,
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
    ...optionalNumber('dmlAffectedRows', row['dml_affected_rows']),
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

// ---------------------------------------------------------------------------
// Routines (UDFs, TVFs, procedures)
// ---------------------------------------------------------------------------

export type RoutineType = 'SCALAR_FUNCTION' | 'TABLE_VALUED_FUNCTION' | 'PROCEDURE';
export type RoutineLanguage = 'SQL' | 'JAVASCRIPT';

export interface RoutineMetaInput {
  readonly project: string;
  readonly datasetId: string;
  readonly routineId: string;
  readonly routineType: RoutineType;
  readonly language: RoutineLanguage;
  /** [{ name, type }] mirroring BQ's `arguments` array. */
  readonly arguments?: unknown;
  /** BQ `returnType` object — { type, ... } — or null for TVFs / procedures. */
  readonly returnType?: unknown;
  /** Raw body text as written by the user. */
  readonly body: string;
}

export interface RoutineMeta extends RoutineMetaInput {
  readonly etag: string;
  readonly createdMs: number;
  readonly updatedMs: number;
}

const SELECT_ROUTINE = `SELECT
  project, dataset_id, routine_id, routine_type, language, arguments, return_type, body, etag,
  epoch_ms(created_at) AS created_ms,
  epoch_ms(updated_at) AS updated_ms
FROM _bq.routines
WHERE project = $1 AND dataset_id = $2 AND routine_id = $3`;

export async function getRoutine(
  db: Db,
  project: string,
  datasetId: string,
  routineId: string,
): Promise<RoutineMeta | null> {
  const rows = await db.query<Record<string, unknown>>(SELECT_ROUTINE, [
    project,
    datasetId,
    routineId,
  ]);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    project: row['project'] as string,
    datasetId: row['dataset_id'] as string,
    routineId: row['routine_id'] as string,
    routineType: row['routine_type'] as RoutineType,
    language: row['language'] as RoutineLanguage,
    body: row['body'] as string,
    etag: row['etag'] as string,
    createdMs: toNumber(row['created_ms']),
    updatedMs: toNumber(row['updated_ms']),
    ...optionalJson<'arguments', unknown>('arguments', row['arguments']),
    ...optionalJson<'returnType', unknown>('returnType', row['return_type']),
  };
}

export async function upsertRoutine(db: Db, input: RoutineMetaInput): Promise<RoutineMeta> {
  const existing = await getRoutine(db, input.project, input.datasetId, input.routineId);
  const newEtag = etag(input);
  const now = Date.now();
  const createdMs = existing?.createdMs ?? now;
  await db.exec(
    `INSERT INTO _bq.routines (
      project, dataset_id, routine_id, routine_type, language,
      arguments, return_type, body, etag, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9,
      epoch_ms($10::BIGINT), epoch_ms($11::BIGINT)
    )
    ON CONFLICT (project, dataset_id, routine_id) DO UPDATE SET
      routine_type = EXCLUDED.routine_type,
      language = EXCLUDED.language,
      arguments = EXCLUDED.arguments,
      return_type = EXCLUDED.return_type,
      body = EXCLUDED.body,
      etag = EXCLUDED.etag,
      updated_at = EXCLUDED.updated_at`,
    [
      input.project,
      input.datasetId,
      input.routineId,
      input.routineType,
      input.language,
      jsonOrNull(input.arguments),
      jsonOrNull(input.returnType),
      input.body,
      newEtag,
      BigInt(createdMs),
      BigInt(now),
    ],
  );
  return { ...input, etag: newEtag, createdMs, updatedMs: now };
}

export async function deleteRoutine(
  db: Db,
  project: string,
  datasetId: string,
  routineId: string,
): Promise<boolean> {
  const existing = await getRoutine(db, project, datasetId, routineId);
  if (existing === null) return false;
  await db.exec(
    `DELETE FROM _bq.routines
     WHERE project = $1 AND dataset_id = $2 AND routine_id = $3`,
    [project, datasetId, routineId],
  );
  return true;
}

/** Paginated list of routines in a dataset, ordered by `routine_id`.
 * Reads N+1 to detect "has more". */
export async function listRoutines(
  db: Db,
  project: string,
  datasetId: string,
  options: { readonly offset: number; readonly limit: number },
): Promise<{
  readonly routines: readonly RoutineMeta[];
  readonly nextOffset: number | null;
}> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT project, dataset_id, routine_id, routine_type, language,
            arguments, return_type, body, etag,
            epoch_ms(created_at) AS created_ms,
            epoch_ms(updated_at) AS updated_ms
       FROM _bq.routines
      WHERE project = $1 AND dataset_id = $2
      ORDER BY routine_id
      LIMIT $3::BIGINT OFFSET $4::BIGINT`,
    [project, datasetId, BigInt(options.limit + 1), BigInt(options.offset)],
  );
  const hasMore = rows.length > options.limit;
  const sliced = hasMore ? rows.slice(0, options.limit) : rows;
  const routines: RoutineMeta[] = sliced.map((row) => ({
    project: row['project'] as string,
    datasetId: row['dataset_id'] as string,
    routineId: row['routine_id'] as string,
    routineType: row['routine_type'] as RoutineType,
    language: row['language'] as RoutineLanguage,
    body: row['body'] as string,
    etag: row['etag'] as string,
    createdMs: toNumber(row['created_ms']),
    updatedMs: toNumber(row['updated_ms']),
    ...optionalJson<'arguments', unknown>('arguments', row['arguments']),
    ...optionalJson<'returnType', unknown>('returnType', row['return_type']),
  }));
  return { routines, nextOffset: hasMore ? options.offset + options.limit : null };
}

// ---------------------------------------------------------------------------
// Models (BL-072 — metadata only, no training)
// ---------------------------------------------------------------------------

export interface ModelMetaInput {
  readonly project: string;
  readonly datasetId: string;
  readonly modelId: string;
  /** BQML model kind — 'LINEAR_REGRESSION', 'LOGISTIC_REGRESSION', etc.
   * We don't validate the kind in v0; the wire format passes it through. */
  readonly modelType: string;
  readonly description?: string;
  readonly friendlyName?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly expirationMs?: number;
  /** Feature columns — BQ wire shape, kept as opaque JSON. */
  readonly featureColumns?: unknown;
  /** Label columns — BQ wire shape, kept as opaque JSON. */
  readonly labelColumns?: unknown;
  readonly location?: string;
}

export interface ModelMeta extends ModelMetaInput {
  readonly etag: string;
  readonly createdMs: number;
  readonly updatedMs: number;
}

const SELECT_MODEL = `SELECT
  project, dataset_id, model_id, model_type, description, friendly_name,
  labels, location, feature_columns, label_columns, etag,
  epoch_ms(created_at) AS created_ms,
  epoch_ms(updated_at) AS updated_ms,
  epoch_ms(expires_at) AS expiration_ms
FROM _bq.models
WHERE project = $1 AND dataset_id = $2 AND model_id = $3`;

export async function getModel(
  db: Db,
  project: string,
  datasetId: string,
  modelId: string,
): Promise<ModelMeta | null> {
  const rows = await db.query<Record<string, unknown>>(SELECT_MODEL, [project, datasetId, modelId]);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    project: row['project'] as string,
    datasetId: row['dataset_id'] as string,
    modelId: row['model_id'] as string,
    modelType: row['model_type'] as string,
    etag: row['etag'] as string,
    createdMs: toNumber(row['created_ms']),
    updatedMs: toNumber(row['updated_ms']),
    ...optional('description', row['description'] as string | null),
    ...optional('friendlyName', row['friendly_name'] as string | null),
    ...optionalJson<'labels', Readonly<Record<string, string>>>('labels', row['labels']),
    ...optional('location', row['location'] as string | null),
    ...optionalJson<'featureColumns', unknown>('featureColumns', row['feature_columns']),
    ...optionalJson<'labelColumns', unknown>('labelColumns', row['label_columns']),
    ...optionalNumber('expirationMs', row['expiration_ms']),
  };
}

export async function upsertModel(
  db: Db,
  input: ModelMetaInput,
  ifMatch?: string,
): Promise<ModelMeta> {
  const existing = await getModel(db, input.project, input.datasetId, input.modelId);
  if (existing !== null) {
    checkIfMatch(existing.etag, ifMatch);
  } else if (ifMatch !== undefined) {
    throw BqError.notFound(
      `Model "${input.project}:${input.datasetId}.${input.modelId}" not found.`,
    );
  }
  const newEtag = etag(input);
  const now = Date.now();
  const createdMs = existing?.createdMs ?? now;
  const expiresAtParam = input.expirationMs === undefined ? null : BigInt(input.expirationMs);
  await db.exec(
    `INSERT INTO _bq.models (
      project, dataset_id, model_id, model_type, description, friendly_name,
      labels, location, feature_columns, label_columns, etag,
      created_at, updated_at, expires_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
      epoch_ms($12::BIGINT), epoch_ms($13::BIGINT),
      CASE WHEN $14 IS NULL THEN NULL ELSE epoch_ms($14::BIGINT) END
    )
    ON CONFLICT (project, dataset_id, model_id) DO UPDATE SET
      model_type = EXCLUDED.model_type,
      description = EXCLUDED.description,
      friendly_name = EXCLUDED.friendly_name,
      labels = EXCLUDED.labels,
      location = EXCLUDED.location,
      feature_columns = EXCLUDED.feature_columns,
      label_columns = EXCLUDED.label_columns,
      etag = EXCLUDED.etag,
      updated_at = EXCLUDED.updated_at,
      expires_at = EXCLUDED.expires_at`,
    [
      input.project,
      input.datasetId,
      input.modelId,
      input.modelType,
      input.description ?? null,
      input.friendlyName ?? null,
      jsonOrNull(input.labels),
      input.location ?? null,
      jsonOrNull(input.featureColumns),
      jsonOrNull(input.labelColumns),
      newEtag,
      BigInt(createdMs),
      BigInt(now),
      expiresAtParam,
    ],
  );
  return { ...input, etag: newEtag, createdMs, updatedMs: now };
}

export async function deleteModel(
  db: Db,
  project: string,
  datasetId: string,
  modelId: string,
  ifMatch?: string,
): Promise<boolean> {
  const existing = await getModel(db, project, datasetId, modelId);
  if (existing === null) return false;
  checkIfMatch(existing.etag, ifMatch);
  await db.exec(
    `DELETE FROM _bq.models
     WHERE project = $1 AND dataset_id = $2 AND model_id = $3`,
    [project, datasetId, modelId],
  );
  return true;
}

export async function listModels(
  db: Db,
  project: string,
  datasetId: string,
  options: { readonly offset: number; readonly limit: number },
): Promise<{
  readonly models: readonly ModelMeta[];
  readonly nextOffset: number | null;
}> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT project, dataset_id, model_id, model_type, description, friendly_name,
            labels, location, feature_columns, label_columns, etag,
            epoch_ms(created_at) AS created_ms,
            epoch_ms(updated_at) AS updated_ms,
            epoch_ms(expires_at) AS expiration_ms
       FROM _bq.models
      WHERE project = $1 AND dataset_id = $2
      ORDER BY model_id
      LIMIT $3::BIGINT OFFSET $4::BIGINT`,
    [project, datasetId, BigInt(options.limit + 1), BigInt(options.offset)],
  );
  const hasMore = rows.length > options.limit;
  const sliced = hasMore ? rows.slice(0, options.limit) : rows;
  const models: ModelMeta[] = sliced.map((row) => ({
    project: row['project'] as string,
    datasetId: row['dataset_id'] as string,
    modelId: row['model_id'] as string,
    modelType: row['model_type'] as string,
    etag: row['etag'] as string,
    createdMs: toNumber(row['created_ms']),
    updatedMs: toNumber(row['updated_ms']),
    ...optional('description', row['description'] as string | null),
    ...optional('friendlyName', row['friendly_name'] as string | null),
    ...optionalJson<'labels', Readonly<Record<string, string>>>('labels', row['labels']),
    ...optional('location', row['location'] as string | null),
    ...optionalJson<'featureColumns', unknown>('featureColumns', row['feature_columns']),
    ...optionalJson<'labelColumns', unknown>('labelColumns', row['label_columns']),
    ...optionalNumber('expirationMs', row['expiration_ms']),
  }));
  return { models, nextOffset: hasMore ? options.offset + options.limit : null };
}

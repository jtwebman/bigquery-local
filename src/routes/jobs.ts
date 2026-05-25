/**
 * `jobs` endpoints + getQueryResults.
 *
 *   POST /projects/{p}/jobs            — submit a job (v0: query only)
 *   GET  /projects/{p}/jobs/{j}        — fetch a persisted job
 *   GET  /projects/{p}/queries/{j}     — paginate result rows of a job
 *
 * v0 only accepts `configuration.query`. `configuration.load`,
 * `configuration.copy`, `configuration.extract` are rejected with
 * `unsupportedFeature`. The query execution path reuses
 * `executeQuery` from `src/sql/queryEngine.ts`, which is the same
 * pipeline `POST /queries` uses.
 */

import { randomUUID } from 'node:crypto';

import { type CopyJobConfig, runCopyJob } from '../load/copy.ts';
import { type ExtractJobConfig, runExtractJob } from '../load/extract.ts';
import { type LoadJobConfig, runLoadJob } from '../load/load.ts';
import type { Db } from '../storage/db.ts';
import { cancelJob, deleteJob, getJob, listJobs, upsertJob } from '../storage/meta.ts';
import type { JobMeta, JobState } from '../storage/meta.ts';
import {
  type FieldWire,
  type QueryParameterParsed,
  type RowWire,
  executeQuery,
  executeQueryDryRun,
  fieldToWire,
  parseQueryParameters,
} from '../sql/queryEngine.ts';
import type { BqField, BqMode } from '../storage/types.ts';
import { normalizeBqType } from '../storage/types.ts';
import type { RouteDefinition, RouteResponse } from '../types.ts';
import { BqError } from '../util/errors.ts';

// ---------------------------------------------------------------------------
// Wire format — Job resource (bigquery#job)
// ---------------------------------------------------------------------------

interface JobReferenceWire {
  readonly projectId: string;
  readonly jobId: string;
  readonly location: string;
}

interface JobStatusWire {
  readonly state: 'PENDING' | 'RUNNING' | 'DONE';
  readonly errorResult?: { readonly reason: string; readonly message: string };
}

interface JobStatisticsWire {
  readonly creationTime: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly totalBytesProcessed: string;
  readonly numDmlAffectedRows?: string;
  readonly query?: {
    readonly statementType: string;
    readonly totalSlotMs: string;
    readonly schema?: { readonly fields: readonly FieldWire[] };
    readonly cacheHit?: boolean;
    readonly dmlStats?: {
      readonly insertedRowCount?: string;
      readonly updatedRowCount?: string;
      readonly deletedRowCount?: string;
    };
  };
}

interface JobResourceWire {
  readonly kind: 'bigquery#job';
  readonly id: string;
  readonly jobReference: JobReferenceWire;
  readonly configuration: {
    readonly query: { readonly query: string };
    readonly labels?: Readonly<Record<string, string>>;
  };
  readonly status: JobStatusWire;
  readonly statistics: JobStatisticsWire;
}

/** Per-column bytes estimate, mirroring src/sql/queryEngine.ts's
 *  `BQ_TYPE_BYTES`. Kept in sync as a constant table here so this
 *  module doesn't have to reach into the engine's internals. */
const BYTES_PER_BQ_TYPE: Readonly<Record<string, number>> = {
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

function estimateBytesPerRow(fields: readonly BqField[]): number {
  let total = 0;
  for (const field of fields) {
    const base = BYTES_PER_BQ_TYPE[field.type] ?? 16;
    total += field.mode === 'REPEATED' ? base * 3 : base;
  }
  return total === 0 ? 1 : total;
}

function jobMetaToResource(meta: JobMeta): JobResourceWire {
  const schemaFields =
    (meta.resultSchema as { fields?: readonly BqField[] } | undefined)?.fields ?? [];
  // Surface stored error (e.g. from a cancel) as both `status.errorResult`
  // and an entry in `status.errors`, matching the real BQ wire shape.
  const errorObj = meta.error as { reason?: string; message?: string } | undefined;
  const errorResult =
    errorObj !== undefined && errorObj !== null
      ? {
          reason: errorObj.reason ?? 'internalError',
          message: errorObj.message ?? '',
        }
      : undefined;
  const statementType = meta.statementType ?? 'SELECT';
  const dmlAffected = meta.dmlAffectedRows;
  // Real BQ splits affected rows into per-statement buckets in `dmlStats`.
  // The emulator doesn't track inserted-vs-updated-vs-deleted separately;
  // the count goes into the bucket that matches the statement type.
  const dmlStats =
    dmlAffected !== undefined
      ? statementType === 'INSERT'
        ? { insertedRowCount: String(dmlAffected) }
        : statementType === 'UPDATE'
          ? { updatedRowCount: String(dmlAffected) }
          : statementType === 'DELETE'
            ? { deletedRowCount: String(dmlAffected) }
            : undefined
      : undefined;
  const location = meta.location ?? 'US';
  return {
    kind: 'bigquery#job',
    id: `${meta.project}:${location}.${meta.jobId}`,
    jobReference: {
      projectId: meta.project,
      jobId: meta.jobId,
      location,
    },
    configuration: {
      query: { query: meta.query ?? '' },
      ...(meta.labels !== undefined && { labels: meta.labels }),
    },
    status: {
      state: meta.state,
      ...(errorResult !== undefined && { errorResult }),
    },
    statistics: {
      creationTime: String(meta.createdMs),
      ...(meta.startedMs !== undefined && {
        startTime: String(meta.startedMs),
      }),
      ...(meta.endedMs !== undefined && { endTime: String(meta.endedMs) }),
      // BL-152 — execute-path cost estimation. Mirror the same
      // per-row-bytes formula the dry-run uses (BL-099) so a dry-run
      // followed by an actual run produces comparable numbers. Returns
      // 0 for DML / scripts / DDL with no result schema.
      totalBytesProcessed: String((meta.resultTotalRows ?? 0) * estimateBytesPerRow(schemaFields)),
      ...(dmlAffected !== undefined && {
        numDmlAffectedRows: String(dmlAffected),
      }),
      query: {
        statementType,
        // Slot-ms is BQ's compute-time accounting. For a single-threaded
        // emulator the natural proxy is wall-clock duration of the job.
        totalSlotMs: String(
          meta.startedMs !== undefined && meta.endedMs !== undefined
            ? Math.max(0, meta.endedMs - meta.startedMs)
            : 0,
        ),
        ...(schemaFields.length > 0 && {
          schema: { fields: schemaFields.map(fieldToWire) },
        }),
        ...(meta.cacheHit !== undefined && { cacheHit: meta.cacheHit }),
        ...(dmlStats !== undefined && { dmlStats }),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Body parsing for POST /jobs
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

type ParsedJobBody = ParsedQueryJob | ParsedLoadJob | ParsedExtractJob | ParsedCopyJob;

interface ParsedQueryJob {
  readonly kind: 'query';
  readonly query: string;
  readonly parameters: readonly QueryParameterParsed[];
  readonly jobIdHint: string | undefined;
  readonly dryRun: boolean;
  readonly labels?: Readonly<Record<string, string>>;
  /** Region the job is supposed to run in. Defaults to 'US' when unset
   *  by the client. Cross-location queries (referencing a dataset in
   *  another location) fail with `invalid` (BL-155). */
  readonly location?: string;
  /** When false, bypass the in-memory query result cache (BL-157).
   *  Defaults to true. */
  readonly useQueryCache?: boolean;
}

function expectLabelsMap(value: unknown, field: string): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw BqError.invalid(`${field} must be an object of string keys and string values.`, field);
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw BqError.invalid(`${field}.${k} must be a string.`, `${field}.${k}`);
    }
    result[k] = v;
  }
  return result;
}

interface ParsedLoadJob {
  readonly kind: 'load';
  readonly jobIdHint?: string;
  readonly config: LoadJobConfig;
}

interface ParsedExtractJob {
  readonly kind: 'extract';
  readonly jobIdHint?: string;
  readonly config: ExtractJobConfig;
}

interface ParsedCopyJob {
  readonly kind: 'copy';
  readonly jobIdHint?: string;
  readonly config: CopyJobConfig;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw BqError.invalid(`${path} must be a boolean.`, path);
  }
  return value;
}

function parseJobBody(body: unknown): ParsedJobBody {
  const obj = asObject(body, 'request body');
  const configuration = asObject(obj['configuration'], 'configuration');

  // Load jobs (BL-083/084/085) take a completely different path —
  // bypass the query branch entirely and return a `kind: 'load'` body.
  if (configuration['load'] !== undefined) {
    return parseLoadConfig(configuration, obj);
  }

  // Extract jobs (BL-094) — similarly distinct path.
  if (configuration['extract'] !== undefined) {
    return parseExtractConfig(configuration, obj);
  }

  // Copy jobs (BL-095).
  if (configuration['copy'] !== undefined) {
    return parseCopyConfig(configuration, obj);
  }

  const queryConfig = configuration['query'];
  if (queryConfig === undefined) {
    throw BqError.invalid(
      'configuration.query is required (v0 only supports query jobs).',
      'configuration.query',
    );
  }
  const queryConfigObj = asObject(queryConfig, 'configuration.query');
  const query = expectString(queryConfigObj['query'], 'configuration.query.query');
  const parameters = parseQueryParameters(
    queryConfigObj['queryParameters'],
    'configuration.query.queryParameters',
  );

  // BQ puts `dryRun` at the configuration level per the spec, but some
  // clients also send it under `configuration.query`. Accept either.
  let dryRun = false;
  if (configuration['dryRun'] !== undefined) {
    dryRun = expectBoolean(configuration['dryRun'], 'configuration.dryRun');
  } else if (queryConfigObj['dryRun'] !== undefined) {
    dryRun = expectBoolean(queryConfigObj['dryRun'], 'configuration.query.dryRun');
  }

  let jobIdHint: string | undefined;
  let location: string | undefined;
  const refRaw = obj['jobReference'];
  if (refRaw !== undefined && refRaw !== null) {
    const refObj = asObject(refRaw, 'jobReference');
    if (refObj['jobId'] !== undefined) {
      jobIdHint = expectString(refObj['jobId'], 'jobReference.jobId');
    }
    if (refObj['location'] !== undefined) {
      location = expectString(refObj['location'], 'jobReference.location');
    }
  }

  let labels: Readonly<Record<string, string>> | undefined;
  if (configuration['labels'] !== undefined) {
    labels = expectLabelsMap(configuration['labels'], 'configuration.labels');
  }

  // BL-157 — useQueryCache. Defaults to true (matches BQ). Accept on
  // configuration.query (the spec location) — that's where the BQ
  // client puts it.
  let useQueryCache: boolean | undefined;
  if (queryConfigObj['useQueryCache'] !== undefined) {
    useQueryCache = expectBoolean(
      queryConfigObj['useQueryCache'],
      'configuration.query.useQueryCache',
    );
  }

  return {
    kind: 'query',
    query,
    parameters,
    jobIdHint,
    dryRun,
    ...(labels !== undefined && { labels }),
    ...(location !== undefined && { location }),
    ...(useQueryCache !== undefined && { useQueryCache }),
  };
}

const SUPPORTED_LOAD_FORMATS: ReadonlySet<string> = new Set([
  'CSV',
  'NEWLINE_DELIMITED_JSON',
  'PARQUET',
]);
const VALID_WRITE_DISPOSITIONS: ReadonlySet<string> = new Set([
  'WRITE_APPEND',
  'WRITE_TRUNCATE',
  'WRITE_EMPTY',
]);

/** Parse `configuration.load` into our internal LoadJobConfig.
 *
 * BigQuery accepts a sprawling load config; we honor the subset the
 * Phase-14 1.0.0 work covers (sourceUris, sourceFormat,
 * destinationTable, autodetect, schema, skipLeadingRows,
 * writeDisposition). Unknown formats throw `unsupportedFeature` so the
 * caller sees a precise error. */
function parseLoadConfig(
  configuration: Readonly<Record<string, unknown>>,
  body: Readonly<Record<string, unknown>>,
): ParsedLoadJob {
  const loadObj = asObject(configuration['load'], 'configuration.load');

  const destObj = asObject(loadObj['destinationTable'], 'configuration.load.destinationTable');
  const destProject = expectString(
    destObj['projectId'],
    'configuration.load.destinationTable.projectId',
  );
  const destDataset = expectString(
    destObj['datasetId'],
    'configuration.load.destinationTable.datasetId',
  );
  const destTable = expectString(destObj['tableId'], 'configuration.load.destinationTable.tableId');

  const sourceUrisRaw = loadObj['sourceUris'];
  if (!Array.isArray(sourceUrisRaw) || sourceUrisRaw.length === 0) {
    throw BqError.invalid(
      'configuration.load.sourceUris must be a non-empty array of gs:// URIs.',
      'configuration.load.sourceUris',
    );
  }
  const sourceUris: string[] = sourceUrisRaw.map((value, idx) =>
    expectString(value, `configuration.load.sourceUris[${idx}]`),
  );

  const sourceFormat = expectString(loadObj['sourceFormat'], 'configuration.load.sourceFormat');
  if (!SUPPORTED_LOAD_FORMATS.has(sourceFormat)) {
    throw BqError.unsupportedFeature(
      `configuration.load.sourceFormat="${sourceFormat}" is not supported in v0. Supported: CSV, NEWLINE_DELIMITED_JSON.`,
      'configuration.load.sourceFormat',
    );
  }

  let autodetect: boolean | undefined;
  if (loadObj['autodetect'] !== undefined) {
    autodetect = expectBoolean(loadObj['autodetect'], 'configuration.load.autodetect');
  }

  let schema: { readonly fields: readonly BqField[] } | undefined;
  if (loadObj['schema'] !== undefined) {
    const schemaObj = asObject(loadObj['schema'], 'configuration.load.schema');
    const rawFields = schemaObj['fields'];
    if (!Array.isArray(rawFields)) {
      throw BqError.invalid(
        'configuration.load.schema.fields must be an array.',
        'configuration.load.schema.fields',
      );
    }
    schema = { fields: rawFields.map((raw) => parseLoadField(raw)) };
  }

  let skipLeadingRows: number | undefined;
  if (loadObj['skipLeadingRows'] !== undefined) {
    const v = loadObj['skipLeadingRows'];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) {
      skipLeadingRows = v;
    } else if (typeof v === 'string') {
      const parsed = Number(v);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw BqError.invalid(
          'configuration.load.skipLeadingRows must be a non-negative integer.',
          'configuration.load.skipLeadingRows',
        );
      }
      skipLeadingRows = parsed;
    } else {
      throw BqError.invalid(
        'configuration.load.skipLeadingRows must be a non-negative integer.',
        'configuration.load.skipLeadingRows',
      );
    }
  }

  let writeDisposition: 'WRITE_APPEND' | 'WRITE_TRUNCATE' | 'WRITE_EMPTY' | undefined;
  if (loadObj['writeDisposition'] !== undefined) {
    const value = expectString(loadObj['writeDisposition'], 'configuration.load.writeDisposition');
    if (!VALID_WRITE_DISPOSITIONS.has(value)) {
      throw BqError.invalid(
        `configuration.load.writeDisposition must be one of WRITE_APPEND, WRITE_TRUNCATE, WRITE_EMPTY (got "${value}").`,
        'configuration.load.writeDisposition',
      );
    }
    writeDisposition = value as 'WRITE_APPEND' | 'WRITE_TRUNCATE' | 'WRITE_EMPTY';
  }

  let jobIdHint: string | undefined;
  const refRaw = body['jobReference'];
  if (refRaw !== undefined && refRaw !== null) {
    const refObj = asObject(refRaw, 'jobReference');
    if (refObj['jobId'] !== undefined) {
      jobIdHint = expectString(refObj['jobId'], 'jobReference.jobId');
    }
  }

  const config: LoadJobConfig = {
    project: destProject,
    datasetId: destDataset,
    tableId: destTable,
    sourceUris,
    sourceFormat: sourceFormat as 'CSV' | 'NEWLINE_DELIMITED_JSON' | 'PARQUET',
    ...(autodetect !== undefined && { autodetect }),
    ...(schema !== undefined && { schema }),
    ...(skipLeadingRows !== undefined && { skipLeadingRows }),
    ...(writeDisposition !== undefined && { writeDisposition }),
  };
  return { kind: 'load', config, ...(jobIdHint !== undefined && { jobIdHint }) };
}

/** Minimal BQ field parser shared with tables.ts schema parsing, but
 *  scoped to load — we accept what BL-009/011 already supports. */
function parseLoadField(raw: unknown): BqField {
  const obj = asObject(raw, 'configuration.load.schema.fields[]');
  const name = expectString(obj['name'], 'configuration.load.schema.fields[].name');
  const typeRaw = expectString(obj['type'], 'configuration.load.schema.fields[].type');
  // Don't trust arbitrary strings — round-trip through the type map.
  const type = normalizeBqType(typeRaw);
  let mode: BqMode | undefined;
  if (obj['mode'] !== undefined) {
    const m = expectString(obj['mode'], 'configuration.load.schema.fields[].mode');
    if (m !== 'NULLABLE' && m !== 'REQUIRED' && m !== 'REPEATED') {
      throw BqError.invalid(
        `mode must be NULLABLE / REQUIRED / REPEATED (got "${m}").`,
        'configuration.load.schema.fields[].mode',
      );
    }
    mode = m;
  }
  return { name, type, ...(mode !== undefined && { mode }) };
}

const SUPPORTED_EXTRACT_FORMATS: ReadonlySet<string> = new Set([
  'CSV',
  'NEWLINE_DELIMITED_JSON',
  'PARQUET',
]);

/** Parse `configuration.extract`. */
function parseExtractConfig(
  configuration: Readonly<Record<string, unknown>>,
  body: Readonly<Record<string, unknown>>,
): ParsedExtractJob {
  const extractObj = asObject(configuration['extract'], 'configuration.extract');
  const sourceObj = asObject(extractObj['sourceTable'], 'configuration.extract.sourceTable');
  const srcProject = expectString(
    sourceObj['projectId'],
    'configuration.extract.sourceTable.projectId',
  );
  const srcDataset = expectString(
    sourceObj['datasetId'],
    'configuration.extract.sourceTable.datasetId',
  );
  const srcTable = expectString(sourceObj['tableId'], 'configuration.extract.sourceTable.tableId');

  const urisRaw = extractObj['destinationUris'];
  if (!Array.isArray(urisRaw) || urisRaw.length === 0) {
    throw BqError.invalid(
      'configuration.extract.destinationUris must be a non-empty array of gs:// URIs.',
      'configuration.extract.destinationUris',
    );
  }
  const destinationUris: string[] = urisRaw.map((value, idx) =>
    expectString(value, `configuration.extract.destinationUris[${idx}]`),
  );

  const destinationFormat = expectString(
    extractObj['destinationFormat'],
    'configuration.extract.destinationFormat',
  );
  if (!SUPPORTED_EXTRACT_FORMATS.has(destinationFormat)) {
    throw BqError.unsupportedFeature(
      `configuration.extract.destinationFormat="${destinationFormat}" is not supported in v0. Supported: CSV, NEWLINE_DELIMITED_JSON, PARQUET.`,
      'configuration.extract.destinationFormat',
    );
  }

  let printHeader: boolean | undefined;
  if (extractObj['printHeader'] !== undefined) {
    printHeader = expectBoolean(extractObj['printHeader'], 'configuration.extract.printHeader');
  }

  let fieldDelimiter: string | undefined;
  if (extractObj['fieldDelimiter'] !== undefined) {
    fieldDelimiter = expectString(
      extractObj['fieldDelimiter'],
      'configuration.extract.fieldDelimiter',
    );
  }

  let jobIdHint: string | undefined;
  const refRaw = body['jobReference'];
  if (refRaw !== undefined && refRaw !== null) {
    const refObj = asObject(refRaw, 'jobReference');
    if (refObj['jobId'] !== undefined) {
      jobIdHint = expectString(refObj['jobId'], 'jobReference.jobId');
    }
  }

  const config: ExtractJobConfig = {
    project: srcProject,
    datasetId: srcDataset,
    tableId: srcTable,
    destinationUris,
    destinationFormat: destinationFormat as 'CSV' | 'NEWLINE_DELIMITED_JSON' | 'PARQUET',
    ...(printHeader !== undefined && { printHeader }),
    ...(fieldDelimiter !== undefined && { fieldDelimiter }),
  };
  return { kind: 'extract', config, ...(jobIdHint !== undefined && { jobIdHint }) };
}

const VALID_OPERATION_TYPES: ReadonlySet<string> = new Set(['COPY', 'CLONE', 'SNAPSHOT']);

/** Parse `configuration.copy`. */
function parseCopyConfig(
  configuration: Readonly<Record<string, unknown>>,
  body: Readonly<Record<string, unknown>>,
): ParsedCopyJob {
  const copyObj = asObject(configuration['copy'], 'configuration.copy');

  // BQ accepts either a single `sourceTable` or an array `sourceTables`;
  // v0 only supports the single form (multi-source copy is a niche
  // append-style use case).
  const sourceObj = asObject(copyObj['sourceTable'], 'configuration.copy.sourceTable');
  const srcProject = expectString(
    sourceObj['projectId'],
    'configuration.copy.sourceTable.projectId',
  );
  const srcDataset = expectString(
    sourceObj['datasetId'],
    'configuration.copy.sourceTable.datasetId',
  );
  const srcTable = expectString(sourceObj['tableId'], 'configuration.copy.sourceTable.tableId');

  const destObj = asObject(copyObj['destinationTable'], 'configuration.copy.destinationTable');
  const dstProject = expectString(
    destObj['projectId'],
    'configuration.copy.destinationTable.projectId',
  );
  const dstDataset = expectString(
    destObj['datasetId'],
    'configuration.copy.destinationTable.datasetId',
  );
  const dstTable = expectString(destObj['tableId'], 'configuration.copy.destinationTable.tableId');

  let operationType: 'COPY' | 'CLONE' | 'SNAPSHOT' | undefined;
  if (copyObj['operationType'] !== undefined) {
    const op = expectString(copyObj['operationType'], 'configuration.copy.operationType');
    if (!VALID_OPERATION_TYPES.has(op)) {
      throw BqError.invalid(
        `configuration.copy.operationType must be COPY / CLONE / SNAPSHOT (got "${op}").`,
        'configuration.copy.operationType',
      );
    }
    operationType = op as 'COPY' | 'CLONE' | 'SNAPSHOT';
  }

  let writeDisposition: 'WRITE_APPEND' | 'WRITE_TRUNCATE' | 'WRITE_EMPTY' | undefined;
  if (copyObj['writeDisposition'] !== undefined) {
    const value = expectString(copyObj['writeDisposition'], 'configuration.copy.writeDisposition');
    if (value !== 'WRITE_APPEND' && value !== 'WRITE_TRUNCATE' && value !== 'WRITE_EMPTY') {
      throw BqError.invalid(
        `configuration.copy.writeDisposition must be one of WRITE_APPEND, WRITE_TRUNCATE, WRITE_EMPTY (got "${value}").`,
        'configuration.copy.writeDisposition',
      );
    }
    writeDisposition = value;
  }

  let jobIdHint: string | undefined;
  const refRaw = body['jobReference'];
  if (refRaw !== undefined && refRaw !== null) {
    const refObj = asObject(refRaw, 'jobReference');
    if (refObj['jobId'] !== undefined) {
      jobIdHint = expectString(refObj['jobId'], 'jobReference.jobId');
    }
  }

  const config: CopyJobConfig = {
    source: { project: srcProject, datasetId: srcDataset, tableId: srcTable },
    destination: { project: dstProject, datasetId: dstDataset, tableId: dstTable },
    ...(operationType !== undefined && { operationType }),
    ...(writeDisposition !== undefined && { writeDisposition }),
  };
  return { kind: 'copy', config, ...(jobIdHint !== undefined && { jobIdHint }) };
}

// ---------------------------------------------------------------------------
// GET /queries/{j} pagination
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 10_000;

function parseMaxResults(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw BqError.invalid('maxResults must be a positive integer.', 'maxResults');
  }
  return Math.min(parsed, MAX_PAGE_SIZE);
}

/** Opaque pageToken codec for `GET /queries/{j}`.
 *
 * Tokens are base64-encoded `{ jobId, offset }` so clients treat them as
 * opaque — they can't manufacture one out of thin air and can't crib one
 * from a different job. The jobId-binding catches the "stale token from a
 * previous run" mistake with a 400 instead of silently reading the wrong
 * job's rows.
 *
 * Format: `base64url(JSON({ j: <jobId>, o: <offset> }))`. The short keys
 * keep the token reasonably short on the wire. */
interface DecodedPageToken {
  readonly jobId: string;
  readonly offset: number;
}

export function encodeQueryPageToken(jobId: string, offset: number): string {
  const json = JSON.stringify({ j: jobId, o: offset });
  return Buffer.from(json, 'utf8').toString('base64url');
}

function decodeQueryPageToken(raw: string, expectedJobId: string): DecodedPageToken {
  let parsed: unknown;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw BqError.invalid('pageToken is malformed.', 'pageToken');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw BqError.invalid('pageToken is malformed.', 'pageToken');
  }
  const obj = parsed as Record<string, unknown>;
  const jobId = obj['j'];
  const offset = obj['o'];
  if (
    typeof jobId !== 'string' ||
    typeof offset !== 'number' ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    throw BqError.invalid('pageToken is malformed.', 'pageToken');
  }
  if (jobId !== expectedJobId) {
    throw BqError.invalid(
      `pageToken was issued for a different job (got "${jobId}", expected "${expectedJobId}").`,
      'pageToken',
    );
  }
  return { jobId, offset };
}

/** Parse `startIndex` query param. Like pageToken's offset but client-supplied.
 * BigQuery accepts an unsigned int as a string. Negative → 400. */
function parseStartIndex(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw BqError.invalid('startIndex must be a non-negative integer.', 'startIndex');
  }
  return parsed;
}

interface QueryResultsResponseWire {
  readonly kind: 'bigquery#getQueryResultsResponse';
  readonly schema: { readonly fields: readonly FieldWire[] };
  readonly jobReference: JobReferenceWire;
  readonly totalRows: string;
  readonly rows: readonly RowWire[];
  readonly pageToken?: string;
  readonly jobComplete: boolean;
  readonly cacheHit: false;
}

// ---------------------------------------------------------------------------
// GET /jobs list — pagination + filters
// ---------------------------------------------------------------------------

const LIST_DEFAULT_PAGE_SIZE = 50;
const LIST_MAX_PAGE_SIZE = 1000;

function parseListMaxResults(value: string | undefined): number {
  if (value === undefined) return LIST_DEFAULT_PAGE_SIZE;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw BqError.invalid('maxResults must be a positive integer.', 'maxResults');
  }
  return Math.min(parsed, LIST_MAX_PAGE_SIZE);
}

function parseListPageToken(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw BqError.invalid('pageToken is malformed.', 'pageToken');
  }
  return parsed;
}

const VALID_STATES: ReadonlySet<JobState> = new Set(['PENDING', 'RUNNING', 'DONE']);

/** `stateFilter` can be a single value or repeated. Real BigQuery accepts
 * the repeated query param form; Node's URL parser collapses repeats into
 * the last value. Our `req.query` is a flat Record<string, string>, so we
 * support comma-separated values too: `stateFilter=DONE,RUNNING`. */
function parseStateFilter(value: string | undefined): readonly JobState[] | undefined {
  if (value === undefined || value === '') return undefined;
  const raw = value.split(',').map((s) => s.trim().toUpperCase());
  const out: JobState[] = [];
  for (const s of raw) {
    if (!VALID_STATES.has(s as JobState)) {
      throw BqError.invalid(
        `stateFilter must be one or more of PENDING, RUNNING, DONE (got "${s}").`,
        'stateFilter',
      );
    }
    out.push(s as JobState);
  }
  return out;
}

function parseCreationTime(value: string | undefined, field: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw BqError.invalid(`${field} must be a non-negative integer (ms since epoch).`, field);
  }
  return parsed;
}

type Projection = 'minimal' | 'full';

function parseProjection(value: string | undefined): Projection {
  if (value === undefined || value === '' || value === 'minimal') return 'minimal';
  if (value === 'full') return 'full';
  throw BqError.invalid('projection must be "minimal" or "full".', 'projection');
}

interface JobListEntryWire {
  readonly kind: 'bigquery#job';
  readonly id: string;
  readonly jobReference: JobReferenceWire;
  readonly state: JobState;
  readonly status: JobStatusWire;
  readonly statistics: JobStatisticsWire;
  readonly configuration?: { readonly query: { readonly query: string } };
}

interface JobListWire {
  readonly kind: 'bigquery#jobList';
  readonly etag: string;
  readonly jobs: readonly JobListEntryWire[];
  readonly nextPageToken?: string;
}

function metaToListEntry(meta: JobMeta, projection: Projection): JobListEntryWire {
  // Real BQ: minimal omits configuration; full includes it.
  // The other fields are present in both. `state` at the top level is the
  // BQ convention so clients can filter without diving into `status`.
  const full = jobMetaToResource(meta);
  return {
    kind: 'bigquery#job',
    id: full.id,
    jobReference: full.jobReference,
    state: meta.state,
    status: full.status,
    statistics: full.statistics,
    ...(projection === 'full' && { configuration: full.configuration }),
  };
}

/**
 * Drive a load job: persist a PENDING row up front so callers polling
 * `GET /projects/{p}/jobs/{j}` see it, run the load synchronously, then
 * either flip the persisted row to DONE (success) or DONE-with-error
 * (failure). The HTTP response always reflects the final state — the
 * emulator is synchronous, unlike real BQ which queues long-running
 * jobs.
 */
async function handleLoadJob(
  db: Db,
  project: string,
  parsed: ParsedLoadJob,
): Promise<RouteResponse> {
  const jobId = parsed.jobIdHint ?? randomUUID();
  const startedMs = Date.now();
  // RUNNING row up front. statement_type = 'LOAD' so the JOBS view + the
  // listing filters can pick it up. `createdMs` is set by upsertJob from
  // the existing row on update, so we don't need to pass it on the
  // transition to DONE.
  await upsertJob(db, {
    project,
    jobId,
    state: 'RUNNING',
    statementType: 'LOAD',
    startedMs,
  });

  try {
    const result = await runLoadJob(db, parsed.config);
    const endedMs = Date.now();
    await upsertJob(db, {
      project,
      jobId,
      state: 'DONE',
      statementType: 'LOAD',
      startedMs,
      endedMs,
      dmlAffectedRows: result.outputRows,
    });
    const meta = await getJob(db, project, jobId);
    /* node:coverage ignore next */
    if (meta === null) throw BqError.internalError(`Job ${jobId} was created but missing.`);
    return {
      status: 200,
      body: {
        ...jobMetaToResource(meta),
        configuration: {
          load: {
            sourceUris: parsed.config.sourceUris,
            sourceFormat: parsed.config.sourceFormat,
            destinationTable: {
              projectId: parsed.config.project,
              datasetId: parsed.config.datasetId,
              tableId: parsed.config.tableId,
            },
            ...(parsed.config.autodetect !== undefined && { autodetect: parsed.config.autodetect }),
            ...(parsed.config.writeDisposition !== undefined && {
              writeDisposition: parsed.config.writeDisposition,
            }),
          },
        },
        statistics: {
          ...jobMetaToResource(meta).statistics,
          load: {
            inputFiles: String(parsed.config.sourceUris.length),
            inputFileBytes: String(result.outputBytes),
            outputRows: String(result.outputRows),
            outputBytes: String(result.outputBytes),
          },
        },
      },
    } satisfies RouteResponse;
  } catch (err) {
    const endedMs = Date.now();
    const bqErr =
      err instanceof BqError
        ? err
        : BqError.invalid(err instanceof Error ? err.message : 'Load job failed.');
    await upsertJob(db, {
      project,
      jobId,
      state: 'DONE',
      statementType: 'LOAD',
      startedMs,
      endedMs,
      error: {
        reason: bqErr.reason,
        message: bqErr.message,
        ...(bqErr.location !== undefined && { location: bqErr.location }),
      },
    });
    // Re-throw so the standard error middleware shapes the response.
    throw bqErr;
  }
}

/** Drive an extract job. Mirrors `handleLoadJob`'s lifecycle: persist a
 *  RUNNING row up front, run the export synchronously, flip to DONE
 *  (success) or DONE-with-error (failure). */
async function handleExtractJob(
  db: Db,
  project: string,
  parsed: ParsedExtractJob,
): Promise<RouteResponse> {
  const jobId = parsed.jobIdHint ?? randomUUID();
  const startedMs = Date.now();
  await upsertJob(db, {
    project,
    jobId,
    state: 'RUNNING',
    statementType: 'EXTRACT',
    startedMs,
  });

  try {
    const result = await runExtractJob(db, parsed.config);
    const endedMs = Date.now();
    await upsertJob(db, {
      project,
      jobId,
      state: 'DONE',
      statementType: 'EXTRACT',
      startedMs,
      endedMs,
      dmlAffectedRows: result.rowCount,
    });
    const meta = await getJob(db, project, jobId);
    /* node:coverage ignore next */
    if (meta === null) throw BqError.internalError(`Job ${jobId} was created but missing.`);
    return {
      status: 200,
      body: {
        ...jobMetaToResource(meta),
        configuration: {
          extract: {
            sourceTable: {
              projectId: parsed.config.project,
              datasetId: parsed.config.datasetId,
              tableId: parsed.config.tableId,
            },
            destinationUris: parsed.config.destinationUris,
            destinationFormat: parsed.config.destinationFormat,
            ...(parsed.config.printHeader !== undefined && {
              printHeader: parsed.config.printHeader,
            }),
          },
        },
        statistics: {
          ...jobMetaToResource(meta).statistics,
          extract: {
            destinationUriFileCounts: result.destinationUriFileCounts.map((n) => String(n)),
            inputBytes: String(result.outputBytes),
          },
        },
      },
    } satisfies RouteResponse;
  } catch (err) {
    const endedMs = Date.now();
    const bqErr =
      err instanceof BqError
        ? err
        : BqError.invalid(err instanceof Error ? err.message : 'Extract job failed.');
    await upsertJob(db, {
      project,
      jobId,
      state: 'DONE',
      statementType: 'EXTRACT',
      startedMs,
      endedMs,
      error: {
        reason: bqErr.reason,
        message: bqErr.message,
        ...(bqErr.location !== undefined && { location: bqErr.location }),
      },
    });
    throw bqErr;
  }
}

/** Drive a copy job. Same lifecycle as load/extract — RUNNING row up
 *  front, run synchronously, persist DONE / failed. */
async function handleCopyJob(
  db: Db,
  project: string,
  parsed: ParsedCopyJob,
): Promise<RouteResponse> {
  const jobId = parsed.jobIdHint ?? randomUUID();
  const startedMs = Date.now();
  await upsertJob(db, {
    project,
    jobId,
    state: 'RUNNING',
    statementType: 'COPY',
    startedMs,
  });

  try {
    const result = await runCopyJob(db, parsed.config);
    const endedMs = Date.now();
    await upsertJob(db, {
      project,
      jobId,
      state: 'DONE',
      statementType: 'COPY',
      startedMs,
      endedMs,
      dmlAffectedRows: result.outputRows,
    });
    const meta = await getJob(db, project, jobId);
    /* node:coverage ignore next */
    if (meta === null) throw BqError.internalError(`Job ${jobId} was created but missing.`);
    return {
      status: 200,
      body: {
        ...jobMetaToResource(meta),
        configuration: {
          copy: {
            sourceTable: {
              projectId: parsed.config.source.project,
              datasetId: parsed.config.source.datasetId,
              tableId: parsed.config.source.tableId,
            },
            destinationTable: {
              projectId: parsed.config.destination.project,
              datasetId: parsed.config.destination.datasetId,
              tableId: parsed.config.destination.tableId,
            },
            ...(parsed.config.operationType !== undefined && {
              operationType: parsed.config.operationType,
            }),
            ...(parsed.config.writeDisposition !== undefined && {
              writeDisposition: parsed.config.writeDisposition,
            }),
          },
        },
        statistics: {
          ...jobMetaToResource(meta).statistics,
          copy: {
            copiedRows: String(result.outputRows),
          },
        },
      },
    } satisfies RouteResponse;
  } catch (err) {
    const endedMs = Date.now();
    const bqErr =
      err instanceof BqError
        ? err
        : BqError.invalid(err instanceof Error ? err.message : 'Copy job failed.');
    await upsertJob(db, {
      project,
      jobId,
      state: 'DONE',
      statementType: 'COPY',
      startedMs,
      endedMs,
      error: {
        reason: bqErr.reason,
        message: bqErr.message,
        ...(bqErr.location !== undefined && { location: bqErr.location }),
      },
    });
    throw bqErr;
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export function createJobsRoutes(db: Db): readonly RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/projects/{p}/jobs',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const maxResults = parseListMaxResults(req.query['maxResults']);
        const offset = parseListPageToken(req.query['pageToken']);
        const states = parseStateFilter(req.query['stateFilter']);
        const minCreatedMs = parseCreationTime(req.query['minCreationTime'], 'minCreationTime');
        const maxCreatedMs = parseCreationTime(req.query['maxCreationTime'], 'maxCreationTime');
        const projection = parseProjection(req.query['projection']);

        const { jobs, nextOffset } = await listJobs(db, project, {
          offset,
          limit: maxResults,
          ...(states !== undefined && { states }),
          ...(minCreatedMs !== undefined && { minCreatedMs }),
          ...(maxCreatedMs !== undefined && { maxCreatedMs }),
        });
        const body: JobListWire = {
          kind: 'bigquery#jobList',
          etag: `${project}:${offset}:${maxResults}:${jobs.length}`,
          jobs: jobs.map((m) => metaToListEntry(m, projection)),
          ...(nextOffset !== null && { nextPageToken: String(nextOffset) }),
        };
        return { status: 200, body } satisfies RouteResponse;
      },
    },

    {
      method: 'POST',
      path: '/projects/{p}/jobs',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const parsed = parseJobBody(req.body);

        if (parsed.kind === 'load') {
          return await handleLoadJob(db, project, parsed);
        }
        if (parsed.kind === 'extract') {
          return await handleExtractJob(db, project, parsed);
        }
        if (parsed.kind === 'copy') {
          return await handleCopyJob(db, project, parsed);
        }

        if (parsed.dryRun) {
          // Plan-only: validate + schema, no execution, no row persistence.
          // The job is *not* stored, so GET /jobs/{j} on this jobId would 404.
          // That matches real BQ — dry-run jobs aren't queryable after the fact.
          const dry = await executeQueryDryRun(db, project, parsed.query, parsed.parameters);
          const now = Date.now();
          const jobId = parsed.jobIdHint ?? randomUUID();
          // Hand-build the response so we don't go through jobMetaToResource
          // (which assumes a persisted job). Shape matches real BQ's dry-run.
          const body = {
            kind: 'bigquery#job',
            id: `${project}:US.${jobId}`,
            jobReference: { projectId: project, jobId, location: 'US' },
            configuration: {
              query: { query: parsed.query },
              dryRun: true,
            },
            status: { state: 'DONE' as const },
            statistics: {
              creationTime: String(now),
              startTime: String(now),
              endTime: String(now),
              totalBytesProcessed: String(dry.totalBytesProcessed),
              query: {
                statementType: dry.statementType,
                totalSlotMs: '0',
                ...(dry.schema.length > 0 && {
                  schema: { fields: dry.schema.map(fieldToWire) },
                }),
              },
            },
          };
          return { status: 200, body } satisfies RouteResponse;
        }

        const exec = await executeQuery(db, project, parsed.query, parsed.parameters, {
          ...(parsed.jobIdHint !== undefined && { jobId: parsed.jobIdHint }),
          ...(parsed.labels !== undefined && { labels: parsed.labels }),
          ...(parsed.location !== undefined && { location: parsed.location }),
          ...(parsed.useQueryCache !== undefined && { useQueryCache: parsed.useQueryCache }),
        });
        const meta = await getJob(db, project, exec.jobId);
        if (meta === null) {
          /* node:coverage ignore next 4 */
          throw BqError.internalError(`Job ${exec.jobId} was created but could not be re-read.`);
        }
        return {
          status: 200,
          body: jobMetaToResource(meta),
        } satisfies RouteResponse;
      },
    },

    {
      method: 'GET',
      path: '/projects/{p}/jobs/{j}',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const jobId = req.params['j'] as string;
        const meta = await getJob(db, project, jobId);
        if (meta === null) {
          throw BqError.notFound(`Job "${project}:${jobId}" not found.`);
        }
        return {
          status: 200,
          body: jobMetaToResource(meta),
        } satisfies RouteResponse;
      },
    },

    {
      method: 'POST',
      path: '/projects/{p}/jobs/{j}/cancel',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const jobId = req.params['j'] as string;
        const meta = await cancelJob(db, project, jobId);
        if (meta === null) {
          throw BqError.notFound(`Job "${project}:${jobId}" not found.`);
        }
        // Wire shape: bigquery#jobCancelResponse wraps the (post-cancel) job.
        const body = {
          kind: 'bigquery#jobCancelResponse',
          job: jobMetaToResource(meta),
        };
        return { status: 200, body } satisfies RouteResponse;
      },
    },

    {
      // BigQuery's delete endpoint uses a trailing /delete path segment, not
      // the bare /jobs/{j}. Match that exactly so any BQ client works.
      method: 'DELETE',
      path: '/projects/{p}/jobs/{j}/delete',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const jobId = req.params['j'] as string;
        const deleted = await deleteJob(db, project, jobId);
        if (!deleted) {
          throw BqError.notFound(`Job "${project}:${jobId}" not found.`);
        }
        return { status: 204 } satisfies RouteResponse;
      },
    },

    {
      method: 'GET',
      path: '/projects/{p}/queries/{j}',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const jobId = req.params['j'] as string;
        const meta = await getJob(db, project, jobId);
        if (meta === null) {
          throw BqError.notFound(`Job "${project}:${jobId}" not found.`);
        }
        const maxResults = parseMaxResults(req.query['maxResults']);

        // Two ways to position into the result set:
        //   - pageToken: opaque, issued by us, contains the jobId binding.
        //   - startIndex: client-supplied integer.
        // Per BQ behavior, pageToken wins when both are present.
        const rawToken = req.query['pageToken'];
        const startIndexParam = parseStartIndex(req.query['startIndex']);
        let offset: number;
        if (rawToken !== undefined && rawToken !== '') {
          offset = decodeQueryPageToken(rawToken, jobId).offset;
        } else if (startIndexParam !== undefined) {
          offset = startIndexParam;
        } else {
          offset = 0;
        }

        const schemaFields =
          (meta.resultSchema as { fields?: readonly BqField[] } | undefined)?.fields ?? [];
        const totalRows = meta.resultTotalRows ?? 0;

        // Out-of-range offset (past the end of results) → 400. Real BQ
        // returns InvalidArgument here rather than silently returning empty;
        // that catches stale/corrupted tokens loudly.
        if (offset > totalRows) {
          throw BqError.invalid(
            `Offset ${offset} is past the result set (totalRows=${totalRows}).`,
            rawToken !== undefined ? 'pageToken' : 'startIndex',
          );
        }

        const rowsRaw = await db.query<{ row: unknown }>(
          `SELECT row FROM _bq.job_rows
           WHERE project = $1 AND job_id = $2 AND row_index >= $3::BIGINT
           ORDER BY row_index
           LIMIT $4::BIGINT`,
          [project, jobId, BigInt(offset), BigInt(maxResults)],
        );
        const rows = rowsRaw.map((r) => {
          const raw = r.row;
          return (typeof raw === 'string' ? JSON.parse(raw) : raw) as RowWire;
        });

        const nextStart = offset + rows.length;
        const hasMore = nextStart < totalRows;

        const body: QueryResultsResponseWire = {
          kind: 'bigquery#getQueryResultsResponse',
          schema: { fields: schemaFields.map(fieldToWire) },
          jobReference: { projectId: project, jobId, location: 'US' },
          totalRows: String(totalRows),
          rows,
          ...(hasMore && { pageToken: encodeQueryPageToken(jobId, nextStart) }),
          jobComplete: meta.state === 'DONE',
          cacheHit: false,
        };
        return { status: 200, body } satisfies RouteResponse;
      },
    },
  ];
}

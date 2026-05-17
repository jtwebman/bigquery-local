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

import type { Db } from '../storage/db.ts';
import { cancelJob, deleteJob, getJob, listJobs } from '../storage/meta.ts';
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
import type { BqField } from '../storage/types.ts';
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
  readonly configuration: { readonly query: { readonly query: string } };
  readonly status: JobStatusWire;
  readonly statistics: JobStatisticsWire;
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
  return {
    kind: 'bigquery#job',
    id: `${meta.project}:US.${meta.jobId}`,
    jobReference: {
      projectId: meta.project,
      jobId: meta.jobId,
      location: 'US',
    },
    configuration: { query: { query: meta.query ?? '' } },
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
      totalBytesProcessed: '0',
      ...(dmlAffected !== undefined && {
        numDmlAffectedRows: String(dmlAffected),
      }),
      query: {
        statementType,
        totalSlotMs: '0',
        ...(schemaFields.length > 0 && {
          schema: { fields: schemaFields.map(fieldToWire) },
        }),
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

interface ParsedJobBody {
  readonly query: string;
  readonly parameters: readonly QueryParameterParsed[];
  readonly jobIdHint: string | undefined;
  readonly dryRun: boolean;
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

  // Reject every other job type up front so the client sees a clear error.
  for (const otherType of ['load', 'copy', 'extract']) {
    if (configuration[otherType] !== undefined) {
      throw BqError.unsupportedFeature(
        `configuration.${otherType} jobs are not supported in v0.`,
        `configuration.${otherType}`,
      );
    }
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
  const refRaw = obj['jobReference'];
  if (refRaw !== undefined && refRaw !== null) {
    const refObj = asObject(refRaw, 'jobReference');
    if (refObj['jobId'] !== undefined) {
      jobIdHint = expectString(refObj['jobId'], 'jobReference.jobId');
    }
  }

  return { query, parameters, jobIdHint, dryRun };
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
              totalBytesProcessed: '0',
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

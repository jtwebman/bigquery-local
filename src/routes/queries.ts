/**
 * `jobs.query` — synchronous query endpoint.
 *
 *   POST /projects/{p}/queries
 *
 * Thin wrapper over `executeQuery` in `src/sql/queryEngine.ts`. Parses
 * the BigQuery query-request wire shape, runs the shared pipeline, and
 * formats the result as `bigquery#queryResponse`. The same engine is
 * reused by `POST /jobs` (BL-016) so both paths share parameter
 * handling, SQL translation, casting, and persistence.
 */

import { randomUUID } from 'node:crypto';

import {
  type FieldWire,
  type QueryParameterParsed,
  type RowWire,
  executeQuery,
  executeQueryDryRun,
  fieldToWire,
  parseQueryParameters,
} from '../sql/queryEngine.ts';
import type { Db } from '../storage/db.ts';
import { getJob } from '../storage/meta.ts';
import type { JobMeta } from '../storage/meta.ts';
import type { RouteDefinition, RouteResponse } from '../types.ts';
import { BqError } from '../util/errors.ts';

/** Refetch the persisted job so we can read cache_hit (and any other
 *  derived stat queryEngine wrote during execution). */
async function getJobAfterExec(db: Db, project: string, jobId: string): Promise<JobMeta | null> {
  return getJob(db, project, jobId);
}

interface QueryResponseWire {
  readonly kind: 'bigquery#queryResponse';
  readonly schema?: { readonly fields: readonly FieldWire[] };
  readonly jobReference: {
    readonly projectId: string;
    readonly jobId: string;
    readonly location: string;
  };
  readonly totalRows: string;
  readonly rows?: readonly RowWire[];
  readonly totalBytesProcessed: string;
  readonly jobComplete: true;
  readonly cacheHit: boolean;
  readonly numDmlAffectedRows?: string;
}

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

interface ParsedQueryBody {
  readonly query: string;
  readonly parameters: readonly QueryParameterParsed[];
  readonly dryRun: boolean;
  readonly useQueryCache?: boolean;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw BqError.invalid(`${path} must be a boolean.`, path);
  }
  return value;
}

function parseQueryBody(body: unknown): ParsedQueryBody {
  const obj = asObject(body, 'request body');
  const query = expectString(obj['query'], 'query');
  const parameters = parseQueryParameters(obj['queryParameters'], 'queryParameters');
  const dryRun = obj['dryRun'] === undefined ? false : expectBoolean(obj['dryRun'], 'dryRun');
  const useQueryCache =
    obj['useQueryCache'] === undefined
      ? undefined
      : expectBoolean(obj['useQueryCache'], 'useQueryCache');
  return {
    query,
    parameters,
    dryRun,
    ...(useQueryCache !== undefined && { useQueryCache }),
  };
}

export function createQueriesRoutes(db: Db): readonly RouteDefinition[] {
  return [
    {
      method: 'POST',
      path: '/projects/{p}/queries',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const parsed = parseQueryBody(req.body);

        if (parsed.dryRun) {
          // Plan-only path: validate + schema, no execution, no persistence.
          // BQ still emits a jobReference here so the client gets a stable
          // shape; the jobId is fresh-each-time and not stored.
          const dry = await executeQueryDryRun(db, project, parsed.query, parsed.parameters);
          const body: QueryResponseWire = {
            kind: 'bigquery#queryResponse',
            ...(dry.schema.length > 0 && {
              schema: { fields: dry.schema.map(fieldToWire) },
            }),
            jobReference: {
              projectId: project,
              jobId: randomUUID(),
              location: 'US',
            },
            totalRows: '0',
            rows: [],
            totalBytesProcessed: String(dry.totalBytesProcessed),
            jobComplete: true,
            cacheHit: false,
          };
          return { status: 200, body } satisfies RouteResponse;
        }

        const exec = await executeQuery(db, project, parsed.query, parsed.parameters, {
          ...(parsed.useQueryCache !== undefined && { useQueryCache: parsed.useQueryCache }),
        });
        // Pull the persisted job to find out whether the result came from
        // cache (queryEngine wrote `cache_hit` on the row).
        const meta = await getJobAfterExec(db, project, exec.jobId);
        const body: QueryResponseWire = {
          kind: 'bigquery#queryResponse',
          // Surface schema + rows for SELECT, and for SCRIPT when the last
          // statement produced any (the BQ script-result equivalent).
          ...((exec.statementType === 'SELECT' ||
            (exec.statementType === 'SCRIPT' && exec.schema.length > 0)) && {
            schema: { fields: exec.schema.map(fieldToWire) },
            rows: exec.wireRows,
          }),
          jobReference: {
            projectId: project,
            jobId: exec.jobId,
            location: 'US',
          },
          totalRows: String(exec.totalRows),
          totalBytesProcessed: '0',
          jobComplete: true,
          cacheHit: meta?.cacheHit === true,
          ...(exec.dmlAffectedRows !== undefined && {
            numDmlAffectedRows: String(exec.dmlAffectedRows),
          }),
        };
        return { status: 200, body } satisfies RouteResponse;
      },
    },
  ];
}

/**
 * Datasets REST endpoints.
 *
 * Implements the per-dataset CRUD surface that BigQuery clients expect:
 *
 *   POST   /projects/{p}/datasets            create
 *   GET    /projects/{p}/datasets/{d}        read
 *   PATCH  /projects/{p}/datasets/{d}        partial update (honors If-Match)
 *   DELETE /projects/{p}/datasets/{d}        delete (honors If-Match)
 *
 * The collection list (`GET /projects/{p}/datasets`) with pagination is
 * tracked separately in BACKLOG BL-027.
 *
 * Request bodies and responses use BigQuery's wire format:
 * `{ kind: "bigquery#dataset", datasetReference: { datasetId, projectId },
 *   etag, friendlyName?, description?, location?, labels?, creationTime,
 *   lastModifiedTime, defaultTableExpirationMs? }`.
 * Timestamps and the `defaultTableExpirationMs` count are emitted as
 * decimal strings, matching BigQuery's JSON conventions.
 */

import type { Db } from '../storage/db.ts';
import {
  type DatasetMeta,
  type DatasetMetaInput,
  deleteDataset,
  getDataset,
  upsertDataset,
} from '../storage/meta.ts';
import type { RouteDefinition, RouteRequest, RouteResponse } from '../types.ts';
import { BqError } from '../util/errors.ts';

// ---------------------------------------------------------------------------
// Wire-format types
// ---------------------------------------------------------------------------

interface DatasetReferenceWire {
  readonly datasetId: string;
  readonly projectId: string;
}

interface DatasetResourceWire {
  readonly kind: 'bigquery#dataset';
  readonly etag: string;
  readonly id: string;
  readonly datasetReference: DatasetReferenceWire;
  readonly friendlyName?: string;
  readonly description?: string;
  readonly location?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly defaultTableExpirationMs?: string;
  readonly creationTime: string;
  readonly lastModifiedTime: string;
}

function metaToResource(meta: DatasetMeta): DatasetResourceWire {
  return {
    kind: 'bigquery#dataset',
    etag: meta.etag,
    id: `${meta.project}:${meta.datasetId}`,
    datasetReference: { datasetId: meta.datasetId, projectId: meta.project },
    creationTime: String(meta.createdMs),
    lastModifiedTime: String(meta.updatedMs),
    ...(meta.friendlyName !== undefined && { friendlyName: meta.friendlyName }),
    ...(meta.description !== undefined && { description: meta.description }),
    ...(meta.location !== undefined && { location: meta.location }),
    ...(meta.labels !== undefined && { labels: meta.labels }),
    ...(meta.defaultTableExpirationMs !== undefined && {
      defaultTableExpirationMs: String(meta.defaultTableExpirationMs),
    }),
  };
}

function okResponse(meta: DatasetMeta): RouteResponse {
  return {
    status: 200,
    body: metaToResource(meta),
    headers: { etag: meta.etag },
  };
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

function asObject(body: unknown, fieldHint: string): Readonly<Record<string, unknown>> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw BqError.invalid(`${fieldHint} must be a JSON object.`);
  }
  return body as Readonly<Record<string, unknown>>;
}

/** Coerce a defined-but-unknown value to string, throwing if it isn't. */
function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw BqError.invalid(`${field} must be a string.`, field);
  }
  return value;
}

/** Coerce a defined-but-unknown value to a non-negative integer (number or
 * decimal-string), throwing otherwise. BigQuery sends large counts as strings
 * in JSON to avoid 53-bit precision loss; we accept either form. */
function expectNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  throw BqError.invalid(
    `${field} must be a non-negative integer (number or numeric string).`,
    field,
  );
}

function expectLabels(value: unknown, field: string): Record<string, string> {
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

interface ParsedDatasetBody {
  readonly datasetIdFromBody?: string;
  readonly location?: string;
  readonly friendlyName?: string;
  readonly description?: string;
  readonly labels?: Record<string, string>;
  readonly defaultTableExpirationMs?: number;
}

function parseDatasetBody(body: unknown): ParsedDatasetBody {
  const obj = asObject(body, 'request body');
  let datasetIdFromBody: string | undefined;
  const ref = obj['datasetReference'];
  if (ref !== undefined && ref !== null) {
    const refObj = asObject(ref, 'datasetReference');
    if (refObj['datasetId'] !== undefined) {
      datasetIdFromBody = expectString(refObj['datasetId'], 'datasetReference.datasetId');
    }
  }
  return {
    ...(datasetIdFromBody !== undefined && { datasetIdFromBody }),
    ...(obj['location'] !== undefined && {
      location: expectString(obj['location'], 'location'),
    }),
    ...(obj['friendlyName'] !== undefined && {
      friendlyName: expectString(obj['friendlyName'], 'friendlyName'),
    }),
    ...(obj['description'] !== undefined && {
      description: expectString(obj['description'], 'description'),
    }),
    ...(obj['labels'] !== undefined && {
      labels: expectLabels(obj['labels'], 'labels'),
    }),
    ...(obj['defaultTableExpirationMs'] !== undefined && {
      defaultTableExpirationMs: expectNonNegativeInteger(
        obj['defaultTableExpirationMs'],
        'defaultTableExpirationMs',
      ),
    }),
  };
}

function buildInsertInput(project: string, parsed: ParsedDatasetBody): DatasetMetaInput {
  if (parsed.datasetIdFromBody === undefined) {
    throw BqError.invalid('datasetReference.datasetId is required.', 'datasetReference.datasetId');
  }
  return {
    project,
    datasetId: parsed.datasetIdFromBody,
    ...(parsed.location !== undefined && { location: parsed.location }),
    ...(parsed.friendlyName !== undefined && { friendlyName: parsed.friendlyName }),
    ...(parsed.description !== undefined && { description: parsed.description }),
    ...(parsed.labels !== undefined && { labels: parsed.labels }),
    ...(parsed.defaultTableExpirationMs !== undefined && {
      defaultTableExpirationMs: parsed.defaultTableExpirationMs,
    }),
  };
}

function applyPatch(existing: DatasetMeta, parsed: ParsedDatasetBody): DatasetMetaInput {
  // PATCH semantics: every field present in the body replaces the existing
  // field. Fields absent from the body are preserved. Because parsed
  // omits fields that weren't in the request, `parsed.x ?? existing.x`
  // does exactly that.
  const location = parsed.location ?? existing.location;
  const friendlyName = parsed.friendlyName ?? existing.friendlyName;
  const description = parsed.description ?? existing.description;
  const labels = parsed.labels ?? existing.labels;
  const defaultTableExpirationMs =
    parsed.defaultTableExpirationMs ?? existing.defaultTableExpirationMs;
  return {
    project: existing.project,
    datasetId: existing.datasetId,
    ...(location !== undefined && { location }),
    ...(friendlyName !== undefined && { friendlyName }),
    ...(description !== undefined && { description }),
    ...(labels !== undefined && { labels }),
    ...(defaultTableExpirationMs !== undefined && { defaultTableExpirationMs }),
  };
}

function ifMatchHeader(req: RouteRequest): string | undefined {
  const value = req.headers['if-match'];
  return value === undefined || value === '' ? undefined : value;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export function createDatasetRoutes(db: Db): readonly RouteDefinition[] {
  return [
    {
      method: 'POST',
      path: '/projects/{p}/datasets',
      handler: async (req) => {
        // The router guarantees {p}/{d} placeholders are defined when the
        // handler runs, so `as string` avoids dead defensive branches.
        const project = req.params['p'] as string;
        const parsed = parseDatasetBody(req.body);
        const input = buildInsertInput(project, parsed);
        const existing = await getDataset(db, input.project, input.datasetId);
        if (existing !== null) {
          throw BqError.duplicate(`Dataset "${input.project}:${input.datasetId}" already exists.`);
        }
        const created = await upsertDataset(db, input);
        return okResponse(created);
      },
    },
    {
      method: 'GET',
      path: '/projects/{p}/datasets/{d}',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        const meta = await getDataset(db, project, datasetId);
        if (meta === null) {
          throw BqError.notFound(`Dataset "${project}:${datasetId}" not found.`);
        }
        return okResponse(meta);
      },
    },
    {
      method: 'PATCH',
      path: '/projects/{p}/datasets/{d}',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        const existing = await getDataset(db, project, datasetId);
        if (existing === null) {
          throw BqError.notFound(`Dataset "${project}:${datasetId}" not found.`);
        }
        const parsed = parseDatasetBody(req.body);
        const merged = applyPatch(existing, parsed);
        const updated = await upsertDataset(db, merged, ifMatchHeader(req));
        return okResponse(updated);
      },
    },
    {
      method: 'DELETE',
      path: '/projects/{p}/datasets/{d}',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        const deleted = await deleteDataset(db, project, datasetId, ifMatchHeader(req));
        if (!deleted) {
          throw BqError.notFound(`Dataset "${project}:${datasetId}" not found.`);
        }
        return { status: 204 };
      },
    },
  ];
}

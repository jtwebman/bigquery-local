/**
 * Models REST endpoints (BL-072 — metadata only, no training).
 *
 *   GET    /projects/{p}/datasets/{d}/models              list (paginated)
 *   GET    /projects/{p}/datasets/{d}/models/{m}          read
 *   PATCH  /projects/{p}/datasets/{d}/models/{m}          partial update (If-Match honored)
 *   DELETE /projects/{p}/datasets/{d}/models/{m}          delete (If-Match honored)
 *
 * Real BigQuery creates models via SQL DDL (`CREATE MODEL ...`), not POST.
 * The REST POST endpoint is omitted to match that — clients that try will
 * get a router 404. Once BL-140 lands CREATE MODEL, models will appear
 * here automatically.
 *
 * Wire shape mirrors BigQuery's `Model` resource (the v0 subset we
 * persist): modelReference, modelType, description, friendlyName, labels,
 * location, featureColumns, labelColumns, etag, creationTime,
 * lastModifiedTime, expirationTime.
 */

import type { Db } from '../storage/db.ts';
import {
  type ModelMeta,
  type ModelMetaInput,
  deleteModel,
  getDataset,
  getModel,
  listModels,
  upsertModel,
} from '../storage/meta.ts';
import type { RouteDefinition, RouteRequest, RouteResponse } from '../types.ts';
import { BqError } from '../util/errors.ts';

interface ModelReferenceWire {
  readonly projectId: string;
  readonly datasetId: string;
  readonly modelId: string;
}

interface ModelResourceWire {
  readonly etag: string;
  readonly modelReference: ModelReferenceWire;
  readonly modelType: string;
  readonly description?: string;
  readonly friendlyName?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly location?: string;
  readonly featureColumns?: unknown;
  readonly labelColumns?: unknown;
  readonly creationTime: string;
  readonly lastModifiedTime: string;
  readonly expirationTime?: string;
}

function metaToResource(meta: ModelMeta): ModelResourceWire {
  return {
    etag: meta.etag,
    modelReference: {
      projectId: meta.project,
      datasetId: meta.datasetId,
      modelId: meta.modelId,
    },
    modelType: meta.modelType,
    creationTime: String(meta.createdMs),
    lastModifiedTime: String(meta.updatedMs),
    ...(meta.description !== undefined && { description: meta.description }),
    ...(meta.friendlyName !== undefined && { friendlyName: meta.friendlyName }),
    ...(meta.labels !== undefined && { labels: meta.labels }),
    ...(meta.location !== undefined && { location: meta.location }),
    ...(meta.featureColumns !== undefined && { featureColumns: meta.featureColumns }),
    ...(meta.labelColumns !== undefined && { labelColumns: meta.labelColumns }),
    ...(meta.expirationMs !== undefined && { expirationTime: String(meta.expirationMs) }),
  };
}

function okResponse(meta: ModelMeta): RouteResponse {
  return { status: 200, body: metaToResource(meta), headers: { etag: meta.etag } };
}

function asObject(body: unknown, fieldHint: string): Readonly<Record<string, unknown>> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw BqError.invalid(`${fieldHint} must be a JSON object.`);
  }
  return body as Readonly<Record<string, unknown>>;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw BqError.invalid(`${field} must be a string.`, field);
  }
  return value;
}

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

interface ParsedModelBody {
  readonly description?: string;
  readonly friendlyName?: string;
  readonly labels?: Record<string, string>;
  readonly location?: string;
  readonly featureColumns?: unknown;
  readonly labelColumns?: unknown;
  readonly expirationMs?: number;
}

function parseModelBody(body: unknown): ParsedModelBody {
  const obj = asObject(body, 'request body');
  return {
    ...(obj['description'] !== undefined && {
      description: expectString(obj['description'], 'description'),
    }),
    ...(obj['friendlyName'] !== undefined && {
      friendlyName: expectString(obj['friendlyName'], 'friendlyName'),
    }),
    ...(obj['labels'] !== undefined && { labels: expectLabels(obj['labels'], 'labels') }),
    ...(obj['location'] !== undefined && {
      location: expectString(obj['location'], 'location'),
    }),
    ...(obj['featureColumns'] !== undefined && { featureColumns: obj['featureColumns'] }),
    ...(obj['labelColumns'] !== undefined && { labelColumns: obj['labelColumns'] }),
    ...(obj['expirationTime'] !== undefined && {
      expirationMs: expectNonNegativeInteger(obj['expirationTime'], 'expirationTime'),
    }),
  };
}

function applyPatch(existing: ModelMeta, parsed: ParsedModelBody): ModelMetaInput {
  return {
    project: existing.project,
    datasetId: existing.datasetId,
    modelId: existing.modelId,
    modelType: existing.modelType,
    ...((parsed.description ?? existing.description) !== undefined && {
      description: parsed.description ?? existing.description,
    }),
    ...((parsed.friendlyName ?? existing.friendlyName) !== undefined && {
      friendlyName: parsed.friendlyName ?? existing.friendlyName,
    }),
    ...((parsed.labels ?? existing.labels) !== undefined && {
      labels: parsed.labels ?? existing.labels,
    }),
    ...((parsed.location ?? existing.location) !== undefined && {
      location: parsed.location ?? existing.location,
    }),
    ...((parsed.featureColumns ?? existing.featureColumns) !== undefined && {
      featureColumns: parsed.featureColumns ?? existing.featureColumns,
    }),
    ...((parsed.labelColumns ?? existing.labelColumns) !== undefined && {
      labelColumns: parsed.labelColumns ?? existing.labelColumns,
    }),
    ...((parsed.expirationMs ?? existing.expirationMs) !== undefined && {
      expirationMs: parsed.expirationMs ?? existing.expirationMs,
    }),
  };
}

function ifMatchHeader(req: RouteRequest): string | undefined {
  const value = req.headers['if-match'];
  return value === undefined || value === '' ? undefined : value;
}

const LIST_DEFAULT_PAGE_SIZE = 50;
const LIST_MAX_PAGE_SIZE = 1000;

function parseMaxResults(value: string | undefined): number {
  if (value === undefined) return LIST_DEFAULT_PAGE_SIZE;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw BqError.invalid('maxResults must be a positive integer.', 'maxResults');
  }
  return Math.min(parsed, LIST_MAX_PAGE_SIZE);
}

function parsePageToken(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw BqError.invalid('pageToken is malformed.', 'pageToken');
  }
  return parsed;
}

interface ModelListEntryWire {
  readonly modelReference: ModelReferenceWire;
  readonly modelType: string;
  readonly creationTime: string;
  readonly lastModifiedTime: string;
  readonly etag: string;
  readonly labels?: Readonly<Record<string, string>>;
}

interface ModelListWire {
  readonly models: readonly ModelListEntryWire[];
  readonly nextPageToken?: string;
}

function metaToListEntry(meta: ModelMeta): ModelListEntryWire {
  return {
    modelReference: {
      projectId: meta.project,
      datasetId: meta.datasetId,
      modelId: meta.modelId,
    },
    modelType: meta.modelType,
    creationTime: String(meta.createdMs),
    lastModifiedTime: String(meta.updatedMs),
    etag: meta.etag,
    ...(meta.labels !== undefined && { labels: meta.labels }),
  };
}

async function ensureParentDataset(db: Db, project: string, datasetId: string): Promise<void> {
  const ds = await getDataset(db, project, datasetId);
  if (ds === null) {
    throw BqError.notFound(`Dataset "${project}:${datasetId}" not found.`);
  }
}

export function createModelRoutes(db: Db): readonly RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/projects/{p}/datasets/{d}/models',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        await ensureParentDataset(db, project, datasetId);
        const maxResults = parseMaxResults(req.query['maxResults']);
        const offset = parsePageToken(req.query['pageToken']);
        const { models, nextOffset } = await listModels(db, project, datasetId, {
          offset,
          limit: maxResults,
        });
        const body: ModelListWire = {
          models: models.map(metaToListEntry),
          ...(nextOffset !== null && { nextPageToken: String(nextOffset) }),
        };
        return { status: 200, body } satisfies RouteResponse;
      },
    },
    {
      method: 'GET',
      path: '/projects/{p}/datasets/{d}/models/{m}',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        const modelId = req.params['m'] as string;
        const meta = await getModel(db, project, datasetId, modelId);
        if (meta === null) {
          throw BqError.notFound(`Model "${project}:${datasetId}.${modelId}" not found.`);
        }
        return okResponse(meta);
      },
    },
    {
      method: 'PATCH',
      path: '/projects/{p}/datasets/{d}/models/{m}',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        const modelId = req.params['m'] as string;
        const existing = await getModel(db, project, datasetId, modelId);
        if (existing === null) {
          throw BqError.notFound(`Model "${project}:${datasetId}.${modelId}" not found.`);
        }
        const parsed = parseModelBody(req.body);
        const merged = applyPatch(existing, parsed);
        const updated = await upsertModel(db, merged, ifMatchHeader(req));
        return okResponse(updated);
      },
    },
    {
      method: 'DELETE',
      path: '/projects/{p}/datasets/{d}/models/{m}',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        const modelId = req.params['m'] as string;
        const deleted = await deleteModel(db, project, datasetId, modelId, ifMatchHeader(req));
        if (!deleted) {
          throw BqError.notFound(`Model "${project}:${datasetId}.${modelId}" not found.`);
        }
        return { status: 204 };
      },
    },
  ];
}

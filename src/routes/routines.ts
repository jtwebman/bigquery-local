/**
 * Routines REST endpoints (BL-071).
 *
 *   GET    /projects/{p}/datasets/{d}/routines              list (paginated)
 *   POST   /projects/{p}/datasets/{d}/routines              create
 *   GET    /projects/{p}/datasets/{d}/routines/{r}          read
 *   PATCH  /projects/{p}/datasets/{d}/routines/{r}          partial update (no If-Match — BQ Routines uses optimistic etag in body only)
 *   DELETE /projects/{p}/datasets/{d}/routines/{r}          delete
 *
 * Wire shape mirrors BigQuery's `Routine` resource:
 * `{ routineReference: { projectId, datasetId, routineId },
 *    routineType: 'SCALAR_FUNCTION'|'TABLE_VALUED_FUNCTION'|'PROCEDURE',
 *    language: 'SQL'|'JAVASCRIPT', arguments?, returnType?,
 *    definitionBody, etag, creationTime, lastModifiedTime }`.
 *
 * This route does NOT auto-translate the body into DuckDB macros — that
 * happens when CREATE FUNCTION / PROCEDURE runs via the query endpoint.
 * The REST surface only exists so clients can introspect / list / patch /
 * delete persisted routines.
 */

import type { Db } from '../storage/db.ts';
import {
  type RoutineMeta,
  type RoutineMetaInput,
  type RoutineType,
  type RoutineLanguage,
  deleteRoutine,
  getDataset,
  getRoutine,
  listRoutines,
  upsertRoutine,
} from '../storage/meta.ts';
import type { RouteDefinition, RouteResponse } from '../types.ts';
import { BqError } from '../util/errors.ts';

interface RoutineReferenceWire {
  readonly projectId: string;
  readonly datasetId: string;
  readonly routineId: string;
}

interface RoutineResourceWire {
  readonly etag: string;
  readonly routineReference: RoutineReferenceWire;
  readonly routineType: RoutineType;
  readonly language: RoutineLanguage;
  readonly arguments?: unknown;
  readonly returnType?: unknown;
  readonly definitionBody: string;
  readonly creationTime: string;
  readonly lastModifiedTime: string;
}

function metaToResource(meta: RoutineMeta): RoutineResourceWire {
  return {
    etag: meta.etag,
    routineReference: {
      projectId: meta.project,
      datasetId: meta.datasetId,
      routineId: meta.routineId,
    },
    routineType: meta.routineType,
    language: meta.language,
    definitionBody: meta.body,
    creationTime: String(meta.createdMs),
    lastModifiedTime: String(meta.updatedMs),
    ...(meta.arguments !== undefined && { arguments: meta.arguments }),
    ...(meta.returnType !== undefined && { returnType: meta.returnType }),
  };
}

function okResponse(meta: RoutineMeta): RouteResponse {
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

const ROUTINE_TYPES = new Set<string>(['SCALAR_FUNCTION', 'TABLE_VALUED_FUNCTION', 'PROCEDURE']);
const ROUTINE_LANGUAGES = new Set<string>(['SQL', 'JAVASCRIPT']);

interface ParsedRoutineBody {
  readonly routineIdFromBody?: string;
  readonly routineType?: RoutineType;
  readonly language?: RoutineLanguage;
  readonly arguments?: unknown;
  readonly returnType?: unknown;
  readonly definitionBody?: string;
}

function parseRoutineBody(body: unknown): ParsedRoutineBody {
  const obj = asObject(body, 'request body');
  let routineIdFromBody: string | undefined;
  const ref = obj['routineReference'];
  if (ref !== undefined && ref !== null) {
    const refObj = asObject(ref, 'routineReference');
    if (refObj['routineId'] !== undefined) {
      routineIdFromBody = expectString(refObj['routineId'], 'routineReference.routineId');
    }
  }
  let routineType: RoutineType | undefined;
  if (obj['routineType'] !== undefined) {
    const value = expectString(obj['routineType'], 'routineType');
    if (!ROUTINE_TYPES.has(value)) {
      throw BqError.invalid(
        `routineType must be one of SCALAR_FUNCTION, TABLE_VALUED_FUNCTION, PROCEDURE.`,
        'routineType',
      );
    }
    routineType = value as RoutineType;
  }
  let language: RoutineLanguage | undefined;
  if (obj['language'] !== undefined) {
    const value = expectString(obj['language'], 'language');
    if (!ROUTINE_LANGUAGES.has(value)) {
      throw BqError.invalid(`language must be one of SQL, JAVASCRIPT.`, 'language');
    }
    language = value as RoutineLanguage;
  }
  return {
    ...(routineIdFromBody !== undefined && { routineIdFromBody }),
    ...(routineType !== undefined && { routineType }),
    ...(language !== undefined && { language }),
    ...(obj['arguments'] !== undefined && { arguments: obj['arguments'] }),
    ...(obj['returnType'] !== undefined && { returnType: obj['returnType'] }),
    ...(obj['definitionBody'] !== undefined && {
      definitionBody: expectString(obj['definitionBody'], 'definitionBody'),
    }),
  };
}

function buildInsertInput(
  project: string,
  datasetId: string,
  parsed: ParsedRoutineBody,
): RoutineMetaInput {
  if (parsed.routineIdFromBody === undefined) {
    throw BqError.invalid('routineReference.routineId is required.', 'routineReference.routineId');
  }
  if (parsed.routineType === undefined) {
    throw BqError.invalid('routineType is required.', 'routineType');
  }
  if (parsed.definitionBody === undefined) {
    throw BqError.invalid('definitionBody is required.', 'definitionBody');
  }
  return {
    project,
    datasetId,
    routineId: parsed.routineIdFromBody,
    routineType: parsed.routineType,
    language: parsed.language ?? 'SQL',
    body: parsed.definitionBody,
    ...(parsed.arguments !== undefined && { arguments: parsed.arguments }),
    ...(parsed.returnType !== undefined && { returnType: parsed.returnType }),
  };
}

function applyPatch(existing: RoutineMeta, parsed: ParsedRoutineBody): RoutineMetaInput {
  return {
    project: existing.project,
    datasetId: existing.datasetId,
    routineId: existing.routineId,
    routineType: parsed.routineType ?? existing.routineType,
    language: parsed.language ?? existing.language,
    body: parsed.definitionBody ?? existing.body,
    ...((parsed.arguments ?? existing.arguments) !== undefined && {
      arguments: parsed.arguments ?? existing.arguments,
    }),
    ...((parsed.returnType ?? existing.returnType) !== undefined && {
      returnType: parsed.returnType ?? existing.returnType,
    }),
  };
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

interface RoutineListEntryWire {
  readonly routineReference: RoutineReferenceWire;
  readonly routineType: RoutineType;
  readonly language: RoutineLanguage;
  readonly creationTime: string;
  readonly lastModifiedTime: string;
  readonly etag: string;
}

interface RoutineListWire {
  readonly routines: readonly RoutineListEntryWire[];
  readonly nextPageToken?: string;
}

function metaToListEntry(meta: RoutineMeta): RoutineListEntryWire {
  return {
    routineReference: {
      projectId: meta.project,
      datasetId: meta.datasetId,
      routineId: meta.routineId,
    },
    routineType: meta.routineType,
    language: meta.language,
    creationTime: String(meta.createdMs),
    lastModifiedTime: String(meta.updatedMs),
    etag: meta.etag,
  };
}

async function ensureParentDataset(db: Db, project: string, datasetId: string): Promise<void> {
  const ds = await getDataset(db, project, datasetId);
  if (ds === null) {
    throw BqError.notFound(`Dataset "${project}:${datasetId}" not found.`);
  }
}

export function createRoutineRoutes(db: Db): readonly RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/projects/{p}/datasets/{d}/routines',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        await ensureParentDataset(db, project, datasetId);
        const maxResults = parseMaxResults(req.query['maxResults']);
        const offset = parsePageToken(req.query['pageToken']);
        const { routines, nextOffset } = await listRoutines(db, project, datasetId, {
          offset,
          limit: maxResults,
        });
        const body: RoutineListWire = {
          routines: routines.map(metaToListEntry),
          ...(nextOffset !== null && { nextPageToken: String(nextOffset) }),
        };
        return { status: 200, body } satisfies RouteResponse;
      },
    },
    {
      method: 'POST',
      path: '/projects/{p}/datasets/{d}/routines',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        await ensureParentDataset(db, project, datasetId);
        const parsed = parseRoutineBody(req.body);
        const input = buildInsertInput(project, datasetId, parsed);
        const existing = await getRoutine(db, project, datasetId, input.routineId);
        if (existing !== null) {
          throw BqError.duplicate(
            `Routine "${project}:${datasetId}.${input.routineId}" already exists.`,
          );
        }
        const created = await upsertRoutine(db, input);
        return okResponse(created);
      },
    },
    {
      method: 'GET',
      path: '/projects/{p}/datasets/{d}/routines/{r}',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        const routineId = req.params['r'] as string;
        const meta = await getRoutine(db, project, datasetId, routineId);
        if (meta === null) {
          throw BqError.notFound(`Routine "${project}:${datasetId}.${routineId}" not found.`);
        }
        return okResponse(meta);
      },
    },
    {
      method: 'PATCH',
      path: '/projects/{p}/datasets/{d}/routines/{r}',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        const routineId = req.params['r'] as string;
        const existing = await getRoutine(db, project, datasetId, routineId);
        if (existing === null) {
          throw BqError.notFound(`Routine "${project}:${datasetId}.${routineId}" not found.`);
        }
        const parsed = parseRoutineBody(req.body);
        const merged = applyPatch(existing, parsed);
        const updated = await upsertRoutine(db, merged);
        return okResponse(updated);
      },
    },
    {
      method: 'DELETE',
      path: '/projects/{p}/datasets/{d}/routines/{r}',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        const routineId = req.params['r'] as string;
        const deleted = await deleteRoutine(db, project, datasetId, routineId);
        if (!deleted) {
          throw BqError.notFound(`Routine "${project}:${datasetId}.${routineId}" not found.`);
        }
        return { status: 204 };
      },
    },
  ];
}

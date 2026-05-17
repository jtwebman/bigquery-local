/**
 * Tables REST endpoints.
 *
 * The headline `PATCH` flow lives here: a client adds a column to a
 * table's schema, we diff against the stored schema, and (when the diff
 * is compatible) issue `ALTER TABLE … ADD COLUMN` against the real
 * DuckDB table.
 *
 *   GET    /projects/{p}/datasets/{d}/tables             list (paginated)
 *   POST   /projects/{p}/datasets/{d}/tables             create
 *   GET    /projects/{p}/datasets/{d}/tables/{t}         read
 *   PATCH  /projects/{p}/datasets/{d}/tables/{t}         partial update
 *   DELETE /projects/{p}/datasets/{d}/tables/{t}         delete
 *
 * Wire format follows BigQuery's `bigquery#table` resource:
 * `{ kind, etag, id, tableReference: { projectId, datasetId, tableId },
 *   type, schema: { fields }, creationTime, lastModifiedTime,
 *   expirationTime?, description?, numRows? }`.
 *
 * **DuckDB layout**: each BQ dataset maps to a DuckDB schema; each BQ
 * table maps to a DuckDB table in that schema (`"{dataset_id}"."{table_id}"`).
 * `POST` ensures the schema exists, then issues `CREATE TABLE`. `PATCH`
 * issues `ALTER TABLE … ADD COLUMN` per new column. `DELETE` issues
 * `DROP TABLE`.
 *
 * **Schema evolution rules** (matching BigQuery's allowed transitions
 * via `tables.patch`):
 *   - Adding new fields at the end: OK → `ALTER TABLE ADD COLUMN`.
 *   - Removing a field: rejected with 400 invalid.
 *   - Changing a field's type: rejected with 400 invalid.
 *   - Mode `REQUIRED → NULLABLE`: OK (widening, no DDL needed).
 *   - Mode `NULLABLE → REQUIRED`: rejected (narrowing).
 *   - Changing `REPEATED` to/from scalar: rejected.
 *   - Modifying nested `STRUCT` fields: rejected in v0.
 */

import type { Db } from '../storage/db.ts';
import {
  type TableMeta,
  type TableMetaInput,
  deleteTable,
  getDataset,
  getTable,
  listTables,
  upsertTable,
} from '../storage/meta.ts';
import {
  type BqField,
  type BqMode,
  type BqType,
  bqTypeToDuck,
  normalizeBqType,
} from '../storage/types.ts';
import type { RouteDefinition, RouteRequest, RouteResponse } from '../types.ts';
import { BqError } from '../util/errors.ts';

// ---------------------------------------------------------------------------
// Wire-format types
// ---------------------------------------------------------------------------

interface TableReferenceWire {
  readonly projectId: string;
  readonly datasetId: string;
  readonly tableId: string;
}

interface FieldWire {
  readonly name: string;
  readonly type: string;
  readonly mode?: BqMode;
  readonly description?: string;
  readonly fields?: readonly FieldWire[];
}

interface TableResourceWire {
  readonly kind: 'bigquery#table';
  readonly etag: string;
  readonly id: string;
  readonly tableReference: TableReferenceWire;
  readonly type: string;
  readonly schema: { readonly fields: readonly FieldWire[] };
  readonly creationTime: string;
  readonly lastModifiedTime: string;
  readonly expirationTime?: string;
  readonly description?: string;
  readonly numRows?: string;
}

function fieldToWire(field: BqField): FieldWire {
  return {
    name: field.name,
    type: field.type,
    ...(field.mode !== undefined && { mode: field.mode }),
    ...(field.description !== undefined && { description: field.description }),
    ...(field.fields !== undefined && { fields: field.fields.map(fieldToWire) }),
  };
}

function metaToResource(meta: TableMeta): TableResourceWire {
  const schema = (meta.schema as { fields?: readonly BqField[] } | undefined)?.fields ?? [];
  return {
    kind: 'bigquery#table',
    etag: meta.etag,
    id: `${meta.project}:${meta.datasetId}.${meta.tableId}`,
    tableReference: {
      projectId: meta.project,
      datasetId: meta.datasetId,
      tableId: meta.tableId,
    },
    type: meta.type,
    schema: { fields: schema.map(fieldToWire) },
    creationTime: String(meta.createdMs),
    lastModifiedTime: String(meta.updatedMs),
    ...(meta.expirationMs !== undefined && { expirationTime: String(meta.expirationMs) }),
    ...(meta.description !== undefined && { description: meta.description }),
    ...(meta.numRows !== undefined && { numRows: String(meta.numRows) }),
  };
}

function okResponse(meta: TableMeta): RouteResponse {
  return {
    status: 200,
    body: metaToResource(meta),
    headers: { etag: meta.etag },
  };
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

function asObject(value: unknown, fieldPath: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw BqError.invalid(`${fieldPath} must be a JSON object.`, fieldPath);
  }
  return value as Readonly<Record<string, unknown>>;
}

function expectString(value: unknown, fieldPath: string): string {
  if (typeof value !== 'string') {
    throw BqError.invalid(`${fieldPath} must be a string.`, fieldPath);
  }
  return value;
}

function expectNonNegativeInteger(value: unknown, fieldPath: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  throw BqError.invalid(
    `${fieldPath} must be a non-negative integer (number or numeric string).`,
    fieldPath,
  );
}

function expectMode(value: unknown, fieldPath: string): BqMode {
  if (value === 'NULLABLE' || value === 'REQUIRED' || value === 'REPEATED') return value;
  throw BqError.invalid(`${fieldPath} must be one of NULLABLE, REQUIRED, REPEATED.`, fieldPath);
}

function parseBqField(value: unknown, path: string): BqField {
  const obj = asObject(value, path);
  const name = expectString(obj['name'], `${path}.name`);
  if (name === '') {
    throw BqError.invalid(`${path}.name must be non-empty.`, `${path}.name`);
  }
  const rawType = expectString(obj['type'], `${path}.type`);
  let type: BqType;
  try {
    type = normalizeBqType(rawType);
  } catch (err) {
    throw BqError.invalid(`${path}.type: ${(err as Error).message}`, `${path}.type`);
  }
  const result: {
    name: string;
    type: BqType;
    mode?: BqMode;
    description?: string;
    fields?: readonly BqField[];
  } = { name, type };
  if (obj['mode'] !== undefined) {
    result.mode = expectMode(obj['mode'], `${path}.mode`);
  }
  if (obj['description'] !== undefined) {
    result.description = expectString(obj['description'], `${path}.description`);
  }
  if (obj['fields'] !== undefined) {
    result.fields = parseBqFields(obj['fields'], `${path}.fields`);
  }
  if (type === 'STRUCT' && (result.fields === undefined || result.fields.length === 0)) {
    throw BqError.invalid(`${path}: STRUCT field requires a non-empty fields list.`, path);
  }
  return result;
}

function parseBqFields(value: unknown, path: string): readonly BqField[] {
  if (!Array.isArray(value)) {
    throw BqError.invalid(`${path} must be an array.`, path);
  }
  return value.map((f, i) => parseBqField(f, `${path}[${i}]`));
}

interface ParsedTableBody {
  readonly tableIdFromBody?: string;
  readonly schema?: { readonly fields: readonly BqField[] };
  readonly description?: string;
  readonly expirationMs?: number;
}

function parseTableBody(body: unknown): ParsedTableBody {
  const obj = asObject(body, 'request body');
  let tableIdFromBody: string | undefined;
  const ref = obj['tableReference'];
  if (ref !== undefined && ref !== null) {
    const refObj = asObject(ref, 'tableReference');
    if (refObj['tableId'] !== undefined) {
      tableIdFromBody = expectString(refObj['tableId'], 'tableReference.tableId');
    }
  }
  let schema: { readonly fields: readonly BqField[] } | undefined;
  if (obj['schema'] !== undefined) {
    const schemaObj = asObject(obj['schema'], 'schema');
    const fields = parseBqFields(schemaObj['fields'] ?? [], 'schema.fields');
    schema = { fields };
  }
  return {
    ...(tableIdFromBody !== undefined && { tableIdFromBody }),
    ...(schema !== undefined && { schema }),
    ...(obj['description'] !== undefined && {
      description: expectString(obj['description'], 'description'),
    }),
    ...(obj['expirationTime'] !== undefined && {
      expirationMs: expectNonNegativeInteger(obj['expirationTime'], 'expirationTime'),
    }),
  };
}

function ifMatchHeader(req: RouteRequest): string | undefined {
  const value = req.headers['if-match'];
  return value === undefined || value === '' ? undefined : value;
}

// ---------------------------------------------------------------------------
// Schema diff for PATCH
// ---------------------------------------------------------------------------

function isModeWideningOrEqual(existing: BqMode, proposed: BqMode): boolean {
  if (existing === proposed) return true;
  // REQUIRED → NULLABLE is widening; everything else involving REPEATED is
  // a type change.
  if (existing === 'REQUIRED' && proposed === 'NULLABLE') return true;
  return false;
}

function fieldsStructurallyEqual(
  a: readonly BqField[] | undefined,
  b: readonly BqField[] | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined || bi === undefined) return false;
    if (
      ai.name !== bi.name ||
      ai.type !== bi.type ||
      (ai.mode ?? 'NULLABLE') !== (bi.mode ?? 'NULLABLE') ||
      !fieldsStructurallyEqual(ai.fields, bi.fields)
    ) {
      return false;
    }
  }
  return true;
}

/** Returns the columns to ADD via ALTER TABLE. Throws on any narrowing
 * change (removed column, type change, narrowing mode, modified STRUCT). */
function diffSchemaForPatch(
  existing: readonly BqField[],
  proposed: readonly BqField[],
): readonly BqField[] {
  const existingByName = new Map(existing.map((f) => [f.name, f] as const));
  const proposedByName = new Map(proposed.map((f) => [f.name, f] as const));

  for (const [name, ef] of existingByName) {
    const pf = proposedByName.get(name);
    if (pf === undefined) {
      throw BqError.invalid(`Cannot remove field "${name}" from table schema.`, `schema.fields`);
    }
    if (pf.type !== ef.type) {
      throw BqError.invalid(
        `Cannot change type of field "${name}" from ${ef.type} to ${pf.type}.`,
        `schema.fields.${name}.type`,
      );
    }
    const existingMode = ef.mode ?? 'NULLABLE';
    const proposedMode = pf.mode ?? 'NULLABLE';
    if (!isModeWideningOrEqual(existingMode, proposedMode)) {
      throw BqError.invalid(
        `Cannot change mode of field "${name}" from ${existingMode} to ${proposedMode}.`,
        `schema.fields.${name}.mode`,
      );
    }
    if (ef.type === 'STRUCT' && !fieldsStructurallyEqual(ef.fields, pf.fields)) {
      throw BqError.invalid(
        `Cannot modify nested fields of STRUCT column "${name}" in v0.`,
        `schema.fields.${name}.fields`,
      );
    }
  }

  const added: BqField[] = [];
  for (const pf of proposed) {
    if (!existingByName.has(pf.name)) added.push(pf);
  }
  return added;
}

// ---------------------------------------------------------------------------
// DuckDB DDL helpers
// ---------------------------------------------------------------------------

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function qualifiedTableName(datasetId: string, tableId: string): string {
  return `${quoteIdent(datasetId)}.${quoteIdent(tableId)}`;
}

/** Full DuckDB column definition: quoted name + type + (NOT NULL when
 * the BQ field's mode is REQUIRED). REPEATED columns stay nullable —
 * the whole list value can be NULL even though its elements have BQ's
 * usual NULL-aware semantics. */
function columnDefinition(field: BqField): string {
  const constraint = field.mode === 'REQUIRED' ? ' NOT NULL' : '';
  return `${quoteIdent(field.name)} ${bqTypeToDuck(field)}${constraint}`;
}

function buildCreateTableSql(
  datasetId: string,
  tableId: string,
  fields: readonly BqField[],
): string {
  const columns = fields.map(columnDefinition).join(', ');
  return `CREATE TABLE ${qualifiedTableName(datasetId, tableId)} (${columns})`;
}

function buildAddColumnSql(datasetId: string, tableId: string, field: BqField): string {
  return `ALTER TABLE ${qualifiedTableName(datasetId, tableId)} ADD COLUMN ${columnDefinition(field)}`;
}

function buildDropTableSql(datasetId: string, tableId: string): string {
  return `DROP TABLE IF EXISTS ${qualifiedTableName(datasetId, tableId)}`;
}

async function ensureDatasetSchema(db: Db, datasetId: string): Promise<void> {
  await db.exec(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(datasetId)}`);
}

// ---------------------------------------------------------------------------
// List endpoint — pagination
// ---------------------------------------------------------------------------

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

interface TableListEntryWire {
  readonly kind: 'bigquery#table';
  readonly id: string;
  readonly tableReference: TableReferenceWire;
  readonly type: string;
  readonly creationTime: string;
  readonly expirationTime?: string;
}

interface TableListWire {
  readonly kind: 'bigquery#tableList';
  readonly etag: string;
  readonly tables: readonly TableListEntryWire[];
  readonly totalItems: number;
  readonly nextPageToken?: string;
}

function metaToListEntry(meta: TableMeta): TableListEntryWire {
  // Like real BigQuery's tableList — strip schema, description, numRows
  // from the list response. Those land on the individual GET.
  return {
    kind: 'bigquery#table',
    id: `${meta.project}:${meta.datasetId}.${meta.tableId}`,
    tableReference: {
      projectId: meta.project,
      datasetId: meta.datasetId,
      tableId: meta.tableId,
    },
    type: meta.type,
    creationTime: String(meta.createdMs),
    ...(meta.expirationMs !== undefined && { expirationTime: String(meta.expirationMs) }),
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export function createTableRoutes(db: Db): readonly RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/projects/{p}/datasets/{d}/tables',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        // Confirm parent dataset exists — without this, "no tables" and
        // "no dataset" would be indistinguishable to the client.
        const datasetMeta = await getDataset(db, project, datasetId);
        if (datasetMeta === null) {
          throw BqError.notFound(`Dataset "${project}:${datasetId}" not found.`);
        }
        const maxResults = parseMaxResults(req.query['maxResults']);
        const offset = parsePageToken(req.query['pageToken']);
        const { tables, nextOffset } = await listTables(db, project, datasetId, {
          offset,
          limit: maxResults,
        });
        const body: TableListWire = {
          kind: 'bigquery#tableList',
          etag: `${project}:${datasetId}:${offset}:${maxResults}:${tables.length}`,
          tables: tables.map(metaToListEntry),
          // BigQuery's totalItems is the total count across all pages.
          // For an offset-based emulator this is the offset + this-page +
          // remaining (approximate when we have nextOffset, exact otherwise).
          // To keep this honest we report only what we know: offset + page len.
          // Clients that need totals should paginate to the end.
          totalItems: offset + tables.length,
          ...(nextOffset !== null && { nextPageToken: String(nextOffset) }),
        };
        return { status: 200, body } satisfies RouteResponse;
      },
    },
    {
      method: 'POST',
      path: '/projects/{p}/datasets/{d}/tables',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        const parsed = parseTableBody(req.body);
        if (parsed.tableIdFromBody === undefined) {
          throw BqError.invalid('tableReference.tableId is required.', 'tableReference.tableId');
        }
        const tableId = parsed.tableIdFromBody;
        // Dataset must exist before creating tables in it.
        const datasetMeta = await getDataset(db, project, datasetId);
        if (datasetMeta === null) {
          throw BqError.notFound(`Dataset "${project}:${datasetId}" not found.`);
        }
        // Reject duplicate table.
        const existing = await getTable(db, project, datasetId, tableId);
        if (existing !== null) {
          throw BqError.duplicate(`Table "${project}:${datasetId}.${tableId}" already exists.`);
        }
        const fields = parsed.schema?.fields ?? [];
        // Ensure the dataset's DuckDB schema exists, then create the data table.
        await ensureDatasetSchema(db, datasetId);
        await db.exec(buildCreateTableSql(datasetId, tableId, fields));
        // Persist metadata.
        const input: TableMetaInput = {
          project,
          datasetId,
          tableId,
          type: 'TABLE',
          schema: { fields },
          ...(parsed.description !== undefined && { description: parsed.description }),
          ...(parsed.expirationMs !== undefined && { expirationMs: parsed.expirationMs }),
        };
        const created = await upsertTable(db, input);
        return okResponse(created);
      },
    },
    {
      method: 'GET',
      path: '/projects/{p}/datasets/{d}/tables/{t}',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        const tableId = req.params['t'] as string;
        const meta = await getTable(db, project, datasetId, tableId);
        if (meta === null) {
          throw BqError.notFound(`Table "${project}:${datasetId}.${tableId}" not found.`);
        }
        return okResponse(meta);
      },
    },
    {
      method: 'PATCH',
      path: '/projects/{p}/datasets/{d}/tables/{t}',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        const tableId = req.params['t'] as string;
        const existing = await getTable(db, project, datasetId, tableId);
        if (existing === null) {
          throw BqError.notFound(`Table "${project}:${datasetId}.${tableId}" not found.`);
        }
        const parsed = parseTableBody(req.body);

        const existingFields =
          (existing.schema as { fields?: readonly BqField[] } | undefined)?.fields ?? [];

        // If a new schema is supplied, diff it and apply DDL for any new
        // columns. The diff itself rejects any narrowing change.
        let nextFields = existingFields;
        if (parsed.schema !== undefined) {
          const added = diffSchemaForPatch(existingFields, parsed.schema.fields);
          for (const field of added) {
            await db.exec(buildAddColumnSql(datasetId, tableId, field));
          }
          nextFields = parsed.schema.fields;
        }

        const merged: TableMetaInput = {
          project: existing.project,
          datasetId: existing.datasetId,
          tableId: existing.tableId,
          type: existing.type,
          schema: { fields: nextFields },
          ...(parsed.description !== undefined
            ? { description: parsed.description }
            : existing.description !== undefined && { description: existing.description }),
          ...(parsed.expirationMs !== undefined
            ? { expirationMs: parsed.expirationMs }
            : existing.expirationMs !== undefined && { expirationMs: existing.expirationMs }),
          ...(existing.numRows !== undefined && { numRows: existing.numRows }),
          ...(existing.partitioning !== undefined && { partitioning: existing.partitioning }),
          ...(existing.clustering !== undefined && { clustering: existing.clustering }),
        };
        const updated = await upsertTable(db, merged, ifMatchHeader(req));
        return okResponse(updated);
      },
    },
    {
      method: 'DELETE',
      path: '/projects/{p}/datasets/{d}/tables/{t}',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        const tableId = req.params['t'] as string;
        const deleted = await deleteTable(db, project, datasetId, tableId, ifMatchHeader(req));
        if (!deleted) {
          throw BqError.notFound(`Table "${project}:${datasetId}.${tableId}" not found.`);
        }
        // Drop the underlying DuckDB table (idempotent).
        await db.exec(buildDropTableSql(datasetId, tableId));
        return { status: 204 };
      },
    },
  ];
}

/**
 * `tabledata.insertAll` — streaming-style row inserts.
 *
 *   POST /projects/{p}/datasets/{d}/tables/{t}/insertAll
 *
 * Request body (BigQuery wire shape):
 *
 *     { "kind": "bigquery#tableDataInsertAllRequest",
 *       "rows": [{ "insertId"?: string, "json": { ... } }, ...],
 *       "skipInvalidRows"?: boolean,
 *       "ignoreUnknownValues"?: boolean }
 *
 * Response (always HTTP 200 when the request itself is well-formed):
 *
 *     { "kind": "bigquery#tableDataInsertAllResponse",
 *       "insertErrors"?: [{ "index": <row-index>,
 *                            "errors": [{ "reason", "message", "location"? }] }] }
 *
 * Semantics:
 *   - **`skipInvalidRows: true`**: each row executes independently. Rows
 *     that fail land in `insertErrors`; valid rows are still inserted.
 *   - **`skipInvalidRows: false` (default)**: rows execute inside a
 *     single transaction. If any row fails, the entire batch is rolled
 *     back. `insertErrors` still reports which rows failed.
 *   - **`ignoreUnknownValues: true`**: row fields not in the table
 *     schema are dropped silently.
 *   - **`ignoreUnknownValues: false` (default)**: unknown fields cause
 *     that row to fail with reason `invalid`.
 *
 * **`templateSuffix`**: when set, the actual target table is
 * `<base><templateSuffix>` (no separator inserted — the client picks).
 * If the target doesn't exist on first hit, it's auto-created with the
 * same schema as the base table. This is the BQ streaming-ingest
 * pattern Kafka-style connectors use to write into rolling
 * date-suffixed tables like `events20260517`.
 */

import { invalidateQueryCache } from '../sql/queryEngine.ts';
import type { Db } from '../storage/db.ts';
import { getTable, upsertTable } from '../storage/meta.ts';
import type { TableMeta } from '../storage/meta.ts';
import {
  PARTITION_TIME_COLUMN,
  buildCreateTableSql,
  ensureDatasetSchema,
  isIngestionTimePartitioned,
  partitionTruncUnit,
  qualifiedTableName,
} from './tables.ts';
import {
  type BqField,
  bqInsertExpression,
  bqSelectExpression,
  bqValueToDuck,
  duckValueToBq,
} from '../storage/types.ts';
import type { RouteDefinition, RouteResponse } from '../types.ts';
import { BqError } from '../util/errors.ts';

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

interface InsertErrorEntryWire {
  readonly reason: string;
  readonly message: string;
  readonly location?: string;
}

interface InsertErrorWire {
  readonly index: number;
  readonly errors: readonly InsertErrorEntryWire[];
}

interface InsertAllResponseWire {
  readonly kind: 'bigquery#tableDataInsertAllResponse';
  readonly insertErrors?: readonly InsertErrorWire[];
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

interface ParsedInsertAllBody {
  readonly rows: readonly ParsedRow[];
  readonly skipInvalidRows: boolean;
  readonly ignoreUnknownValues: boolean;
  /** When set, the actual target table is `<base><templateSuffix>` —
   * not `<base>_<suffix>`; the client picks any separator they want. */
  readonly templateSuffix: string | undefined;
}

interface ParsedRow {
  readonly insertId: string | undefined;
  readonly json: Readonly<Record<string, unknown>>;
}

function asObject(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw BqError.invalid(`${path} must be a JSON object.`, path);
  }
  return value as Readonly<Record<string, unknown>>;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw BqError.invalid(`${path} must be a boolean.`, path);
  }
  return value;
}

function parseInsertAllBody(body: unknown): ParsedInsertAllBody {
  const obj = asObject(body, 'request body');
  const rawRows = obj['rows'];
  if (!Array.isArray(rawRows)) {
    throw BqError.invalid('rows must be an array.', 'rows');
  }
  const rows: ParsedRow[] = rawRows.map((row, i) => {
    const rowObj = asObject(row, `rows[${i}]`);
    const insertIdRaw = rowObj['insertId'];
    if (insertIdRaw !== undefined && typeof insertIdRaw !== 'string') {
      throw BqError.invalid(`rows[${i}].insertId must be a string.`, `rows[${i}].insertId`);
    }
    const insertId = typeof insertIdRaw === 'string' ? insertIdRaw : undefined;
    const jsonRaw = rowObj['json'];
    if (jsonRaw === undefined) {
      throw BqError.invalid(`rows[${i}].json is required.`, `rows[${i}].json`);
    }
    const json = asObject(jsonRaw, `rows[${i}].json`);
    return { insertId, json };
  });
  // The `bq` CLI serializes an unset templateSuffix as explicit null; treat
  // that like absent rather than rejecting it (same tolerance as elsewhere).
  const templateSuffixRaw = obj['templateSuffix'];
  if (
    templateSuffixRaw !== undefined &&
    templateSuffixRaw !== null &&
    typeof templateSuffixRaw !== 'string'
  ) {
    throw BqError.invalid('templateSuffix must be a string.', 'templateSuffix');
  }
  // Empty-string suffix means "no template suffix" — same target as base.
  // Real BQ also treats empty as a no-op.
  const templateSuffix =
    typeof templateSuffixRaw === 'string' && templateSuffixRaw.length > 0
      ? templateSuffixRaw
      : undefined;
  return {
    rows,
    // The `bq` CLI sends these as explicit null when unset; treat null (like
    // undefined) as the default rather than rejecting it.
    skipInvalidRows:
      obj['skipInvalidRows'] == null ? false : asBoolean(obj['skipInvalidRows'], 'skipInvalidRows'),
    ignoreUnknownValues:
      obj['ignoreUnknownValues'] == null
        ? false
        : asBoolean(obj['ignoreUnknownValues'], 'ignoreUnknownValues'),
    templateSuffix,
  };
}

// ---------------------------------------------------------------------------
// Row encoding + SQL build
// ---------------------------------------------------------------------------

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function tableSchemaFields(meta: TableMeta): readonly BqField[] {
  return (meta.schema as { fields?: readonly BqField[] } | undefined)?.fields ?? [];
}

function buildInsertSql(meta: TableMeta, fields: readonly BqField[]): string {
  const cols = fields.map((f) => quoteIdent(f.name));
  const placeholders = fields.map((f, i) => bqInsertExpression(i + 1, f));
  // Ingestion-time partitioning: auto-fill the hidden _partition_time
  // column with the partition-truncated insertion timestamp. Real BQ
  // exposes that value as _PARTITIONTIME; the translator rewrites
  // queries on _PARTITIONTIME / _PARTITIONDATE to point at this column.
  if (isIngestionTimePartitioned(meta.partitioning)) {
    const tpType = (meta.partitioning as { type: string }).type;
    cols.push(quoteIdent(PARTITION_TIME_COLUMN));
    placeholders.push(`date_trunc('${partitionTruncUnit(tpType)}', CURRENT_TIMESTAMP)`);
  }
  return `INSERT INTO ${qualifiedTableName(meta.project, meta.datasetId, meta.tableId)} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
}

interface RowOutcome {
  readonly index: number;
  readonly error?: InsertErrorEntryWire;
  readonly values?: readonly unknown[];
}

/** Validate + encode one row against the schema. */
function encodeRow(
  row: ParsedRow,
  fields: readonly BqField[],
  ignoreUnknownValues: boolean,
  index: number,
): RowOutcome {
  const fieldNames = new Set(fields.map((f) => f.name));
  if (!ignoreUnknownValues) {
    for (const key of Object.keys(row.json)) {
      if (!fieldNames.has(key)) {
        return {
          index,
          error: {
            reason: 'invalid',
            message: `Row has unknown field "${key}". Set ignoreUnknownValues=true to drop it.`,
            location: key,
          },
        };
      }
    }
  }
  try {
    const values = fields.map((f) => bqValueToDuck(row.json[f.name], f));
    return { index, values };
  } catch (err) {
    return {
      index,
      error: {
        reason: 'invalid',
        message: err instanceof Error ? err.message : 'Row encoding failed.',
      },
    };
  }
}

function toInsertErrorWire(outcome: RowOutcome): InsertErrorWire | null {
  if (outcome.error === undefined) return null;
  return { index: outcome.index, errors: [outcome.error] };
}

// ---------------------------------------------------------------------------
// tabledata.list — GET .../tables/{t}/data
// ---------------------------------------------------------------------------

const LIST_DEFAULT_PAGE_SIZE = 100;
const LIST_MAX_PAGE_SIZE = 10_000;

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

/** Resolve `selectedFields` (comma-separated) against the table schema.
 * Returns the projected field list, preserving the *table's* column order
 * so the f/v wire shape stays predictable for clients. Unknown names → 400. */
function selectedFieldsFor(
  schema: readonly BqField[],
  raw: string | undefined,
): readonly BqField[] {
  if (raw === undefined || raw === '') return schema;
  const requested = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  if (requested.size === 0) return schema;
  // Validate names up front so partial-match results don't sneak through.
  const known = new Set(schema.map((f) => f.name));
  for (const name of requested) {
    if (!known.has(name)) {
      throw BqError.invalid(`selectedFields names unknown column "${name}".`, 'selectedFields');
    }
  }
  return schema.filter((f) => requested.has(f.name));
}

interface RowWire {
  readonly f: ReadonlyArray<{ readonly v: unknown }>;
}

interface TableDataListWire {
  readonly kind: 'bigquery#tableDataList';
  readonly etag: string;
  readonly totalRows: string;
  readonly rows: readonly RowWire[];
  readonly pageToken?: string;
}

// ---------------------------------------------------------------------------
// insertAll — insertId dedup (best-effort, in-memory, per server instance)
// ---------------------------------------------------------------------------

/**
 * Per-table LRU of recently-seen `insertId`s. Matches BigQuery's "1-minute
 * dedup window" behavior — within the window, repeat insertIds are dropped
 * silently from the insert path. After the window, they're allowed again.
 *
 * Notes that match real BQ semantics on purpose:
 *   - Dedup is per-table. Same insertId in another table is a fresh insert.
 *   - Dedup applies even when the original insert *failed* — the mark is
 *     recorded at submit-time, not commit-time. Retries with the same
 *     insertId are no-ops regardless of original outcome.
 *   - Dedup applies *within* a batch too: if a single request includes the
 *     same insertId twice, only the first is inserted.
 *
 * In-memory only. If the server restarts, dedup state is lost — same as a
 * real BQ outage spanning the window.
 */
export class InsertIdDedup {
  private readonly windowMs: number;
  private readonly maxPerTable: number;
  /** tableKey → (insertId → expiresAt). Map iterates insertion-order so the
   *  oldest entry is always first — that's our cheap eviction target. */
  private readonly tables = new Map<string, Map<string, number>>();

  constructor(options: { readonly windowMs?: number; readonly maxPerTable?: number } = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxPerTable = options.maxPerTable ?? 10_000;
  }

  /** Returns true if `insertId` was already recorded for `tableKey` within
   * the window. Otherwise records it and returns false. */
  seenOrRecord(tableKey: string, insertId: string, now: number): boolean {
    let bucket = this.tables.get(tableKey);
    if (bucket === undefined) {
      bucket = new Map();
      this.tables.set(tableKey, bucket);
    }
    // Cheap amortized sweep — drop a handful of expired entries each call,
    // keep the per-call cost bounded regardless of bucket size.
    let swept = 0;
    for (const [k, expiresAt] of bucket) {
      if (expiresAt > now) break;
      bucket.delete(k);
      if (++swept > 64) break;
    }
    const existing = bucket.get(insertId);
    if (existing !== undefined && existing > now) return true;
    bucket.set(insertId, now + this.windowMs);
    if (bucket.size > this.maxPerTable) {
      // Evict the oldest entry (Map iteration is insertion-order).
      const firstKey = bucket.keys().next().value;
      if (firstKey !== undefined) bucket.delete(firstKey);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export function createTabledataRoutes(
  db: Db,
  options: { readonly dedup?: InsertIdDedup } = {},
): readonly RouteDefinition[] {
  const dedup = options.dedup ?? new InsertIdDedup();
  return [
    {
      method: 'GET',
      path: '/projects/{p}/datasets/{d}/tables/{t}/data',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        const tableId = req.params['t'] as string;
        const meta = await getTable(db, project, datasetId, tableId);
        if (meta === null) {
          throw BqError.notFound(`Table "${project}:${datasetId}.${tableId}" not found.`);
        }
        const schema = tableSchemaFields(meta);
        const fields = selectedFieldsFor(schema, req.query['selectedFields']);
        const maxResults = parseMaxResults(req.query['maxResults']);
        const offset = parsePageToken(req.query['pageToken']);

        // Count first so totalRows is the table's true row count, not the page.
        // Small price for an emulator; the real BQ uses table metadata.
        const qualified = qualifiedTableName(project, datasetId, tableId);
        const countRows = await db.query<{ n: bigint }>(
          `SELECT COUNT(*)::BIGINT AS n FROM ${qualified}`,
        );
        const totalRows = Number(countRows[0]?.n ?? 0n);

        // Empty schema (zero-column tables don't really exist in BQ, but be safe).
        let pageRows: ReadonlyArray<Record<string, unknown>>;
        if (fields.length === 0) {
          pageRows = [];
        } else {
          const projection = fields
            .map((f) => `${bqSelectExpression(f.name, f)} AS ${quoteIdent(f.name)}`)
            .join(', ');
          // Stable order by ROWID equivalent: DuckDB doesn't expose one for
          // user tables, but absent ORDER BY the read order matches insert
          // order in practice. For multi-page consistency we use the system
          // rowid alias via the underlying rowid column (DuckDB provides it).
          pageRows = await db.query<Record<string, unknown>>(
            `SELECT ${projection} FROM ${qualified}
             ORDER BY rowid
             LIMIT $1::BIGINT OFFSET $2::BIGINT`,
            [BigInt(maxResults), BigInt(offset)],
          );
        }

        const wireRows: RowWire[] = pageRows.map((row) => ({
          f: fields.map((field) => ({ v: duckValueToBq(row[field.name], field) })),
        }));

        const nextOffset = offset + wireRows.length;
        const hasMore = nextOffset < totalRows;

        const body: TableDataListWire = {
          kind: 'bigquery#tableDataList',
          etag: `${project}:${datasetId}:${tableId}:${offset}:${maxResults}:${wireRows.length}`,
          totalRows: String(totalRows),
          rows: wireRows,
          ...(hasMore && { pageToken: String(nextOffset) }),
        };
        return { status: 200, body } satisfies RouteResponse;
      },
    },

    {
      method: 'POST',
      path: '/projects/{p}/datasets/{d}/tables/{t}/insertAll',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        const baseTableId = req.params['t'] as string;
        const baseMeta = await getTable(db, project, datasetId, baseTableId);
        if (baseMeta === null) {
          throw BqError.notFound(`Table "${project}:${datasetId}.${baseTableId}" not found.`);
        }
        const parsed = parseInsertAllBody(req.body);

        // templateSuffix: when set, target = base + suffix; auto-create on
        // first hit with the base's schema. Without it, target == base.
        let targetMeta: TableMeta = baseMeta;
        if (parsed.templateSuffix !== undefined) {
          const targetTableId = baseTableId + parsed.templateSuffix;
          const existingTarget = await getTable(db, project, datasetId, targetTableId);
          if (existingTarget !== null) {
            targetMeta = existingTarget;
          } else {
            const baseFields = tableSchemaFields(baseMeta);
            await ensureDatasetSchema(db, project, datasetId);
            // IF NOT EXISTS for safe concurrent-create — two parallel inserts
            // racing on the same suffix won't error one of them.
            await db.exec(
              buildCreateTableSql(project, datasetId, targetTableId, baseFields, {
                ifNotExists: true,
              }),
            );
            targetMeta = await upsertTable(db, {
              project,
              datasetId,
              tableId: targetTableId,
              type: 'TABLE',
              ...(baseMeta.schema !== undefined && { schema: baseMeta.schema }),
            });
          }
        }

        const fields = tableSchemaFields(targetMeta);

        // Encode every row first; collect per-row failures from the
        // encode step before any DDL runs.
        //
        // insertId dedup is also applied here: a row whose insertId has been
        // seen within the window becomes a silent skip — `{ index }` with no
        // `values` and no `error`. The downstream insert loop already treats
        // that shape as "do nothing", so no further plumbing is needed.
        // Same insertId twice in one batch also dedups (first wins).
        const tableKey = `${project}:${datasetId}:${targetMeta.tableId}`;
        const now = Date.now();
        const outcomes: RowOutcome[] = parsed.rows.map((row, i) => {
          if (row.insertId !== undefined && dedup.seenOrRecord(tableKey, row.insertId, now)) {
            return { index: i };
          }
          return encodeRow(row, fields, parsed.ignoreUnknownValues, i);
        });

        const sql = buildInsertSql(targetMeta, fields);

        if (parsed.skipInvalidRows) {
          // Per-row execution: each row is independent. Encoding failures
          // are already in `outcomes`; for everything else run INSERT and
          // record any runtime error.
          for (const outcome of outcomes) {
            if (outcome.error !== undefined || outcome.values === undefined) continue;
            try {
              await db.exec(sql, outcome.values);
            } catch (err) {
              outcomes[outcome.index] = {
                index: outcome.index,
                error: {
                  reason: 'invalid',
                  message: err instanceof Error ? err.message : 'Insert failed.',
                },
              };
            }
          }
        } else {
          // Transactional: any failure (encode OR runtime) rolls back the
          // whole batch. Encoding failures already short-circuit the run.
          const anyEncodeError = outcomes.some((o) => o.error !== undefined);
          if (!anyEncodeError && outcomes.length > 0) {
            await db.exec('BEGIN TRANSACTION');
            let rolledBack = false;
            for (const outcome of outcomes) {
              if (outcome.values === undefined) continue;
              try {
                await db.exec(sql, outcome.values);
              } catch (err) {
                outcomes[outcome.index] = {
                  index: outcome.index,
                  error: {
                    reason: 'invalid',
                    message: err instanceof Error ? err.message : 'Insert failed.',
                  },
                };
                await db.exec('ROLLBACK');
                rolledBack = true;
                break;
              }
            }
            if (!rolledBack) {
              await db.exec('COMMIT');
            }
          }
        }

        const insertErrors = outcomes
          .map(toInsertErrorWire)
          .filter((e): e is InsertErrorWire => e !== null);

        // BL-157 — any successful row write invalidates the result cache.
        if (insertErrors.length < outcomes.length) {
          invalidateQueryCache();
        }

        const body: InsertAllResponseWire =
          insertErrors.length === 0
            ? { kind: 'bigquery#tableDataInsertAllResponse' }
            : { kind: 'bigquery#tableDataInsertAllResponse', insertErrors };

        return { status: 200, body } satisfies RouteResponse;
      },
    },
  ];
}

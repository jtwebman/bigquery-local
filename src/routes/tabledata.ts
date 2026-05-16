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
 * `templateSuffix` (auto-creating a `{table}_{suffix}` table) is out
 * of scope for v0 — see BACKLOG BL-033.
 */

import type { Db } from '../storage/db.ts';
import { getTable } from '../storage/meta.ts';
import type { TableMeta } from '../storage/meta.ts';
import { type BqField, bqInsertExpression, bqValueToDuck } from '../storage/types.ts';
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
  return {
    rows,
    skipInvalidRows:
      obj['skipInvalidRows'] === undefined
        ? false
        : asBoolean(obj['skipInvalidRows'], 'skipInvalidRows'),
    ignoreUnknownValues:
      obj['ignoreUnknownValues'] === undefined
        ? false
        : asBoolean(obj['ignoreUnknownValues'], 'ignoreUnknownValues'),
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
  const cols = fields.map((f) => quoteIdent(f.name)).join(', ');
  const placeholders = fields.map((f, i) => bqInsertExpression(i + 1, f)).join(', ');
  return `INSERT INTO ${quoteIdent(meta.datasetId)}.${quoteIdent(meta.tableId)} (${cols}) VALUES (${placeholders})`;
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
// Route handler
// ---------------------------------------------------------------------------

export function createTabledataRoutes(db: Db): readonly RouteDefinition[] {
  return [
    {
      method: 'POST',
      path: '/projects/{p}/datasets/{d}/tables/{t}/insertAll',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const datasetId = req.params['d'] as string;
        const tableId = req.params['t'] as string;
        const meta = await getTable(db, project, datasetId, tableId);
        if (meta === null) {
          throw BqError.notFound(`Table "${project}:${datasetId}.${tableId}" not found.`);
        }
        const parsed = parseInsertAllBody(req.body);
        const fields = tableSchemaFields(meta);

        // Encode every row first; collect per-row failures from the
        // encode step before any DDL runs.
        const outcomes: RowOutcome[] = parsed.rows.map((row, i) =>
          encodeRow(row, fields, parsed.ignoreUnknownValues, i),
        );

        const sql = buildInsertSql(meta, fields);

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

        const body: InsertAllResponseWire =
          insertErrors.length === 0
            ? { kind: 'bigquery#tableDataInsertAllResponse' }
            : { kind: 'bigquery#tableDataInsertAllResponse', insertErrors };

        return { status: 200, body } satisfies RouteResponse;
      },
    },
  ];
}

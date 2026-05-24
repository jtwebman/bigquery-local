/**
 * Load job orchestration (BL-083 CSV, BL-084 NDJSON).
 *
 * Lifecycle of a load job:
 *
 *   1. Fetch each sourceUri via the GCS read client (BL-093).
 *   2. Parse the bytes to in-memory rows:
 *        - CSV → `csv-batch` produces `Record<string, string>`.
 *        - NEWLINE_DELIMITED_JSON → split lines + `JSON.parse` each line.
 *   3. Resolve / infer the schema (BL-090):
 *        - explicit `schema.fields` wins; else if `autodetect: true` (or
 *          the destination doesn't exist + no schema given) infer from
 *          the first N rows; else error.
 *   4. Create the destination table if it doesn't already exist.
 *   5. Type-coerce each row through `bqValueToDuck` and INSERT.
 *
 * The function is pure orchestration — it returns a summary the caller
 * persists into `_bq.jobs`. Caller responsibility:
 *   - resolve sourceUris into absolute `gs://...` URIs
 *   - resolve destinationTable into (project, datasetId, tableId)
 *   - wrap the run in a try/catch that records the job's final state.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import csvBatch from 'csv-batch';

import { readGcsObject, readGcsObjectText } from '../storage/gcs.ts';
import type { Db } from '../storage/db.ts';
import { getTable, upsertTable } from '../storage/meta.ts';
import {
  buildCreateTableSql,
  datasetSchemaName,
  qualifiedTableName,
  quoteIdent,
} from '../routes/tables.ts';
import { type BqField, bqInsertExpression, bqValueToDuck, duckTypeToBq } from '../storage/types.ts';
import { BqError } from '../util/errors.ts';
import { inferSchema, type SampleRow } from './autodetect.ts';

export type LoadSourceFormat = 'CSV' | 'NEWLINE_DELIMITED_JSON' | 'PARQUET';

export interface LoadJobConfig {
  readonly project: string;
  readonly datasetId: string;
  readonly tableId: string;
  readonly sourceUris: readonly string[];
  readonly sourceFormat: LoadSourceFormat;
  readonly autodetect?: boolean;
  /** Explicit schema (BQ wire shape `{ fields: BqField[] }`). When set,
   *  autodetect is ignored. */
  readonly schema?: { readonly fields: readonly BqField[] };
  /** CSV-only: number of header rows to skip. Default 1 when header
   *  detection is on, 0 otherwise. */
  readonly skipLeadingRows?: number;
  /** Append to or overwrite the destination. Mirrors BQ semantics:
   *  WRITE_APPEND (default), WRITE_TRUNCATE, WRITE_EMPTY. */
  readonly writeDisposition?: 'WRITE_APPEND' | 'WRITE_TRUNCATE' | 'WRITE_EMPTY';
  /** Sample size used when autodetecting; defaults to 500 rows. */
  readonly autodetectSampleRows?: number;
}

export interface LoadJobResult {
  readonly outputRows: number;
  readonly outputBytes: number;
  readonly schema: { readonly fields: readonly BqField[] };
}

/**
 * Run the load job to completion. Throws BqError on any failure (the
 * caller persists the failure into the job record).
 */
export async function runLoadJob(db: Db, config: LoadJobConfig): Promise<LoadJobResult> {
  if (config.sourceUris.length === 0) {
    throw BqError.invalid('configuration.load.sourceUris must contain at least one URI.');
  }

  // PARQUET goes through a one-shot SQL path: download → DESCRIBE for
  // schema → `INSERT INTO dest SELECT * FROM read_parquet(file)`.
  // DuckDB handles parsing + insertion in a single statement, so we
  // skip the parse-to-rows step entirely.
  if (config.sourceFormat === 'PARQUET') {
    return await runParquetLoad(db, config);
  }

  // CSV / NDJSON: fetch + parse all source URIs, concatenating rows.
  const { rows, columnOrder, totalBytes } = await fetchAndParse(
    config.sourceUris,
    config.sourceFormat,
    config.skipLeadingRows,
  );

  // Resolve the schema, ensure destination table exists, optionally
  // truncate, and insert row-by-row through the typed-insert pipeline.
  const schema = await resolveSchema(db, config, rows, columnOrder);
  await ensureDestinationTable(db, config, schema);
  if (config.writeDisposition === 'WRITE_TRUNCATE') {
    await db.exec(
      `DELETE FROM ${qualifiedTableName(config.project, config.datasetId, config.tableId)}`,
    );
  }
  const inserted = await insertRows(db, config, schema, rows);

  return {
    outputRows: inserted,
    outputBytes: totalBytes,
    schema: { fields: schema },
  };
}

/** Parquet load path — DuckDB's `read_parquet` does the heavy lifting.
 *
 *   1. Download every source URI to a temp directory; remember the
 *      cumulative byte count.
 *   2. Build a `read_parquet([...])` expression covering all temp files.
 *   3. If we need the schema (autodetect or no destination + no schema)
 *      run a one-row DESCRIBE to extract column types and map them via
 *      `duckTypeToBq`.
 *   4. CREATE TABLE if needed, optionally TRUNCATE, then a single
 *      `INSERT INTO dest SELECT * FROM read_parquet(...)`.
 *   5. Read back the row count via `SELECT changes()` substitute —
 *      DuckDB doesn't expose RETURNING for INSERT-FROM-SELECT in v0, so
 *      we count after the fact. Cheap on a freshly-loaded set. */
async function runParquetLoad(db: Db, config: LoadJobConfig): Promise<LoadJobResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'bq-load-parquet-'));
  try {
    let totalBytes = 0;
    const localPaths: string[] = [];
    for (let i = 0; i < config.sourceUris.length; i += 1) {
      const uri = config.sourceUris[i] as string;
      const bytes = await readGcsObject(uri);
      totalBytes += bytes.byteLength;
      const local = join(tmpDir, `src-${i}.parquet`);
      await writeFile(local, bytes);
      localPaths.push(local);
    }
    const readExpr = `read_parquet([${localPaths.map((p) => sqlString(p)).join(', ')}])`;

    // Resolve schema.
    let schema: readonly BqField[];
    if (config.schema !== undefined) {
      schema = config.schema.fields;
    } else {
      const existing = await getTable(db, config.project, config.datasetId, config.tableId);
      const stored = (existing?.schema as { fields?: readonly BqField[] } | undefined)?.fields;
      if (stored !== undefined && stored.length > 0) {
        schema = stored;
      } else if (config.autodetect === true || existing === null) {
        schema = await describeParquetSchema(db, readExpr);
      } else {
        throw BqError.invalid(
          'configuration.load needs either an explicit schema, autodetect=true, or an existing destination table with a schema.',
          'configuration.load.schema',
        );
      }
    }

    await ensureDestinationTable(db, config, schema);
    if (config.writeDisposition === 'WRITE_TRUNCATE') {
      await db.exec(
        `DELETE FROM ${qualifiedTableName(config.project, config.datasetId, config.tableId)}`,
      );
    }

    // INSERT — DuckDB's read_parquet preserves column order, but our
    // destination column order matches `schema`. Project to that order
    // explicitly so any column-name-collision edge cases throw a clear
    // DuckDB error instead of silently misaligning.
    const cols = schema.map((f) => quoteIdent(f.name)).join(', ');
    const select = schema.map((f) => quoteIdent(f.name)).join(', ');
    await db.exec(
      `INSERT INTO ${qualifiedTableName(
        config.project,
        config.datasetId,
        config.tableId,
      )} (${cols}) SELECT ${select} FROM ${readExpr}`,
    );

    // Count the rows we just inserted via the parquet read; this matches
    // BQ's `outputRows` more closely than the dest table count (which
    // could include pre-existing rows on WRITE_APPEND).
    const rowCountResult = await db.query<{ n: bigint }>(
      `SELECT count(*)::BIGINT AS n FROM ${readExpr}`,
    );
    const rowCount = Number(rowCountResult[0]?.n ?? 0);

    return {
      outputRows: rowCount,
      outputBytes: totalBytes,
      schema: { fields: schema },
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/** Run `DESCRIBE SELECT * FROM read_parquet(...)` to infer schema. */
async function describeParquetSchema(db: Db, readExpr: string): Promise<readonly BqField[]> {
  // DuckDB's DESCRIBE returns rows of (column_name, column_type, …).
  const rows = await db.query<{ column_name: string; column_type: string }>(
    `DESCRIBE SELECT * FROM ${readExpr}`,
  );
  return rows.map((r) => duckTypeToBq(r.column_type, r.column_name));
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Step 1 + 2 — fetch + parse
// ---------------------------------------------------------------------------

interface ParsedSource {
  readonly rows: readonly SampleRow[];
  /** Column ordering from the first source (CSV header order; NDJSON
   *  first-seen-key order). */
  readonly columnOrder: readonly string[];
  readonly totalBytes: number;
}

async function fetchAndParse(
  uris: readonly string[],
  format: LoadSourceFormat,
  skipLeadingRows: number | undefined,
): Promise<ParsedSource> {
  const allRows: SampleRow[] = [];
  let columnOrder: readonly string[] = [];
  let totalBytes = 0;

  for (const uri of uris) {
    const text = await readGcsObjectText(uri);
    totalBytes += Buffer.byteLength(text, 'utf-8');

    if (format === 'CSV') {
      const { rows, headers } = await parseCsv(text, skipLeadingRows);
      if (columnOrder.length === 0) columnOrder = headers;
      for (const row of rows) allRows.push(row);
    } else {
      const rows = parseNdjson(text);
      if (columnOrder.length === 0) columnOrder = orderFromNdjson(rows);
      for (const row of rows) allRows.push(row);
    }
  }

  return { rows: allRows, columnOrder, totalBytes };
}

async function parseCsv(
  text: string,
  skipLeadingRows: number | undefined,
): Promise<{ rows: readonly SampleRow[]; headers: readonly string[] }> {
  // csv-batch consumes a Node Readable; Readable.from accepts any
  // iterable, including a single string.
  const stream = Readable.from([text]);
  const result = await csvBatch<Record<string, string>>(stream, { header: true });
  let rows = result.data;
  // skipLeadingRows is in addition to the header; BigQuery's semantics
  // are "rows to skip BEFORE the body" — if header detection already
  // consumed line 1, we skip skipLeadingRows-1 additional data rows.
  // Treat undefined as "no extra skips".
  const extra = skipLeadingRows === undefined ? 0 : Math.max(skipLeadingRows - 1, 0);
  if (extra > 0) rows = rows.slice(extra);
  // Headers are the keys of the first row when header:true is set.
  const headers = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];
  return { rows, headers };
}

function parseNdjson(text: string): readonly SampleRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const rows: SampleRow[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw BqError.invalid(`NDJSON line ${i + 1} is not a JSON object.`, `sourceUris[0]`);
      }
      rows.push(parsed as SampleRow);
    } catch (err) {
      if (err instanceof BqError) throw err;
      throw BqError.invalid(
        `NDJSON line ${i + 1} failed to parse: ${err instanceof Error ? err.message : 'parse error'}`,
        `sourceUris[0]`,
      );
    }
  }
  return rows;
}

function orderFromNdjson(rows: readonly SampleRow[]): readonly string[] {
  const seen: string[] = [];
  const seenSet = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seenSet.has(key)) {
        seenSet.add(key);
        seen.push(key);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Step 3 — schema resolution
// ---------------------------------------------------------------------------

async function resolveSchema(
  db: Db,
  config: LoadJobConfig,
  rows: readonly SampleRow[],
  columnOrder: readonly string[],
): Promise<readonly BqField[]> {
  if (config.schema !== undefined) return config.schema.fields;

  const existing = await getTable(db, config.project, config.datasetId, config.tableId);
  if (existing !== null) {
    const stored = (existing.schema as { fields?: readonly BqField[] } | undefined)?.fields;
    if (stored !== undefined && stored.length > 0) return stored;
  }

  if (config.autodetect !== true) {
    throw BqError.invalid(
      'configuration.load needs either an explicit schema, autodetect=true, or an existing destination table with a schema.',
      'configuration.load.schema',
    );
  }

  if (rows.length === 0) {
    throw BqError.invalid(
      'Cannot autodetect schema from an empty source.',
      'configuration.load.autodetect',
    );
  }

  const sampleSize = config.autodetectSampleRows ?? 500;
  return inferSchema(rows.slice(0, sampleSize), columnOrder);
}

// ---------------------------------------------------------------------------
// Step 4 — create the destination table if it doesn't exist
// ---------------------------------------------------------------------------

async function ensureDestinationTable(
  db: Db,
  config: LoadJobConfig,
  schema: readonly BqField[],
): Promise<void> {
  const existing = await getTable(db, config.project, config.datasetId, config.tableId);
  if (existing !== null) {
    if (config.writeDisposition === 'WRITE_EMPTY') {
      // BQ surface: WRITE_EMPTY fails if the destination has data.
      const countRows = await db.query<{ n: bigint }>(
        `SELECT count(*)::BIGINT AS n FROM ${qualifiedTableName(
          config.project,
          config.datasetId,
          config.tableId,
        )}`,
      );
      const n = countRows[0]?.n ?? BigInt(0);
      if (n > BigInt(0)) {
        throw BqError.duplicate(
          `Destination table "${config.project}:${config.datasetId}.${config.tableId}" is not empty (writeDisposition=WRITE_EMPTY).`,
        );
      }
    }
    return;
  }

  // Create the dataset's DuckDB schema if needed (mirrors what
  // tables.ts:ensureDatasetSchema does — recreated inline to avoid
  // circular routes ↔ load coupling for one statement).
  await db.exec(
    `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(datasetSchemaName(config.project, config.datasetId))}`,
  );
  await db.exec(buildCreateTableSql(config.project, config.datasetId, config.tableId, schema));
  await upsertTable(db, {
    project: config.project,
    datasetId: config.datasetId,
    tableId: config.tableId,
    type: 'TABLE',
    schema: { fields: schema },
  });
}

// ---------------------------------------------------------------------------
// Step 5 — insert rows
// ---------------------------------------------------------------------------

async function insertRows(
  db: Db,
  config: LoadJobConfig,
  schema: readonly BqField[],
  rows: readonly SampleRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const cols = schema.map((f) => quoteIdent(f.name)).join(', ');
  const placeholders = schema.map((f, i) => bqInsertExpression(i + 1, f)).join(', ');
  const sql = `INSERT INTO ${qualifiedTableName(
    config.project,
    config.datasetId,
    config.tableId,
  )} (${cols}) VALUES (${placeholders})`;

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] as SampleRow;
    let values: readonly unknown[];
    try {
      values = schema.map((f) => bqValueToDuck(row[f.name], f));
    } catch (err) {
      throw BqError.invalid(
        `Row ${i + 1} failed to encode: ${err instanceof Error ? err.message : 'encode error'}`,
        `sourceUris[0]`,
      );
    }
    try {
      await db.exec(sql, values);
      inserted += 1;
    } catch (err) {
      throw BqError.invalid(
        `Row ${i + 1} failed to insert: ${err instanceof Error ? err.message : 'insert error'}`,
        `sourceUris[0]`,
      );
    }
  }
  return inserted;
}

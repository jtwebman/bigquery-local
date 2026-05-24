/**
 * Extract job orchestration (BL-094).
 *
 * Opposite of a load: read rows from a destination table, format them
 * as CSV / NDJSON / Parquet, and upload to one or more GCS URIs. v0
 * supports the three formats the load path also covers; Avro lands when
 * BL-086 does.
 *
 * Extract semantics in real BigQuery:
 *   - sourceTable references the table to export
 *   - destinationUris[] are gs:// URIs; for single-file extracts there's
 *     exactly one, for sharded extracts the URI ends in `*` and BQ
 *     fills in shard numbers. v0 only handles single-file extracts
 *     (no wildcards) — a sharded extract throws unsupportedFeature.
 *   - destinationFormat is CSV / NEWLINE_DELIMITED_JSON / PARQUET / AVRO
 *   - printHeader (CSV only, default true) toggles the header row
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeGcsObject } from '../storage/gcs.ts';
import type { Db } from '../storage/db.ts';
import { getTable } from '../storage/meta.ts';
import { qualifiedTableName } from '../routes/tables.ts';
import { type BqField, bqSelectExpression } from '../storage/types.ts';
import { BqError } from '../util/errors.ts';

export type ExtractDestinationFormat = 'CSV' | 'NEWLINE_DELIMITED_JSON' | 'PARQUET';

export interface ExtractJobConfig {
  readonly project: string;
  readonly datasetId: string;
  readonly tableId: string;
  readonly destinationUris: readonly string[];
  readonly destinationFormat: ExtractDestinationFormat;
  /** CSV-only: emit the header row. Default true. */
  readonly printHeader?: boolean;
  readonly fieldDelimiter?: string;
}

export interface ExtractJobResult {
  readonly destinationUriFileCounts: readonly number[];
  readonly outputBytes: number;
  readonly rowCount: number;
}

export async function runExtractJob(db: Db, config: ExtractJobConfig): Promise<ExtractJobResult> {
  if (config.destinationUris.length === 0) {
    throw BqError.invalid('configuration.extract.destinationUris must contain at least one URI.');
  }
  if (config.destinationUris.length > 1) {
    // Sharded extracts (`gs://b/data-*.csv`) aren't in v0 — the wildcard
    // form is a BQ-managed thing. One URI = one file.
    throw BqError.unsupportedFeature(
      'configuration.extract supports exactly one destinationUri in v0 (no sharded / wildcard outputs).',
      'configuration.extract.destinationUris',
    );
  }
  const uri = config.destinationUris[0] as string;
  if (uri.includes('*')) {
    throw BqError.unsupportedFeature(
      'Wildcard destinationUris are not supported in v0.',
      'configuration.extract.destinationUris',
    );
  }

  const meta = await getTable(db, config.project, config.datasetId, config.tableId);
  if (meta === null) {
    throw BqError.notFound(
      `Source table "${config.project}:${config.datasetId}.${config.tableId}" not found.`,
    );
  }
  const schema = (meta.schema as { fields?: readonly BqField[] } | undefined)?.fields ?? [];

  if (config.destinationFormat === 'PARQUET') {
    return await extractParquet(db, config, uri);
  }
  return await extractTextFormat(db, config, schema, uri);
}

// ---------------------------------------------------------------------------
// CSV / NDJSON — pull rows via SQL, format in JS, upload as one blob.
// ---------------------------------------------------------------------------

async function extractTextFormat(
  db: Db,
  config: ExtractJobConfig,
  schema: readonly BqField[],
  uri: string,
): Promise<ExtractJobResult> {
  if (schema.length === 0) {
    throw BqError.invalid(
      `Source table "${config.tableId}" has no schema; cannot extract.`,
      'configuration.extract.sourceTable',
    );
  }
  const projection = schema.map((f) => bqSelectExpression(f.name, f)).join(', ');
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${projection} FROM ${qualifiedTableName(config.project, config.datasetId, config.tableId)}`,
  );

  let body: string;
  let contentType: string;
  if (config.destinationFormat === 'CSV') {
    body = encodeCsv(schema, rows, config);
    contentType = 'text/csv';
  } else {
    body = encodeNdjson(schema, rows);
    contentType = 'application/x-ndjson';
  }

  const { size } = await writeGcsObject(uri, body, contentType);
  return {
    destinationUriFileCounts: [1],
    outputBytes: size,
    rowCount: rows.length,
  };
}

function encodeCsv(
  schema: readonly BqField[],
  rows: readonly Record<string, unknown>[],
  config: ExtractJobConfig,
): string {
  const delim = config.fieldDelimiter ?? ',';
  const printHeader = config.printHeader ?? true;
  const out: string[] = [];
  if (printHeader) {
    out.push(schema.map((f) => csvField(f.name, delim)).join(delim));
  }
  for (const row of rows) {
    out.push(schema.map((f) => csvField(stringifyValue(row[f.name]), delim)).join(delim));
  }
  return `${out.join('\n')}\n`;
}

function csvField(value: string, delim: string): string {
  // Quote when the value contains the delimiter, a quote, or a newline.
  if (value.includes(delim) || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString(10);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function encodeNdjson(
  schema: readonly BqField[],
  rows: readonly Record<string, unknown>[],
): string {
  const lines = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const f of schema) {
      const value = row[f.name];
      out[f.name] = jsonifyValue(value);
    }
    return JSON.stringify(out);
  });
  return `${lines.join('\n')}\n`;
}

function jsonifyValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString(10);
  if (value instanceof Date) return value.toISOString();
  return value;
}

// ---------------------------------------------------------------------------
// Parquet — let DuckDB write the file directly, then upload it.
// ---------------------------------------------------------------------------

async function extractParquet(
  db: Db,
  config: ExtractJobConfig,
  uri: string,
): Promise<ExtractJobResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'bq-extract-parquet-'));
  const localPath = join(tmpDir, 'out.parquet');
  try {
    await db.exec(
      `COPY (SELECT * FROM ${qualifiedTableName(
        config.project,
        config.datasetId,
        config.tableId,
      )}) TO '${localPath.replace(/'/g, "''")}' (FORMAT PARQUET)`,
    );
    const bytes = await readFile(localPath);
    const { size } = await writeGcsObject(uri, new Uint8Array(bytes), 'application/octet-stream');
    const rows = await db.query<{ n: bigint }>(
      `SELECT count(*)::BIGINT AS n FROM ${qualifiedTableName(
        config.project,
        config.datasetId,
        config.tableId,
      )}`,
    );
    return {
      destinationUriFileCounts: [1],
      outputBytes: size,
      rowCount: Number(rows[0]?.n ?? 0),
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

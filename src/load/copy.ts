/**
 * Copy job orchestration (BL-095).
 *
 * v0 treats BQ's three copy variants (COPY / CLONE / SNAPSHOT) as one
 * thing: a deep copy. Real BigQuery distinguishes CLONE (copy-on-write,
 * lightweight) and SNAPSHOT (read-only point-in-time view) from
 * standard COPY (full data duplication), but for an emulator the
 * observable behavior is identical — the destination has the source's
 * schema and the source's row contents at copy time.
 *
 * Lifecycle:
 *   1. Resolve the source table — 404 if missing.
 *   2. Resolve the destination — honor writeDisposition (BQ defaults
 *      copy jobs to WRITE_EMPTY; we follow that).
 *   3. Create destination with source's schema if it doesn't exist.
 *   4. `INSERT INTO dest SELECT * FROM source`.
 *
 * The route layer wraps the runner in a try/catch to persist the job.
 */

import type { Db } from '../storage/db.ts';
import { getTable, upsertTable } from '../storage/meta.ts';
import {
  buildCreateTableSql,
  datasetSchemaName,
  qualifiedTableName,
  quoteIdent,
} from '../routes/tables.ts';
import type { BqField } from '../storage/types.ts';
import { BqError } from '../util/errors.ts';

export type CopyOperationType = 'COPY' | 'CLONE' | 'SNAPSHOT';

export interface CopyJobConfig {
  readonly source: {
    readonly project: string;
    readonly datasetId: string;
    readonly tableId: string;
  };
  readonly destination: {
    readonly project: string;
    readonly datasetId: string;
    readonly tableId: string;
  };
  /** Defaults to 'COPY' when unset. */
  readonly operationType?: CopyOperationType;
  /** BQ defaults copy jobs to WRITE_EMPTY. */
  readonly writeDisposition?: 'WRITE_APPEND' | 'WRITE_TRUNCATE' | 'WRITE_EMPTY';
}

export interface CopyJobResult {
  readonly outputRows: number;
}

export async function runCopyJob(db: Db, config: CopyJobConfig): Promise<CopyJobResult> {
  const src = await getTable(
    db,
    config.source.project,
    config.source.datasetId,
    config.source.tableId,
  );
  if (src === null) {
    throw BqError.notFound(
      `Source table "${config.source.project}:${config.source.datasetId}.${config.source.tableId}" not found.`,
    );
  }
  const schema = (src.schema as { fields?: readonly BqField[] } | undefined)?.fields ?? [];
  if (schema.length === 0) {
    throw BqError.invalid(
      `Source table "${config.source.tableId}" has no schema; cannot copy.`,
      'configuration.copy.sourceTable',
    );
  }

  const writeDisposition = config.writeDisposition ?? 'WRITE_EMPTY';
  const dest = await getTable(
    db,
    config.destination.project,
    config.destination.datasetId,
    config.destination.tableId,
  );

  if (dest === null) {
    await db.exec(
      `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(
        datasetSchemaName(config.destination.project, config.destination.datasetId),
      )}`,
    );
    await db.exec(
      buildCreateTableSql(
        config.destination.project,
        config.destination.datasetId,
        config.destination.tableId,
        schema,
      ),
    );
    await upsertTable(db, {
      project: config.destination.project,
      datasetId: config.destination.datasetId,
      tableId: config.destination.tableId,
      type: 'TABLE',
      schema: { fields: schema },
    });
  } else if (writeDisposition === 'WRITE_EMPTY') {
    const count = await db.query<{ n: bigint }>(
      `SELECT count(*)::BIGINT AS n FROM ${qualifiedTableName(
        config.destination.project,
        config.destination.datasetId,
        config.destination.tableId,
      )}`,
    );
    if ((count[0]?.n ?? BigInt(0)) > BigInt(0)) {
      throw BqError.duplicate(
        `Destination table "${config.destination.project}:${config.destination.datasetId}.${config.destination.tableId}" is not empty (writeDisposition=WRITE_EMPTY).`,
      );
    }
  } else if (writeDisposition === 'WRITE_TRUNCATE') {
    await db.exec(
      `DELETE FROM ${qualifiedTableName(
        config.destination.project,
        config.destination.datasetId,
        config.destination.tableId,
      )}`,
    );
  }

  // Project source columns explicitly to align with destination column
  // order — the schemas always match (we just copied it) but this makes
  // any future divergence (e.g. WRITE_APPEND into a wider table) error
  // cleanly rather than silently shifting.
  const cols = schema.map((f) => quoteIdent(f.name)).join(', ');
  await db.exec(
    `INSERT INTO ${qualifiedTableName(
      config.destination.project,
      config.destination.datasetId,
      config.destination.tableId,
    )} (${cols}) SELECT ${cols} FROM ${qualifiedTableName(
      config.source.project,
      config.source.datasetId,
      config.source.tableId,
    )}`,
  );

  const rowCount = await db.query<{ n: bigint }>(
    `SELECT count(*)::BIGINT AS n FROM ${qualifiedTableName(
      config.source.project,
      config.source.datasetId,
      config.source.tableId,
    )}`,
  );
  return { outputRows: Number(rowCount[0]?.n ?? 0) };
}

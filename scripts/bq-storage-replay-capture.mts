#!/usr/bin/env node
/**
 * Capture script for the gRPC Storage Read replay suite.
 *
 *   BQ_PROJECT_ID=stg-drops-1 npm run bq-storage-replay:capture
 *
 * Reads every `test/conformance/bq-storage-fixtures/*.fixture.json`,
 * materializes the schema + rows as a real BQ table in
 * `<project>.bq_storage_replay`, opens a `CreateReadSession` +
 * `ReadRows` over the real Storage Read gRPC API, and writes a sibling
 * `.captured.json` file. CI never runs this — refresh on demand. Real
 * BQ bytes the script consumes are negligible (small fixture tables
 * + Avro streaming reads), but it does need `gcloud auth
 * application-default login` first.
 *
 * Default project: `stg-drops-1` (matches `bq-replay-capture.mts`).
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BigQuery } from '@google-cloud/bigquery';
import { v1 as bigqueryStorage } from '@google-cloud/bigquery-storage';

import type { BqField } from '../src/storage/types.ts';
import {
  canonicalizeCreateReadSession,
  canonicalizeReadRowsBatch,
  type CanonicalCapture,
} from '../test/conformance/bq-storage-canonicalize.ts';

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'conformance',
  'bq-storage-fixtures',
);
const DATASET = 'bq_storage_replay';

interface FixtureInput {
  readonly description?: string;
  readonly schema: readonly BqField[];
  readonly insertSql: string;
  readonly createReadSession: {
    readonly dataFormat?: 'AVRO' | 'ARROW';
    readonly selectedFields?: readonly string[];
    readonly rowRestriction?: string;
    readonly maxStreamCount?: number;
  };
}

async function loadFixtures(): Promise<ReadonlyArray<{ name: string; input: FixtureInput }>> {
  const entries = await readdir(FIXTURES_DIR);
  const out: Array<{ name: string; input: FixtureInput }> = [];
  for (const e of entries) {
    if (!e.endsWith('.fixture.json')) continue;
    const name = e.slice(0, -'.fixture.json'.length);
    const input = JSON.parse(await readFile(path.join(FIXTURES_DIR, e), 'utf8')) as FixtureInput;
    out.push({ name, input });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function ensureDataset(bigquery: BigQuery): Promise<void> {
  const [exists] = await bigquery.dataset(DATASET).exists();
  if (!exists) {
    await bigquery.createDataset(DATASET);
    console.log(`Created dataset ${DATASET}`);
  }
}

async function materializeTable(
  bigquery: BigQuery,
  projectId: string,
  tableId: string,
  fixture: FixtureInput,
): Promise<string> {
  // (Re-)create the table with the desired schema, then run the fixture's
  // INSERT SQL with `$TABLE` substituted for the qualified table.
  const dataset = bigquery.dataset(DATASET);
  const table = dataset.table(tableId);
  const [exists] = await table.exists();
  if (exists) {
    await table.delete();
  }
  await dataset.createTable(tableId, {
    schema: { fields: fixture.schema as Array<Record<string, unknown>> },
  });
  const fullTableRef = `\`${projectId}.${DATASET}.${tableId}\``;
  const insertSql = fixture.insertSql.replace(/\$TABLE/g, fullTableRef);
  const [job] = await bigquery.createQueryJob({ query: insertSql, useLegacySql: false });
  await job.getQueryResults();
  return `projects/${projectId}/datasets/${DATASET}/tables/${tableId}`;
}

async function captureFixture(
  client: bigqueryStorage.BigQueryReadClient,
  projectId: string,
  tableRef: string,
  fixture: FixtureInput,
): Promise<CanonicalCapture> {
  const [session] = await client.createReadSession({
    parent: `projects/${projectId}`,
    readSession: {
      table: tableRef,
      dataFormat: fixture.createReadSession.dataFormat ?? 'AVRO',
      readOptions: {
        selectedFields: fixture.createReadSession.selectedFields
          ? [...fixture.createReadSession.selectedFields]
          : [],
        rowRestriction: fixture.createReadSession.rowRestriction ?? '',
      },
    },
    ...(fixture.createReadSession.maxStreamCount !== undefined && {
      maxStreamCount: fixture.createReadSession.maxStreamCount,
    }),
  });

  const canonicalSession = canonicalizeCreateReadSession(
    session as Parameters<typeof canonicalizeCreateReadSession>[0],
  );

  const allBatches: ReturnType<typeof canonicalizeReadRowsBatch>[] = [];
  for (const stream of session.streams ?? []) {
    const readStream = client.readRows({ readStream: stream.name ?? '' });
    for await (const response of readStream as AsyncIterable<unknown>) {
      allBatches.push(
        canonicalizeReadRowsBatch(response as Parameters<typeof canonicalizeReadRowsBatch>[0]),
      );
    }
  }

  const arrowSchemaBytes = session.arrowSchema?.serializedSchema;
  return {
    createReadSession: canonicalSession,
    readRows: allBatches,
    ...(arrowSchemaBytes !== undefined &&
      arrowSchemaBytes !== null && {
        _arrowSchemaBase64: Buffer.from(arrowSchemaBytes as Uint8Array).toString('base64'),
      }),
  };
}

async function main(): Promise<void> {
  const projectId = process.env['BQ_PROJECT_ID'] ?? 'stg-drops-1';
  console.log(`Capturing gRPC Storage Read fixtures against project ${projectId}`);

  const bigquery = new BigQuery({ projectId });
  const client = new bigqueryStorage.BigQueryReadClient({ projectId });

  await ensureDataset(bigquery);

  const fixtures = await loadFixtures();
  if (fixtures.length === 0) {
    console.log('No fixtures to capture.');
    return;
  }

  for (const { name, input } of fixtures) {
    process.stdout.write(`  ${name}: `);
    const tableId = `t_${name.replace(/-/g, '_')}`;
    try {
      const tableRef = await materializeTable(bigquery, projectId, tableId, input);
      const captured = await captureFixture(client, projectId, tableRef, input);
      const outPath = path.join(FIXTURES_DIR, `${name}.captured.json`);
      await writeFile(outPath, `${JSON.stringify(captured, null, 2)}\n`, 'utf8');
      console.log('captured');
    } catch (err) {
      console.log(`FAILED — ${(err as Error).message}`);
    }
  }
}

await main();

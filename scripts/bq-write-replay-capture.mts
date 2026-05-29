#!/usr/bin/env node
/**
 * Capture script for the Storage Write API replay suite.
 *
 *   BQ_PROJECT_ID=stg-drops-1 npm run bq-write-replay:capture
 *
 * For each `test/conformance/bq-write-fixtures/*.fixture.json`:
 *   1. (Re-)create a BQ table in `<project>.bq_write_replay` matching
 *      the fixture's schema.
 *   2. Execute the operation sequence against the real Storage Write
 *      API via `@google-cloud/bigquery-storage`.
 *   3. Canonicalize each response and save the sequence to a sibling
 *      `.captured.json` file.
 *
 * CI never runs this — refresh on demand. Costs negligible BQ bytes
 * (the fixture tables are tiny + dropped+recreated each run).
 */

import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BigQuery } from '@google-cloud/bigquery';
import { v1 as bigqueryStorage } from '@google-cloud/bigquery-storage';
import protobuf from 'protobufjs';

import type { BqField } from '../src/storage/types.ts';
import {
  type CapturedOp,
  type WriteFixtureCapture,
  type WriteFixtureInput,
  type WriteOpRequest,
  maskStreamName,
  sortRows,
} from '../test/conformance/bq-write-canonicalize.ts';

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'conformance',
  'bq-write-fixtures',
);
const DATASET = 'bq_write_replay';

async function loadFixtures(): Promise<ReadonlyArray<{ name: string; input: WriteFixtureInput }>> {
  const entries = await readdir(FIXTURES_DIR);
  const out: Array<{ name: string; input: WriteFixtureInput }> = [];
  for (const e of entries) {
    if (!e.endsWith('.fixture.json')) continue;
    const name = e.slice(0, -'.fixture.json'.length);
    const input = JSON.parse(
      await readFile(path.join(FIXTURES_DIR, e), 'utf8'),
    ) as WriteFixtureInput;
    out.push({ name, input });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function ensureDataset(bigquery: BigQuery): Promise<void> {
  const [exists] = await bigquery.dataset(DATASET).exists();
  if (!exists) {
    await bigquery.createDataset(DATASET);
  }
}

async function materializeTable(
  bigquery: BigQuery,
  tableId: string,
  fields: readonly BqField[],
): Promise<void> {
  const table = bigquery.dataset(DATASET).table(tableId);
  const [exists] = await table.exists();
  if (exists) await table.delete();
  await bigquery.dataset(DATASET).createTable(tableId, {
    schema: { fields: fields as Array<Record<string, unknown>> },
  });
}

function bqTypeToProtoTypeName(field: BqField): string {
  switch (field.type) {
    case 'INT64':
      return 'int64';
    case 'FLOAT64':
      return 'double';
    case 'BOOL':
      return 'bool';
    case 'STRING':
    case 'JSON':
    case 'GEOGRAPHY':
    case 'INTERVAL':
      return 'string';
    case 'BYTES':
      return 'bytes';
    case 'DATE':
      return 'int32';
    case 'TIME':
    case 'TIMESTAMP':
    case 'DATETIME':
      return 'int64';
    case 'NUMERIC':
    case 'BIGNUMERIC':
      return 'string';
    case 'RANGE':
      return 'string';
    case 'STRUCT':
      return 'string';
  }
}

function bqTypeToFieldDescriptorType(field: BqField): number {
  switch (field.type) {
    case 'INT64':
    case 'TIME':
    case 'TIMESTAMP':
    case 'DATETIME':
      return 3;
    case 'FLOAT64':
      return 1;
    case 'BOOL':
      return 8;
    case 'STRING':
    case 'JSON':
    case 'GEOGRAPHY':
    case 'INTERVAL':
    case 'NUMERIC':
    case 'BIGNUMERIC':
    case 'RANGE':
    case 'STRUCT':
      return 9;
    case 'BYTES':
      return 12;
    case 'DATE':
      return 5;
  }
}

function rowTypeFor(fields: readonly BqField[]): protobuf.Type {
  const protoFields: Record<string, { type: string; id: number; rule?: 'repeated' }> = {};
  fields.forEach((f, i) => {
    const entry: { type: string; id: number; rule?: 'repeated' } = {
      type: bqTypeToProtoTypeName(f),
      id: i + 1,
    };
    if (f.mode === 'REPEATED') entry.rule = 'repeated';
    protoFields[f.name] = entry;
  });
  return protobuf.Root.fromJSON({ nested: { Row: { fields: protoFields } } }).lookupType('Row');
}

function buildDescriptor(fields: readonly BqField[]): Record<string, unknown> {
  return {
    name: 'Row',
    field: fields.map((f, i) => ({
      name: f.name,
      number: i + 1,
      type: bqTypeToFieldDescriptorType(f),
      label: f.mode === 'REPEATED' ? 3 : 1,
    })),
  };
}

interface AppendStreamLike {
  write(req: object): Promise<unknown>;
  on(event: 'data', cb: (msg: Record<string, unknown>) => void): void;
  end(): void;
}

async function captureFixture(
  bigquery: BigQuery,
  writeClient: bigqueryStorage.BigQueryWriteClient,
  projectId: string,
  tableId: string,
  fixture: WriteFixtureInput,
): Promise<WriteFixtureCapture> {
  await materializeTable(bigquery, tableId, fixture.schema);
  const parent = `projects/${projectId}/datasets/${DATASET}/tables/${tableId}`;
  const rowType = rowTypeFor(fixture.schema);
  const descriptorObj = buildDescriptor(fixture.schema);
  const streamAliases: Record<string, string> = { _default: `${parent}/streams/_default` };
  let appendStreamCounter = 0;

  const captured: CapturedOp[] = [];

  for (const spec of fixture.operations) {
    try {
      const result = await runOpAgainstBQ(
        writeClient,
        bigquery,
        parent,
        tableId,
        fixture.schema,
        spec,
        streamAliases,
        rowType,
        descriptorObj,
        () => `$${appendStreamCounter++}`,
      );
      captured.push(result);
    } catch (err) {
      if (spec.op === 'appendRows') {
        captured.push({
          op: 'appendRows',
          errorCode: (err as { code?: number }).code ?? 2 /* UNKNOWN */,
          appendResultOffset: null,
          hasWriteStream: false,
        });
      } else {
        throw err;
      }
    }
  }

  return { operations: captured };
}

async function runOpAgainstBQ(
  writeClient: bigqueryStorage.BigQueryWriteClient,
  bigquery: BigQuery,
  parent: string,
  tableId: string,
  schemaFields: readonly BqField[],
  spec: WriteOpRequest,
  streamAliases: Record<string, string>,
  rowType: protobuf.Type,
  descriptorObj: Record<string, unknown>,
  nextAlias: () => string,
): Promise<CapturedOp> {
  switch (spec.op) {
    case 'createWriteStream': {
      const [response] = await writeClient.createWriteStream({
        parent,
        writeStream: { type: spec.type },
      });
      const alias = nextAlias();
      streamAliases[alias] = response.name ?? '';
      return {
        op: 'createWriteStream',
        type: String(response.type ?? ''),
        hasCreateTime: response.createTime !== undefined && response.createTime !== null,
        maskedName: maskStreamName(response.name ?? ''),
      };
    }
    case 'appendRows': {
      const streamName = streamAliases[spec.stream] ?? spec.stream;
      const stream = writeClient.appendRows() as unknown as AppendStreamLike & {
        end: () => void;
      };
      const responses: Record<string, unknown>[] = [];
      const settled = new Promise<void>((resolve) => {
        stream.on('data', (msg: Record<string, unknown>) => {
          responses.push(msg);
          resolve();
        });
      });
      const includeSchema = spec.includeSchema !== false;
      const req: Record<string, unknown> = {
        writeStream: streamName,
        protoRows: {
          ...(includeSchema && { writerSchema: { protoDescriptor: descriptorObj } }),
          rows: {
            serializedRows: spec.rows.map((r) => rowType.encode(rowType.fromObject(r)).finish()),
          },
        },
      };
      if (spec.offset !== undefined) req['offset'] = { value: String(spec.offset) };
      await stream.write(req);
      stream.end();
      try {
        await Promise.race([
          settled,
          new Promise<void>((_, rej) => setTimeout(() => rej(new Error('timeout')), 30_000)),
        ]);
      } catch {
        // No response — likely an error on the stream; let the caller's
        // appendRows-specific error block in captureFixture handle it.
      }
      const resp = responses[0];
      if (resp === undefined) {
        return {
          op: 'appendRows',
          errorCode: 2,
          appendResultOffset: null,
          hasWriteStream: false,
        };
      }
      return {
        op: 'appendRows',
        errorCode: null,
        appendResultOffset:
          (resp['appendResult'] as { offset?: { value?: string } })?.offset?.value ?? null,
        hasWriteStream:
          typeof resp['writeStream'] === 'string' && (resp['writeStream'] as string) !== '',
      };
    }
    case 'finalizeWriteStream': {
      const [response] = await writeClient.finalizeWriteStream({
        name: streamAliases[spec.stream] ?? spec.stream,
      });
      return { op: 'finalizeWriteStream', rowCount: String(response.rowCount ?? 0) };
    }
    case 'batchCommitWriteStreams': {
      const [response] = await writeClient.batchCommitWriteStreams({
        parent,
        writeStreams: spec.streams.map((s) => streamAliases[s] ?? s),
      });
      return {
        op: 'batchCommitWriteStreams',
        hasCommitTime: response.commitTime !== undefined && response.commitTime !== null,
        streamErrorCount: response.streamErrors?.length ?? 0,
      };
    }
    case 'flushRows': {
      const streamName = streamAliases[spec.stream] ?? spec.stream;
      const req: Record<string, unknown> = { writeStream: streamName };
      if (spec.offset !== undefined) req['offset'] = { value: String(spec.offset) };
      const [response] = await writeClient.flushRows(req);
      return { op: 'flushRows', offset: String(response.offset ?? 0) };
    }
    case 'alterTable': {
      const fullRef = `\`${parent.split('/')[1] /* projects token */ === 'projects' ? parent.split('/')[2] : ''}.${DATASET}.${tableId}\``;
      const sql = spec.sql.replace(/\$TABLE/g, fullRef);
      const [job] = await bigquery.createQueryJob({ query: sql, useLegacySql: false });
      await job.getQueryResults();
      return { op: 'alterTable' };
    }
    case 'selectTable': {
      const sqlRaw = spec.sql.replace(
        /\$TABLE/g,
        `\`${parent.split('/')[1]}.${DATASET}.${tableId}\``,
      );
      // ignore schemaFields — we just return rows from BQ
      void schemaFields;
      const [rows] = await bigquery.query(sqlRaw);
      return { op: 'selectTable', rows: sortRows(rows as Record<string, unknown>[]) };
    }
  }
}

async function main(): Promise<void> {
  const projectId = process.env['BQ_PROJECT_ID'] ?? 'stg-drops-1';
  console.log(`Capturing gRPC Storage Write fixtures against project ${projectId}`);

  const bigquery = new BigQuery({ projectId });
  const writeClient = new bigqueryStorage.BigQueryWriteClient({ projectId });

  await ensureDataset(bigquery);

  const fixtures = await loadFixtures();
  if (fixtures.length === 0) {
    console.log('No fixtures to capture.');
    return;
  }

  for (const { name, input } of fixtures) {
    process.stdout.write(`  ${name}: `);
    // Use a fresh UUID suffix so concurrent captures or stale state
    // from prior runs can't pollute the next attempt.
    const tableId = `t_${name.replace(/-/g, '_')}_${randomUUID().slice(0, 8)}`;
    try {
      const captured = await captureFixture(bigquery, writeClient, projectId, tableId, input);
      const outPath = path.join(FIXTURES_DIR, `${name}.captured.json`);
      await writeFile(outPath, `${JSON.stringify(captured, null, 2)}\n`, 'utf8');
      console.log('captured');
    } catch (err) {
      console.log(`FAILED — ${(err as Error).message}`);
    }
  }
}

await main();

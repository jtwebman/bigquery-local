#!/usr/bin/env node
/**
 * Manual capture script for the BQ-vs-emulator conformance suite.
 *
 *   BQ_PROJECT_ID=stg-drops-1 npm run conformance:capture
 *
 * Reads every `fixtures/*.sql` file, runs the SQL against real
 * BigQuery (via the local `gcloud auth application-default login`
 * credentials), canonicalizes the response, and writes a sibling
 * `.json` file. CI never runs this — refresh on demand.
 *
 * Defaults: BQ_PROJECT_ID=stg-drops-1, location=US.
 *
 * If a sibling `.meta.json` exists with a `sortRowsBy` key, it
 * controls row sort order in the captured fixture.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleAuth } from 'google-auth-library';
import { canonicalizeQueryResponse } from '../test/conformance/bq-replay-canonicalize.ts';

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'conformance',
  'bq-fixtures',
);

interface FixtureMeta {
  readonly sortRowsBy?: string;
  readonly numericRoundUnit?: number;
}

async function loadMeta(metaPath: string): Promise<FixtureMeta> {
  try {
    const raw = await readFile(metaPath, 'utf8');
    return JSON.parse(raw) as FixtureMeta;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const projectId = process.env.BQ_PROJECT_ID ?? 'stg-drops-1';
  const location = process.env.BQ_LOCATION ?? 'US';
  console.log(`Capturing against BigQuery project ${projectId} (location=${location})`);

  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/bigquery'],
  });
  const client = await auth.getClient();

  const entries = await readdir(FIXTURES_DIR);
  const sqlFiles = entries.filter((e) => e.endsWith('.sql')).sort();
  if (sqlFiles.length === 0) {
    console.log('No fixtures to capture.');
    return;
  }

  let captured = 0;
  let failed = 0;

  const queryUrl = `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/queries`;

  for (const file of sqlFiles) {
    const stem = file.slice(0, -4);
    const sql = (await readFile(path.join(FIXTURES_DIR, file), 'utf8')).trim();
    const meta = await loadMeta(path.join(FIXTURES_DIR, `${stem}.meta.json`));
    process.stdout.write(`  ${stem} ... `);
    try {
      // Hit jobs.query directly so we get the raw wire response —
      // identical shape to what the emulator returns.
      const res = await client.request<unknown>({
        url: queryUrl,
        method: 'POST',
        data: {
          query: sql,
          location,
          useLegacySql: false,
          // Modern wire format used by every official client by default.
          // Without it BQ returns seconds-as-double for TIMESTAMP, which
          // no one consumes anymore.
          formatOptions: { useInt64Timestamp: true },
        },
      });
      const canonical = canonicalizeQueryResponse(res.data, {
        ...(meta.sortRowsBy !== undefined && { sortRowsBy: meta.sortRowsBy }),
        ...(meta.numericRoundUnit !== undefined && { numericRoundUnit: meta.numericRoundUnit }),
      });
      const out = {
        _meta: {
          capturedAt: new Date().toISOString(),
          ...(meta.sortRowsBy !== undefined && { sortRowsBy: meta.sortRowsBy }),
          ...(meta.numericRoundUnit !== undefined && { numericRoundUnit: meta.numericRoundUnit }),
        },
        ...canonical,
      };
      await writeFile(path.join(FIXTURES_DIR, `${stem}.json`), `${JSON.stringify(out, null, 2)}\n`);
      console.log('captured');
      captured += 1;
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message}`);
      failed += 1;
    }
  }

  console.log(`\nCaptured ${captured} fixture(s); ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

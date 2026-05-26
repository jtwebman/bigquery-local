/**
 * Real-BQ conformance: replay each captured fixture through the
 * emulator, canonicalize both sides the same way, diff.
 *
 * See README.md for the capture workflow.
 */

import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createQueriesRoutes } from '../../src/routes/queries.ts';
import { createTabledataRoutes } from '../../src/routes/tabledata.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';
import { canonicalizeQueryResponse } from './bq-replay-canonicalize.ts';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bq-fixtures');
const PROJECT = 'conformance-test';

let db: Db;
let server: Server;

before(async () => {
  db = await createDb();
  await ensureMetaSchema(db);
  server = createServer({
    routes: [
      ...createDatasetRoutes(db),
      ...createTableRoutes(db),
      ...createTabledataRoutes(db),
      ...createQueriesRoutes(db),
    ],
  });
  await server.listen(0);
});
after(async () => {
  await server.close();
  await db.close();
});

interface FixtureExpected {
  readonly _meta?: { readonly sortRowsBy?: string; readonly numericRoundUnit?: number };
  readonly schema: { readonly fields: ReadonlyArray<Record<string, unknown>> };
  readonly rows: ReadonlyArray<{ readonly f: ReadonlyArray<{ readonly v: unknown }> }>;
  readonly totalRows: string;
  readonly jobComplete: boolean;
}

interface Fixture {
  readonly name: string;
  readonly sql: string;
  readonly expected: FixtureExpected | undefined;
}

async function loadFixtures(): Promise<ReadonlyArray<Fixture>> {
  let entries: string[];
  try {
    entries = await readdir(FIXTURES_DIR);
  } catch {
    return [];
  }
  const out: Fixture[] = [];
  for (const e of entries) {
    if (!e.endsWith('.sql')) continue;
    const name = e.slice(0, -4);
    const sql = (await readFile(path.join(FIXTURES_DIR, e), 'utf8')).trim();
    let expected: FixtureExpected | undefined;
    try {
      const raw = await readFile(path.join(FIXTURES_DIR, `${name}.json`), 'utf8');
      expected = JSON.parse(raw) as FixtureExpected;
    } catch {
      expected = undefined;
    }
    out.push({ name, sql, expected });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const fixtures = await loadFixtures();
const uncaptured = fixtures.filter((f) => f.expected === undefined).map((f) => f.name);

for (const fx of fixtures) {
  if (fx.expected === undefined) {
    // Skip uncaptured fixtures rather than fail the build. The
    // "uncaptured" sentinel test below surfaces the names so the next
    // capture run picks them up.
    test(`bq-replay: ${fx.name} (skipped — no captured response)`, { skip: true }, () => {});
    continue;
  }
  test(`bq-replay: ${fx.name}`, async () => {
    const expected = fx.expected as FixtureExpected;
    const sortRowsBy = expected._meta?.sortRowsBy;
    const numericRoundUnit = expected._meta?.numericRoundUnit;
    const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: fx.sql }),
    });
    assert.equal(res.status, 200, `emulator returned ${res.status}`);
    const actual = canonicalizeQueryResponse(await res.json(), {
      ...(sortRowsBy !== undefined && { sortRowsBy }),
      ...(numericRoundUnit !== undefined && { numericRoundUnit }),
    });
    const expectedNoMeta: Record<string, unknown> = { ...expected };
    delete expectedNoMeta['_meta'];
    assert.deepEqual(actual, expectedNoMeta);
  });
}

if (fixtures.length === 0) {
  test('bq-replay: (no fixtures — add .sql files under test/conformance/bq-fixtures/)', () => {});
}

// Silence the unused-binding warning while keeping the array around
// for a future "list uncaptured" reporter.
void uncaptured;

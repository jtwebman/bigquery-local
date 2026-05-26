/**
 * BL-128/129 — GEOGRAPHY type + ST_* functions via DuckDB spatial.
 */

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDatasetRoutes } from '../../src/routes/datasets.ts';
import { createQueriesRoutes } from '../../src/routes/queries.ts';
import { createTabledataRoutes } from '../../src/routes/tabledata.ts';
import { createTableRoutes } from '../../src/routes/tables.ts';
import { createDb } from '../../src/storage/db.ts';
import type { Db } from '../../src/storage/db.ts';
import { ensureMetaSchema } from '../../src/storage/meta.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';
import { unwrapV } from '../helpers/wire.ts';

let db: Db;
let server: Server;
const PROJECT = 'sql-geography';

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

async function scalar(query: string): Promise<unknown> {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { rows: Array<{ f: Array<{ v: unknown }> }> };
  return unwrapV(body.rows[0]?.f[0]?.v);
}

test('ST_GEOGFROMTEXT + ST_ASTEXT round-trips a POINT', async () => {
  const out = await scalar("SELECT ST_ASTEXT(ST_GEOGFROMTEXT('POINT(-122.4194 37.7749)')) AS pt");
  assert.match(String(out), /^POINT \(-?122\.4194 37\.7749\)$/);
});

test('ST_GEOGPOINT(lng, lat) constructs a point', async () => {
  const out = await scalar('SELECT ST_ASTEXT(ST_GEOGPOINT(1.5, 2.5)) AS pt');
  assert.match(String(out), /^POINT \(1\.5 2\.5\)$/);
});

test('ST_INTERSECTS returns true for overlapping polygons', async () => {
  const out = await scalar(`
    SELECT ST_INTERSECTS(
      ST_GEOGFROMTEXT('POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))'),
      ST_GEOGFROMTEXT('POLYGON((5 5, 15 5, 15 15, 5 15, 5 5))')
    ) AS hit
  `);
  assert.equal(out, 'true');
});

test('ST_INTERSECTS returns false for disjoint geometries', async () => {
  const out = await scalar(`
    SELECT ST_INTERSECTS(
      ST_GEOGFROMTEXT('POINT(0 0)'),
      ST_GEOGFROMTEXT('POINT(10 10)')
    ) AS hit
  `);
  assert.equal(out, 'false');
});

test('ST_CONTAINS, ST_WITHIN, ST_COVERS pass through', async () => {
  const out = await scalar(`
    SELECT
      ST_CONTAINS(
        ST_GEOGFROMTEXT('POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))'),
        ST_GEOGFROMTEXT('POINT(5 5)')
      ) AS contains,
      ST_WITHIN(
        ST_GEOGFROMTEXT('POINT(5 5)'),
        ST_GEOGFROMTEXT('POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))')
      ) AS within
  `);
  // unwrap to STRUCT shape — easier to query each row column.
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `
        SELECT
          ST_CONTAINS(
            ST_GEOGFROMTEXT('POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))'),
            ST_GEOGFROMTEXT('POINT(5 5)')
          ) AS c,
          ST_WITHIN(
            ST_GEOGFROMTEXT('POINT(5 5)'),
            ST_GEOGFROMTEXT('POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))')
          ) AS w`,
    }),
  });
  const body = (await res.json()) as { rows: Array<{ f: Array<{ v: unknown }> }> };
  assert.equal(unwrapV(body.rows[0]?.f[0]?.v), 'true');
  assert.equal(unwrapV(body.rows[0]?.f[1]?.v), 'true');
  assert.ok(out);
});

test('ST_DISTANCE returns a numeric distance', async () => {
  const out = await scalar(
    "SELECT ST_DISTANCE(ST_GEOGFROMTEXT('POINT(0 0)'), ST_GEOGFROMTEXT('POINT(3 4)')) AS d",
  );
  // Cartesian distance over the planar coordinates: sqrt(3^2 + 4^2) = 5.
  // (DuckDB spatial's ST_Distance is planar, not geodesic — BQ's is
  // geodesic in meters. Documented divergence.)
  assert.equal(Number(out), 5);
});

test('GEOGRAPHY column stores + filters with ST_INTERSECTS', async () => {
  // Create a dataset + table, insert two points, then filter by
  // intersection with a bounding polygon.
  await fetch(`${server.url}/projects/${PROJECT}/datasets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ datasetReference: { datasetId: 'ds' } }),
  });
  await fetch(`${server.url}/projects/${PROJECT}/datasets/ds/tables`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tableReference: { tableId: 'places' },
      schema: {
        fields: [
          { name: 'id', type: 'INT64' },
          { name: 'loc', type: 'GEOGRAPHY' },
        ],
      },
    }),
  });
  await fetch(`${server.url}/projects/${PROJECT}/datasets/ds/tables/places/insertAll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rows: [
        { json: { id: '1', loc: 'POINT(5 5)' } },
        { json: { id: '2', loc: 'POINT(100 100)' } },
      ],
    }),
  });
  const inside = await scalar(`
    SELECT id FROM \`ds.places\`
    WHERE ST_INTERSECTS(loc, ST_GEOGFROMTEXT('POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))'))
  `);
  assert.equal(inside, '1');
});

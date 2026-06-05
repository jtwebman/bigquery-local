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
  // BQ WKT has no space after the type keyword.
  assert.match(String(out), /^POINT\(-?122\.4194 37\.7749\)$/);
});

test('ST_GEOGPOINT(lng, lat) constructs a point', async () => {
  const out = await scalar('SELECT ST_ASTEXT(ST_GEOGPOINT(1.5, 2.5)) AS pt');
  assert.match(String(out), /^POINT\(1\.5 2\.5\)$/);
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

test('ST_DISTANCE returns geodesic distance in meters (BQ semantics)', async () => {
  const out = await scalar(
    "SELECT ST_DISTANCE(ST_GEOGFROMTEXT('POINT(0 0)'), ST_GEOGFROMTEXT('POINT(3 4)')) AS d",
  );
  // Haversine on a sphere with R = 6371010.0 m (S2 / BQ).
  assert.ok(Math.abs(Number(out) - 555812.6) < 1, `expected ~555812.6 m, got ${out}`);
});

test('ST_DISTANCE matches BQ bit-exact for SF → NYC', async () => {
  const out = await scalar(`
    SELECT ST_DISTANCE(
      ST_GEOGPOINT(-122.4194, 37.7749),
      ST_GEOGPOINT(-73.9857, 40.7484)
    ) AS m
  `);
  // BQ returns 4129968.4780220212 m for this pair (S2 great-circle
  // distance with R=6371010.0). We match to FP rounding noise.
  assert.ok(Math.abs(Number(out) - 4129968.478) < 0.001, `expected ~4129968.478 m, got ${out}`);
});

test('ST_DWITHIN uses geodesic meters for the radius', async () => {
  const out = await scalar(`
    SELECT ST_DWITHIN(
      ST_GEOGPOINT(0, 0),
      ST_GEOGPOINT(0.001, 0),
      200
    ) AS within
  `);
  // 0.001° longitude at equator ≈ 111 m, well under the 200 m radius.
  assert.equal(out, 'true');
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

test('selecting a GEOGRAPHY column directly returns its WKT text', async () => {
  // Reading the stored geometry back as a result column must not hit DuckDB's
  // JS materializer with a raw GEOMETRY value (which throws "Unexpected type
  // id: 40") — it has to come back as BQ WKT, like the table-read path.
  const out = await scalar('SELECT loc FROM `ds.places` WHERE id = 1');
  assert.equal(out, 'POINT(5 5)');
});

test('SELECT * over a table with a GEOGRAPHY column returns WKT for that column', async () => {
  const res = await fetch(`${server.url}/projects/${PROJECT}/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'SELECT * FROM `ds.places` ORDER BY id' }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { rows: Array<{ f: Array<{ v: unknown }> }> };
  // Row order: id, loc (table schema order).
  assert.equal(unwrapV(body.rows[0]?.f[0]?.v), '1');
  assert.equal(unwrapV(body.rows[0]?.f[1]?.v), 'POINT(5 5)');
});

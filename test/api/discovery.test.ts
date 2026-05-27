import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { BigQuery } from '@google-cloud/bigquery';

import { BQ_DISCOVERY_PATH, DISCOVERY_PATH, discoveryRoutes } from '../../src/routes/discovery.ts';
import { createRouterServer as createServer } from '../../src/server.ts';
import type { Server } from '../../src/types.ts';

let server: Server;

before(async () => {
  server = createServer({ routes: discoveryRoutes });
  await server.listen(0);
});

after(async () => {
  await server.close();
});

test(`GET ${DISCOVERY_PATH} returns the discovery document`, async () => {
  const res = await fetch(`${server.url}${DISCOVERY_PATH}`);
  assert.equal(res.status, 200);
  const doc = (await res.json()) as Record<string, unknown>;
  assert.equal(doc['name'], 'bigquery');
  assert.equal(doc['version'], 'v2');
  assert.equal(doc['kind'], 'discovery#restDescription');
  assert.equal(doc['protocol'], 'rest');
});

test('discovery doc declares the expected top-level keys', async () => {
  const res = await fetch(`${server.url}${DISCOVERY_PATH}`);
  const doc = (await res.json()) as Record<string, unknown>;
  for (const key of [
    'discoveryVersion',
    'id',
    'title',
    'description',
    'baseUrl',
    'basePath',
    'rootUrl',
    'servicePath',
    'resources',
  ]) {
    assert.ok(key in doc, `expected key "${key}" on the discovery document`);
  }
});

test('discovery doc is served with application/json content-type', async () => {
  const res = await fetch(`${server.url}${DISCOVERY_PATH}`);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
});

test(`GET ${BQ_DISCOVERY_PATH} (the bq CLI path) returns the same document`, async () => {
  const res = await fetch(`${server.url}${BQ_DISCOVERY_PATH}?version=v2`);
  assert.equal(res.status, 200);
  const doc = (await res.json()) as Record<string, unknown>;
  assert.equal(doc['name'], 'bigquery');
  assert.equal(doc['kind'], 'discovery#restDescription');
});

test('discovery doc rootUrl/baseUrl point back at the requesting host', async () => {
  const res = await fetch(`${server.url}${BQ_DISCOVERY_PATH}?version=v2`);
  const doc = (await res.json()) as Record<string, string>;
  const host = new URL(server.url).host;
  assert.equal(doc['rootUrl'], `http://${host}/`);
  assert.equal(doc['baseUrl'], `http://${host}/bigquery/v2/`);
});

test('discovery doc declares the resources a discovery-driven client needs', async () => {
  const res = await fetch(`${server.url}${DISCOVERY_PATH}`);
  const doc = (await res.json()) as { resources: Record<string, unknown> };
  for (const resource of ['datasets', 'tables', 'tabledata', 'jobs']) {
    assert.ok(resource in doc.resources, `expected resource "${resource}"`);
  }
});

test('@google-cloud/bigquery client constructs against the emulator without errors', () => {
  const bigQuery = new BigQuery({
    projectId: 'bigquery-local-test',
    apiEndpoint: server.url,
  });
  assert.ok(bigQuery);
  assert.equal(bigQuery.projectId, 'bigquery-local-test');
});

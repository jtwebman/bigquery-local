/**
 * Unit tests for the gRPC Storage Read/Write in-memory stores.
 *
 * The integration tests in `test/api/grpc-*` exercise the happy paths
 * through the wire layer; these tests pin the smaller corner cases of
 * the store APIs themselves (lookup misses, malformed stream names,
 * remove semantics) so refactors there get caught before they reach
 * the gRPC service code.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createSessionStore } from '../../src/grpc-impl/sessionStore.ts';
import type { SessionState } from '../../src/grpc-impl/sessionStore.ts';
import { createWriteStreamStore, parseStreamName } from '../../src/grpc-impl/writeStreamStore.ts';
import type { WriteStreamMeta, WriteStreamRuntime } from '../../src/grpc-impl/writeStreamStore.ts';

const SAMPLE_SESSION: SessionState = {
  name: 'projects/p/locations/us/sessions/00000000-0000-0000-0000-000000000001',
  project: 'p',
  datasetId: 'ds',
  tableId: 't',
  fields: [{ name: 'id', type: 'INT64', mode: 'REQUIRED' }],
  selectedFields: [],
  rowRestriction: '',
  streams: [
    {
      name: 'projects/p/locations/us/sessions/00000000-0000-0000-0000-000000000001/streams/0',
      offset: 0,
      size: 100,
    },
  ],
  dataFormat: 'AVRO',
  avroSchemaJson: '{"type":"record","name":"__root__","fields":[]}',
  expireMs: Date.now() + 60_000,
};

// -----------------------------------------------------------------------
// sessionStore
// -----------------------------------------------------------------------

test('sessionStore.put + getByName round-trips a session', () => {
  const store = createSessionStore();
  store.put(SAMPLE_SESSION);
  assert.equal(store.getByName(SAMPLE_SESSION.name)?.tableId, 't');
});

test('sessionStore.getByName returns undefined for an unknown name', () => {
  const store = createSessionStore();
  assert.equal(store.getByName('projects/p/locations/us/sessions/nope'), undefined);
});

test('sessionStore.getStream resolves a stream name to {session, stream}', () => {
  const store = createSessionStore();
  store.put(SAMPLE_SESSION);
  const streamName = SAMPLE_SESSION.streams[0]?.name as string;
  const hit = store.getStream(streamName);
  assert.ok(hit);
  assert.equal(hit?.session.name, SAMPLE_SESSION.name);
  assert.equal(hit?.stream.offset, 0);
});

test('sessionStore.getStream returns undefined for a malformed stream name', () => {
  const store = createSessionStore();
  store.put(SAMPLE_SESSION);
  assert.equal(store.getStream('not-a-stream-name'), undefined);
});

test('sessionStore.getStream returns undefined when the parent session is missing', () => {
  const store = createSessionStore();
  // Well-formed name but session never put().
  const orphan = 'projects/p/locations/us/sessions/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/streams/0';
  assert.equal(store.getStream(orphan), undefined);
});

test('sessionStore.getStream returns undefined when the session exists but the stream index is wrong', () => {
  const store = createSessionStore();
  store.put(SAMPLE_SESSION);
  const bogus = `${SAMPLE_SESSION.name}/streams/99`;
  assert.equal(store.getStream(bogus), undefined);
});

// -----------------------------------------------------------------------
// writeStreamStore
// -----------------------------------------------------------------------

const SAMPLE_META: WriteStreamMeta = {
  name: 'projects/p/datasets/ds/tables/t/streams/s-1',
  project: 'p',
  datasetId: 'ds',
  tableId: 't',
  fields: [{ name: 'id', type: 'INT64', mode: 'REQUIRED' }],
  type: 'PENDING',
  createMs: Date.now(),
};

test('writeStreamStore.create returns a runtime in ACTIVE state with zero offsets', () => {
  const store = createWriteStreamStore();
  const r: WriteStreamRuntime = store.create(SAMPLE_META);
  assert.equal(r.state, 'ACTIVE');
  assert.equal(r.offset, 0);
  assert.equal(r.flushedOffset, 0);
  assert.deepEqual(r.buffer, []);
  assert.equal(r.finalizedMs, null);
  assert.equal(r.committedMs, null);
});

test('writeStreamStore.get returns the runtime that was just create()d', () => {
  const store = createWriteStreamStore();
  const r = store.create(SAMPLE_META);
  assert.equal(store.get(SAMPLE_META.name), r);
});

test('writeStreamStore.get returns undefined for an unknown name', () => {
  const store = createWriteStreamStore();
  assert.equal(store.get('projects/p/datasets/ds/tables/t/streams/nope'), undefined);
});

test('writeStreamStore.remove drops an existing stream and returns true', () => {
  const store = createWriteStreamStore();
  store.create(SAMPLE_META);
  assert.equal(store.remove(SAMPLE_META.name), true);
  assert.equal(store.get(SAMPLE_META.name), undefined);
});

test('writeStreamStore.remove on an unknown name returns false', () => {
  const store = createWriteStreamStore();
  assert.equal(store.remove('projects/p/datasets/ds/tables/t/streams/nope'), false);
});

// -----------------------------------------------------------------------
// parseStreamName
// -----------------------------------------------------------------------

test('parseStreamName decomposes a well-formed stream resource name', () => {
  const out = parseStreamName('projects/p1/datasets/ds1/tables/t1/streams/s1');
  assert.deepEqual(out, {
    project: 'p1',
    datasetId: 'ds1',
    tableId: 't1',
    streamId: 's1',
  });
});

test('parseStreamName returns null for a malformed name', () => {
  assert.equal(parseStreamName('not/a/stream/name'), null);
  assert.equal(parseStreamName(''), null);
  assert.equal(parseStreamName('projects/p/datasets/ds/tables/t'), null);
});

/**
 * Coverage for the canonicalizer used by the gRPC Storage Read replay suite.
 *
 * These keep the comparison logic honest before any real-BQ captures land:
 *   - session/stream UUIDs and `expireTime` are removed
 *   - the table ref's project segment is masked so emulator
 *     `projects/test/...` matches a captured BQ `projects/stg-drops-1/...`
 *   - Avro schema strings are re-emitted with stable key ordering so
 *     trivial formatting differences don't break the comparison
 *   - batches of `ReadRowsResponse` are flattened into a single byte
 *     stream + total row count (chunking is free to differ)
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  canonicalizeCreateReadSession,
  canonicalizeReadRowsBatch,
  flattenReadRows,
} from '../../test/conformance/bq-storage-canonicalize.ts';

test('canonicalizeCreateReadSession masks the project and strips wall-clock fields', () => {
  const canonical = canonicalizeCreateReadSession({
    name: 'projects/stg-drops-1/locations/us/sessions/d54a-...',
    avroSchema: { schema: '{"type":"record","name":"t","fields":[]}' },
    dataFormat: 1,
    table: 'projects/stg-drops-1/datasets/ds/tables/t1',
    readOptions: { selectedFields: ['id'], rowRestriction: 'id > 0' },
    streams: [{ name: 'projects/stg-drops-1/locations/us/sessions/d54a/streams/0' }],
    estimatedRowCount: 42,
  });
  assert.equal(canonical.dataFormat, 'AVRO');
  assert.equal(canonical.estimatedRowCount, '42');
  assert.equal(canonical.hasStreams, true);
  assert.equal(canonical.table, 'projects/<PROJECT>/datasets/ds/tables/t1');
  assert.equal(canonical.avroSchema, '{"fields":[],"name":"t","type":"record"}');
  assert.deepEqual(canonical.readOptions, { selectedFields: ['id'], rowRestriction: 'id > 0' });
});

test('canonicalizeCreateReadSession handles string dataFormat enums and missing fields', () => {
  const canonical = canonicalizeCreateReadSession({
    dataFormat: 'AVRO',
    avroSchema: { schema: '' },
  });
  assert.equal(canonical.dataFormat, 'AVRO');
  assert.equal(canonical.estimatedRowCount, '0');
  assert.equal(canonical.hasStreams, false);
  assert.equal(canonical.table, '');
  assert.equal(canonical.avroSchema, '');
});

test('canonicalizeCreateReadSession surfaces ARROW and DATA_FORMAT_UNSPECIFIED', () => {
  assert.equal(
    canonicalizeCreateReadSession({ dataFormat: 2, avroSchema: { schema: '' } }).dataFormat,
    'ARROW',
  );
  assert.equal(
    canonicalizeCreateReadSession({ dataFormat: 0, avroSchema: { schema: '' } }).dataFormat,
    'DATA_FORMAT_UNSPECIFIED',
  );
});

test('canonicalizeReadRowsBatch converts raw bytes to base64', () => {
  const bytes = Buffer.from([0x01, 0x02, 0x03]);
  const canonical = canonicalizeReadRowsBatch({
    avroRows: { serializedBinaryRows: bytes, rowCount: 3 },
    avroSchema: { schema: '{}' },
    rowCount: 3,
    uncompressedByteSize: bytes.length,
  });
  assert.equal(canonical.rowCount, '3');
  assert.equal(canonical.uncompressedByteSize, '3');
  assert.equal(canonical.serializedBinaryRowsBase64, bytes.toString('base64'));
  assert.equal(canonical.hasAvroSchema, true);
});

test('canonicalizeReadRowsBatch passes through pre-base64 string bytes (avoiding double-encode)', () => {
  const canonical = canonicalizeReadRowsBatch({
    avroRows: { serializedBinaryRows: 'AQID', rowCount: 3 },
  });
  assert.equal(canonical.serializedBinaryRowsBase64, 'AQID');
  assert.equal(canonical.hasAvroSchema, false);
});

test('flattenReadRows concatenates batches into one canonical byte stream', () => {
  const flat = flattenReadRows([
    {
      rowCount: '2',
      uncompressedByteSize: '2',
      serializedBinaryRowsBase64: 'AQI=',
      serializedRecordBatchBase64: '',
      hasAvroSchema: true,
      hasArrowSchema: false,
    },
    {
      rowCount: '1',
      uncompressedByteSize: '1',
      serializedBinaryRowsBase64: 'Aw==',
      serializedRecordBatchBase64: '',
      hasAvroSchema: false,
      hasArrowSchema: false,
    },
  ]);
  // 0x01 0x02 0x03
  assert.equal(flat.serializedBinaryRowsBase64, Buffer.from([0x01, 0x02, 0x03]).toString('base64'));
  assert.equal(flat.schemaInFirst, true);
});

test('flattenReadRows handles empty input (no rows, no schema)', () => {
  const flat = flattenReadRows([]);
  assert.equal(flat.serializedBinaryRowsBase64, '');
  assert.equal(flat.schemaInFirst, false);
});

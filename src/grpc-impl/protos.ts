/**
 * protobuf-message accessors backed by the vendored
 * `src/grpc-gen/protos.json` descriptor (a precompiled JSON schema for
 * the entire BigQuery Storage v1 API, taken from the official
 * `@google-cloud/bigquery-storage` package).
 *
 * Load happens once at module import. The runtime cost is one JSON parse
 * + one Root.fromJSON call; subsequent lookups are constant-time.
 */

import protobuf from 'protobufjs';
import descriptor from '../grpc-gen/protos.json' with { type: 'json' };

const root = protobuf.Root.fromJSON(descriptor as protobuf.INamespace);

const V1 = 'google.cloud.bigquery.storage.v1';

export const CreateReadSessionRequest = root.lookupType(`${V1}.CreateReadSessionRequest`);
export const ReadSession = root.lookupType(`${V1}.ReadSession`);
export const ReadStream = root.lookupType(`${V1}.ReadStream`);
export const ReadRowsRequest = root.lookupType(`${V1}.ReadRowsRequest`);
export const ReadRowsResponse = root.lookupType(`${V1}.ReadRowsResponse`);

export const READ_PATH = (method: string): string =>
  `/google.cloud.bigquery.storage.v1.BigQueryRead/${method}`;

// BigQueryWrite (Phase 19).
export const AppendRowsRequest = root.lookupType(`${V1}.AppendRowsRequest`);
export const AppendRowsResponse = root.lookupType(`${V1}.AppendRowsResponse`);
export const CreateWriteStreamRequest = root.lookupType(`${V1}.CreateWriteStreamRequest`);
export const WriteStream = root.lookupType(`${V1}.WriteStream`);
export const FinalizeWriteStreamRequest = root.lookupType(`${V1}.FinalizeWriteStreamRequest`);
export const FinalizeWriteStreamResponse = root.lookupType(`${V1}.FinalizeWriteStreamResponse`);
export const BatchCommitWriteStreamsRequest = root.lookupType(
  `${V1}.BatchCommitWriteStreamsRequest`,
);
export const BatchCommitWriteStreamsResponse = root.lookupType(
  `${V1}.BatchCommitWriteStreamsResponse`,
);
export const FlushRowsRequest = root.lookupType(`${V1}.FlushRowsRequest`);
export const FlushRowsResponse = root.lookupType(`${V1}.FlushRowsResponse`);

export const WRITE_PATH = (method: string): string =>
  `/google.cloud.bigquery.storage.v1.BigQueryWrite/${method}`;

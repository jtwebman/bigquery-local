/**
 * gRPC port for the BigQuery Storage Read/Write APIs.
 *
 * Boots `@grpc/grpc-js`'s `Server`. If a `Db` is supplied, the
 * BigQueryRead service is registered (BL-117+). Any unregistered RPC —
 * including all of BigQueryWrite, plus Read RPCs not yet implemented —
 * falls through to grpc-js's built-in UNIMPLEMENTED response, which is
 * the canonical wire shape a real gRPC client expects.
 *
 * Reference:
 *   https://github.com/grpc/grpc/blob/master/doc/statuscodes.md  (12 = UNIMPLEMENTED)
 */

import * as grpc from '@grpc/grpc-js';

import { registerBigQueryRead } from './grpc-impl/bigQueryRead.ts';
import { registerBigQueryWrite } from './grpc-impl/bigQueryWrite.ts';
import type { Db } from './storage/db.ts';

/** gRPC canonical status code for UNIMPLEMENTED. */
export const GRPC_STATUS_UNIMPLEMENTED = 12;

export interface GrpcServerConfig {
  /** Bind address (default `0.0.0.0`). */
  readonly host?: string;
  /**
   * DuckDB instance to back service handlers. When omitted the server
   * boots as a pure UNIMPLEMENTED scaffold (no services registered).
   */
  readonly db?: Db;
}

export interface GrpcServer {
  /** Begin accepting connections. Port `0` (default) picks a random free port. */
  listen(port?: number): Promise<void>;
  /** Stop accepting connections and close all open sockets. */
  close(): Promise<void>;
  /** `host:port` once listening. Throws if the server is not currently listening. */
  readonly url: string;
}

export function createGrpcServer(config: GrpcServerConfig = {}): GrpcServer {
  const host = config.host ?? '0.0.0.0';
  let server: grpc.Server | null = null;
  let boundPort: number | null = null;

  return {
    async listen(port = 0): Promise<void> {
      if (server !== null) {
        throw new Error('gRPC server is already listening.');
      }
      const srv = new grpc.Server();
      if (config.db !== undefined) {
        registerBigQueryRead(srv, config.db);
        registerBigQueryWrite(srv, config.db);
      }
      const actualPort = await new Promise<number>((resolve, reject) => {
        srv.bindAsync(`${host}:${port}`, grpc.ServerCredentials.createInsecure(), (err, p) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(p);
        });
      });
      server = srv;
      boundPort = actualPort;
    },
    async close(): Promise<void> {
      const srv = server;
      if (srv === null) return;
      server = null;
      boundPort = null;
      await new Promise<void>((resolve) => {
        srv.tryShutdown(() => resolve());
      });
    },
    get url(): string {
      if (boundPort === null) {
        throw new Error('gRPC server is not listening.');
      }
      return `localhost:${boundPort}`;
    },
  };
}

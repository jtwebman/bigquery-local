/**
 * gRPC port — UNIMPLEMENTED for everything.
 *
 * The BigQuery Storage Read/Write APIs are gRPC, served on a separate
 * port (`--grpc-port`, default 9060). v0 of bigquery-local does not
 * implement any gRPC RPCs, but a *real* gRPC client (e.g.
 * `@google-cloud/bigquery-storage`) pointed at this port should get a
 * clean `UNIMPLEMENTED` error rather than a hung connection.
 *
 * Implementation: plaintext HTTP/2 (h2c) via `node:http2`, no grpc
 * library dep. For every stream we send a "trailers-only" response —
 * a single HEADERS frame carrying `:status: 200`, `content-type:
 * application/grpc`, `grpc-status: 12`, `grpc-message: ...` with
 * END_STREAM set. This is the canonical gRPC shape for synchronous
 * error responses and is what the official gRPC client libraries
 * expect.
 *
 * Reference:
 *   https://grpc.io/docs/guides/wire-protocol/  (HTTP/2 framing)
 *   https://github.com/grpc/grpc/blob/master/doc/statuscodes.md  (12 = UNIMPLEMENTED)
 */

import {
  type Http2Server,
  type ServerHttp2Stream,
  createServer as createHttp2Server,
} from 'node:http2';
import type { AddressInfo } from 'node:net';

/** gRPC canonical status code for UNIMPLEMENTED. */
export const GRPC_STATUS_UNIMPLEMENTED = 12;

export interface GrpcServerConfig {
  /** Override the `grpc-message` returned to clients. Optional. */
  readonly message?: string;
}

export interface GrpcServer {
  /** Begin accepting connections. Port `0` (default) picks a random free port. */
  listen(port?: number): Promise<void>;
  /** Stop accepting connections and close all open sockets. */
  close(): Promise<void>;
  /** `host:port` once listening. Throws if the server is not currently listening. */
  readonly url: string;
}

const DEFAULT_MESSAGE = 'bigquery-local v0 does not implement gRPC services';

export function createGrpcServer(config: GrpcServerConfig = {}): GrpcServer {
  const message = config.message ?? DEFAULT_MESSAGE;
  let http2Server: Http2Server | null = null;
  let boundPort: number | null = null;

  function onStream(stream: ServerHttp2Stream): void {
    // Trailers-only response: a single HEADERS frame with END_STREAM,
    // carrying both the response status and the gRPC trailers.
    stream.respond(
      {
        ':status': 200,
        'content-type': 'application/grpc',
        'grpc-status': String(GRPC_STATUS_UNIMPLEMENTED),
        'grpc-message': message,
      },
      { endStream: true },
    );
  }

  return {
    async listen(port = 0): Promise<void> {
      if (http2Server !== null) {
        throw new Error('gRPC server is already listening.');
      }
      const srv = createHttp2Server();
      srv.on('stream', onStream);
      // gRPC clients can hold connections open indefinitely. Swallow
      // socket errors (RST_STREAM, client aborts) so they don't bubble
      // up as uncaught exceptions during normal client behavior.
      srv.on('sessionError', () => {});
      srv.on('streamError', () => {});
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          srv.removeListener('error', onError);
          reject(err);
        };
        srv.once('error', onError);
        srv.listen(port, () => {
          srv.removeListener('error', onError);
          const addr = srv.address() as AddressInfo;
          http2Server = srv;
          boundPort = addr.port;
          resolve();
        });
      });
    },
    async close(): Promise<void> {
      const srv = http2Server;
      if (srv === null) return;
      http2Server = null;
      boundPort = null;
      await new Promise<void>((resolve, reject) => {
        srv.close((err) => {
          /* node:coverage ignore next 4 */
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
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

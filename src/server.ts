/**
 * HTTP integration — wires `node:http` into the pure router.
 *
 * `createRouterServer({ routes })` is the low-level building block: it
 * binds a `node:http` server to a route table and returns a `Server` handle
 * with `listen()`, `close()`, and a `url` getter for the bound base URL.
 * It does not own the database or know about any specific BigQuery routes.
 *
 * The public, batteries-included entry point is `createServer` in
 * `src/index.ts`, which builds the DB, wires every standard route, and
 * delegates to this function.
 *
 * Handlers can throw a `BqError` (from `src/util/errors.ts`) and it will be
 * serialized to the Google-shaped response body with the matching HTTP
 * status. Anything else thrown becomes a 500 `internalError`.
 */

import { createServer as createHttpServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync, inflateSync } from 'node:zlib';

import { compileRoutes, matchRoute, parseQueryString } from './router.ts';
import type { RouteRequest, RouteResponse, Server, ServerConfig } from './types.ts';
import { BqError } from './util/errors.ts';

export type {
  Handler,
  RouteDefinition,
  RouteRequest,
  RouteResponse,
  Server,
  ServerConfig,
} from './types.ts';
export { BqError } from './util/errors.ts';
export type { BqErrorBody, BqErrorEntry, BqErrorReason } from './util/errors.ts';

const NOT_FOUND_RESPONSE: RouteResponse = {
  status: 404,
  body: BqError.notFound('Route not found.').toResponseBody(),
};

function sendBqError(res: ServerResponse, err: BqError): void {
  send(res, { status: err.code, body: err.toResponseBody() });
}

export function createRouterServer(config: ServerConfig = {}): Server {
  const compiled = compileRoutes(config.routes ?? []);
  let httpServer: HttpServer | null = null;
  let boundPort: number | null = null;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // req.url and req.method are always defined for server-side IncomingMessage
    // (the IncomingMessage type also covers the client side, where they're optional).
    const url = new URL(req.url as string, 'http://localhost');
    const method = (req.method as string).toUpperCase();
    const headers = normalizeHeaders(req.headers);

    let body: unknown;
    try {
      body = await readBody(req, headers['content-type'] ?? '', headers['content-encoding'] ?? '');
    } catch (err) {
      // readBody only throws BqError (with reason: 'invalid').
      sendBqError(res, err as BqError);
      return;
    }

    // The @google-cloud/bigquery client prefixes its URLs with `/bigquery/v2/`
    // (and the @google-cloud/storage style with `/storage/v1/`, etc). For the
    // BQ emulator we strip the `/bigquery/v2` prefix if present so a single
    // route table works for both raw HTTP callers and the official client.
    const rawPath = url.pathname;
    const path =
      rawPath.startsWith('/bigquery/v2/') || rawPath === '/bigquery/v2'
        ? rawPath.slice('/bigquery/v2'.length) || '/'
        : rawPath;

    const match = matchRoute(compiled, method, path);
    if (match === null) {
      send(res, NOT_FOUND_RESPONSE);
      return;
    }

    const request: RouteRequest = {
      method,
      path,
      params: match.params,
      query: parseQueryString(url.search),
      headers,
      body,
    };

    try {
      const response = await match.route.handler(request);
      send(res, response);
    } catch (err) {
      const bqErr =
        err instanceof BqError
          ? err
          : BqError.internalError(err instanceof Error ? err.message : 'Internal error');
      sendBqError(res, bqErr);
    }
  }

  return {
    async listen(port = 0): Promise<void> {
      if (httpServer !== null) {
        throw new Error('Server is already listening.');
      }
      const srv = createHttpServer((req, res) => {
        void handle(req, res);
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          srv.removeListener('error', onError);
          reject(err);
        };
        srv.once('error', onError);
        srv.listen(port, () => {
          srv.removeListener('error', onError);
          const addr = srv.address() as AddressInfo;
          httpServer = srv;
          boundPort = addr.port;
          resolve();
        });
      });
    },
    async close(): Promise<void> {
      const srv = httpServer;
      if (srv === null) return;
      httpServer = null;
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
        throw new Error('Server is not listening.');
      }
      return `http://localhost:${boundPort}`;
    },
  };
}

async function readBody(
  req: IncomingMessage,
  contentType: string,
  contentEncoding: string,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  // The Java BigQuery client gzips request bodies (and real BQ accepts it),
  // so honor Content-Encoding before reading the body as text.
  const raw = Buffer.concat(chunks);
  const encoding = contentEncoding.toLowerCase().trim();
  let decoded: Buffer;
  try {
    decoded =
      encoding === 'gzip' ? gunzipSync(raw) : encoding === 'deflate' ? inflateSync(raw) : raw;
  } catch {
    throw BqError.invalid(`Could not decode ${encoding} request body.`);
  }
  const text = decoded.toString('utf8');
  const isJson = contentType.toLowerCase().includes('application/json');
  if (!isJson) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    // JSON.parse always throws a SyntaxError (a subclass of Error).
    throw BqError.invalid(`Invalid JSON: ${(err as Error).message}`);
  }
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(headers)) {
    if (raw === undefined) continue;
    // `raw` is `string | string[]`; the `flat().join(', ')` covers both shapes
    // without an explicit Array.isArray branch.
    out[key.toLowerCase()] = [raw].flat().join(', ');
  }
  return out;
}

function send(res: ServerResponse, response: RouteResponse): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    ...(response.headers ?? {}),
  };
  res.writeHead(response.status, headers);
  if (response.body === undefined) {
    res.end();
  } else {
    res.end(JSON.stringify(response.body));
  }
}

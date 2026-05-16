/**
 * HTTP integration — wires `node:http` into the pure router.
 *
 * `createServer({ routes })` returns a `Server` handle with `listen()`,
 * `close()`, and a `url` getter for the bound base URL. Routes registered at
 * construction time receive parsed JSON bodies and decoded path parameters.
 *
 * Handlers can throw a `BqError` (from `src/util/errors.ts`) and it will be
 * serialized to the Google-shaped response body with the matching HTTP
 * status. Anything else thrown becomes a 500 `internalError`.
 */

import { createServer as createHttpServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

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

export function createServer(config: ServerConfig = {}): Server {
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
      body = await readBody(req, headers['content-type'] ?? '');
    } catch (err) {
      // readBody only throws BqError (with reason: 'invalid').
      sendBqError(res, err as BqError);
      return;
    }

    const match = matchRoute(compiled, method, url.pathname);
    if (match === null) {
      send(res, NOT_FOUND_RESPONSE);
      return;
    }

    const request: RouteRequest = {
      method,
      path: url.pathname,
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

async function readBody(req: IncomingMessage, contentType: string): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString('utf8');
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

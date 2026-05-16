/**
 * Public types for the bigquery-local server and router.
 *
 * Kept in a dedicated module so router.ts and server.ts can both depend on
 * them without forming a cycle.
 */

export interface RouteRequest {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface RouteResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type Handler = (req: RouteRequest) => Promise<RouteResponse> | RouteResponse;

export interface RouteDefinition {
  readonly method: string;
  readonly path: string;
  readonly handler: Handler;
}

export interface ServerConfig {
  readonly routes?: readonly RouteDefinition[];
}

export interface Server {
  /** Begin accepting connections. Port `0` (default) picks a random free port. */
  listen(port?: number): Promise<void>;
  /** Stop accepting connections and close all open sockets. */
  close(): Promise<void>;
  /** Base URL once listening. Throws if the server is not currently listening. */
  readonly url: string;
}

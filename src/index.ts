/**
 * Public library entrypoint for `bigquery-local`.
 *
 *   import { createServer, BqError } from 'bigquery-local';
 *
 *   const server = await createServer({ database: ':memory:' });
 *   await server.listen(0);
 *   // ...point any BigQuery client at server.url, across any project ids...
 *   await server.close(); // also closes the DB
 *
 * Matches real BigQuery's multi-tenant model: one server serves any project
 * id; projects are isolated by URL path (`/projects/{p}/...`), not by server
 * config. The CLI's `--project` flag is informational only.
 *
 * Re-exports `BqError` and its types so consumers can match on `reason` or
 * narrow on `instanceof` in their own code.
 */

import { createDatasetRoutes } from './routes/datasets.ts';
import { discoveryRoutes } from './routes/discovery.ts';
import { createJobsRoutes } from './routes/jobs.ts';
import { createQueriesRoutes } from './routes/queries.ts';
import { createTabledataRoutes } from './routes/tabledata.ts';
import { createTableRoutes } from './routes/tables.ts';
import { createRouterServer } from './server.ts';
import { createDb } from './storage/db.ts';
import { ensureMetaSchema } from './storage/meta.ts';
import type { Server } from './types.ts';

export { BqError } from './util/errors.ts';
export type { BqErrorBody, BqErrorEntry, BqErrorReason } from './util/errors.ts';
export type { Server } from './types.ts';
export { GRPC_STATUS_UNIMPLEMENTED, createGrpcServer } from './grpc.ts';
export type { GrpcServer, GrpcServerConfig } from './grpc.ts';
export { EmulatorAuthClient, emulatorGoogleAuth } from './client.ts';

export interface ServerConfig {
  /**
   * DuckDB file path, or `:memory:` (the default) for a transient
   * in-memory database. The returned server owns this database — its
   * `close()` method closes both the HTTP listener and the DB.
   */
  readonly database?: string;
}

/**
 * Build a bigquery-local server with every standard route wired and a fresh
 * DuckDB instance underneath. `await server.listen(0)` to bind a free port,
 * then point a BigQuery client at `server.url`.
 */
export async function createServer(config: ServerConfig = {}): Promise<Server> {
  const db = await createDb({ path: config.database ?? ':memory:' });
  await ensureMetaSchema(db);

  const inner = createRouterServer({
    routes: [
      ...discoveryRoutes,
      ...createDatasetRoutes(db),
      ...createTableRoutes(db),
      ...createTabledataRoutes(db),
      ...createQueriesRoutes(db),
      ...createJobsRoutes(db),
    ],
  });

  return {
    listen: (port?: number) => inner.listen(port),
    async close(): Promise<void> {
      await inner.close();
      await db.close();
    },
    get url(): string {
      return inner.url;
    },
  };
}

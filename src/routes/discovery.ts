/**
 * Discovery document endpoint.
 *
 * Serves the bundled BigQuery v2 discovery document at the two paths clients
 * fetch it from:
 *   - `/discovery/v1/apis/bigquery/v2/rest` (the google-api-client path; also
 *     used by container healthchecks)
 *   - `/$discovery/rest?version=v2` (the path the `bq` CLI and other
 *     discovery-driven tools request relative to `--api`)
 *
 * `discovery.json` is the upstream Google document, committed verbatim, so the
 * `bq` CLI can build its full API client. We never fetch it from Google at
 * runtime. `rootUrl`/`baseUrl` are rewritten per request to point back at this
 * emulator (the listening host/port, which is dynamic under `--port=0`), so
 * clients send their requests here rather than to googleapis.com.
 */

import type { Handler, RouteDefinition } from '../types.ts';
import discoveryDoc from './discovery.json' with { type: 'json' };

export const DISCOVERY_PATH = '/discovery/v1/apis/bigquery/v2/rest';
export const BQ_DISCOVERY_PATH = '/$discovery/rest';

const handler: Handler = (req) => {
  const host = req.headers['host'] ?? 'localhost';
  const root = `http://${host}/`;
  return {
    status: 200,
    body: {
      ...discoveryDoc,
      rootUrl: root,
      baseUrl: `${root}bigquery/v2/`,
      mtlsRootUrl: root,
    },
  };
};

export const discoveryRoutes: readonly RouteDefinition[] = [
  { method: 'GET', path: DISCOVERY_PATH, handler },
  { method: 'GET', path: BQ_DISCOVERY_PATH, handler },
];

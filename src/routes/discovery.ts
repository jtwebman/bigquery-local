/**
 * Discovery document endpoint.
 *
 * `GET /discovery/v1/apis/bigquery/v2/rest` returns the bundled
 * `discovery.json` — a minimal but valid Google Discovery Document
 * describing this emulator. Used by some BigQuery clients for sanity
 * checks, and by container healthchecks (e.g.
 * `wget -qO- http://localhost:9050/discovery/v1/apis/bigquery/v2/rest`).
 *
 * The document is committed in the repo; it is never fetched from
 * Google at runtime. Resources are intentionally empty at v0 and grow
 * as concrete endpoints land.
 */

import type { RouteDefinition } from '../types.ts';
import discoveryDoc from './discovery.json' with { type: 'json' };

export const DISCOVERY_PATH = '/discovery/v1/apis/bigquery/v2/rest';

export const discoveryRoutes: readonly RouteDefinition[] = [
  {
    method: 'GET',
    path: DISCOVERY_PATH,
    handler: () => ({ status: 200, body: discoveryDoc }),
  },
];

/**
 * Projects REST endpoints (BL-073).
 *
 *   GET /projects                                list projects the caller can see
 *   GET /projects/{p}/serviceAccount             return a fake BQ service account
 *
 * BigQuery's `projects.list` reflects what the caller has access to; the
 * emulator has no auth, so we return every project that has datasets,
 * deduplicated. The official client's `getProjects()` consumes this.
 *
 * `projects.getServiceAccount` returns the IAM email BigQuery uses on
 * behalf of the project (real-world: `bq-<numericId>@bigquery-encryption.iam.gserviceaccount.com`).
 * Locally we synthesize a deterministic emulator-shaped value.
 */

import type { Db } from '../storage/db.ts';
import { listProjects } from '../storage/meta.ts';
import type { RouteDefinition, RouteResponse } from '../types.ts';
import { BqError } from '../util/errors.ts';

interface ProjectListEntryWire {
  readonly kind: 'bigquery#project';
  readonly id: string;
  readonly numericId: string;
  readonly projectReference: { readonly projectId: string };
  readonly friendlyName: string;
}

interface ProjectListWire {
  readonly kind: 'bigquery#projectList';
  readonly etag: string;
  readonly projects: readonly ProjectListEntryWire[];
  readonly totalItems: number;
  readonly nextPageToken?: string;
}

interface ServiceAccountWire {
  readonly kind: 'bigquery#getServiceAccountResponse';
  readonly email: string;
}

const LIST_DEFAULT_PAGE_SIZE = 50;
const LIST_MAX_PAGE_SIZE = 1000;

function parseMaxResults(value: string | undefined): number {
  if (value === undefined) return LIST_DEFAULT_PAGE_SIZE;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw BqError.invalid('maxResults must be a positive integer.', 'maxResults');
  }
  return Math.min(parsed, LIST_MAX_PAGE_SIZE);
}

function parsePageToken(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw BqError.invalid('pageToken is malformed.', 'pageToken');
  }
  return parsed;
}

function projectToEntry(projectId: string): ProjectListEntryWire {
  return {
    kind: 'bigquery#project',
    id: projectId,
    // Real BQ's numeric id is the GCP project number; we don't have one
    // so synthesize a deterministic stand-in from the projectId hash.
    numericId: String(syntheticNumericId(projectId)),
    projectReference: { projectId },
    friendlyName: projectId,
  };
}

function syntheticNumericId(projectId: string): number {
  // Deterministic 9-digit stand-in. Doesn't have to be globally unique —
  // it just needs to be a number-shaped string so clients that parse the
  // `numericId` as a uint64 don't choke.
  let hash = 0;
  for (let i = 0; i < projectId.length; i += 1) {
    hash = (hash * 31 + projectId.charCodeAt(i)) >>> 0;
  }
  // Clamp to 9 digits so it fits comfortably in JS number range.
  return 100000000 + (hash % 900000000);
}

export function createProjectRoutes(db: Db): readonly RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/projects',
      handler: async (req) => {
        const maxResults = parseMaxResults(req.query['maxResults']);
        const offset = parsePageToken(req.query['pageToken']);
        const { projects, nextOffset } = await listProjects(db, {
          offset,
          limit: maxResults,
        });
        const body: ProjectListWire = {
          kind: 'bigquery#projectList',
          etag: `projects:${offset}:${maxResults}:${projects.length}`,
          projects: projects.map(projectToEntry),
          totalItems: projects.length,
          ...(nextOffset !== null && { nextPageToken: String(nextOffset) }),
        };
        return { status: 200, body } satisfies RouteResponse;
      },
    },
    {
      method: 'GET',
      path: '/projects/{p}/serviceAccount',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const body: ServiceAccountWire = {
          kind: 'bigquery#getServiceAccountResponse',
          // Deterministic emulator-shaped address — distinct per project so
          // tests can pin on it without colliding across projects.
          email: `bq-${syntheticNumericId(project)}@bigquery-local.iam.gserviceaccount.invalid`,
        };
        return { status: 200, body } satisfies RouteResponse;
      },
    },
  ];
}

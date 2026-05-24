# bigquery-local

[![npm](https://img.shields.io/npm/v/bigquery-local?label=npm)](https://www.npmjs.com/package/bigquery-local)
[![Docker Hub](https://img.shields.io/docker/v/jtwebman/bigquery-local?label=Docker%20Hub&sort=semver)](https://hub.docker.com/r/jtwebman/bigquery-local)
[![Image size](https://img.shields.io/docker/image-size/jtwebman/bigquery-local/latest?label=image%20size)](https://hub.docker.com/r/jtwebman/bigquery-local)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Node.js, Docker-friendly local emulator for the Google BigQuery REST
API, backed by [DuckDB](https://duckdb.org/). Aims to be a **full local
stand-in for BigQuery** for testing, CI, and local development — any
BigQuery client (`@google-cloud/bigquery`, the Python client, `bq` CLI,
JDBC/ODBC drivers) can point at it without code changes. Native arm64
image, and `PATCH` on datasets and tables actually mutates state (which
some existing emulators don't).

Not production-ready, but the architecture stays close to real BigQuery
on purpose — so this can also be a **migration on-ramp** for projects
that want to move off BigQuery onto DuckDB.

> **Status:** v0.6.0 — published to both
> [Docker Hub](https://hub.docker.com/r/jtwebman/bigquery-local) and
> [npm](https://www.npmjs.com/package/bigquery-local). See `plan.md`
> for the v0 plan + full-BigQuery scope appendix, and `BACKLOG.md` for
> the work items.

---

## Feature status

Legend: ✅ shipped · 🚧 in progress · ⏳ planned for v0 · 🔭 later · ❌ not planned

### REST API

| Resource / endpoint | Status |
|---|---|
| `GET /discovery/v1/apis/bigquery/v2/rest` | ✅ |
| Datasets — `GET`, `POST`, **`PATCH`**, `DELETE` | ✅ |
| Tables — `GET`, `POST`, **`PATCH`**, `DELETE` | ✅ |
| `POST .../tables/{t}/insertAll` (streaming inserts) | ✅ |
| `POST /projects/{p}/queries` (sync query) | ✅ |
| `POST /projects/{p}/jobs` (jobs.insert) | ✅ |
| `GET /projects/{p}/jobs/{j}` | ✅ |
| `GET /projects/{p}/queries/{j}` (getQueryResults) | ✅ |
| `GET /projects/{p}/datasets` (list, paginated) | ✅ |
| `GET /projects/{p}/datasets/{d}/tables` (list, paginated) | ✅ |
| `GET /projects/{p}/jobs` (list w/ stateFilter, time bounds, projection) | ✅ |
| `POST .../jobs/{j}/cancel`, `DELETE .../jobs/{j}/delete` | ✅ |
| `GET .../tables/{t}/data` (tabledata.list, paginated, selectedFields) | ✅ |
| `insertAll` insertId dedup (60s window, per-table) | ✅ |
| `dryRun: true` on queries + jobs (DuckDB `DESCRIBE`-backed) | ✅ |
| `insertAll` `templateSuffix` (auto-create target on first hit) | ✅ |
| Multi-project isolation (same dataset+table id in two projects) | ✅ |
| `--data-from-yaml` initial seed file | ✅ |
| `jobs.cancel`, `jobs.delete` | 🔭 |
| `tabledata.list` | 🔭 |
| `--data-from-yaml` initial seed | 🔭 |
| Routines, Models, IAM, Reservations, RowAccessPolicies | 🔭 |
| Storage Read API (gRPC, Avro/Arrow) | 🔭 |
| Storage Write API (gRPC) | 🔭 |
| BigQuery ML, SEARCH, VECTOR_SEARCH | 🔭 |
| Federated external queries (Bigtable / Spanner / Cloud SQL) | 🔭 |

### SQL features

| Feature | Status |
|---|---|
| `SELECT` / `JOIN` (INNER/LEFT/RIGHT/FULL/CROSS) / `WHERE` / `ORDER BY` / `GROUP BY` / `HAVING` / `LIMIT` / `OFFSET` | ✅ |
| Named parameters (`@name`) with `parameterMode=NAMED` | ✅ |
| Backtick-quoted refs: `` `dataset.table` ``, `` `project.dataset.table` `` | ✅ |
| `UNNEST(@arr)` (DuckDB-native) | ✅ |
| `JSON_VALUE` (with quoted JSON path segments) | ✅ |
| `TIMESTAMP_ADD`, `TIMESTAMP_SUB`, `CURRENT_TIMESTAMP`, `INTERVAL n {DAY,HOUR,...}` | ✅ |
| `STARTS_WITH`, `ENDS_WITH` | ✅ |
| `IS NOT NULL`, `COALESCE`, `IFNULL`, `NULLIF`, `LEAST`, `GREATEST` | ✅ |
| Subqueries (correlated, scalar, `EXISTS`, `IN`, `ANY`/`SOME`/`ALL`) | ✅ |
| `WITH` / `WITH RECURSIVE` (CTE) | ✅ |
| Set ops: `UNION`, `INTERSECT`, `EXCEPT` (ALL / DISTINCT) | ✅ |
| `SAFE_CAST` → `try_cast` | ✅ |
| `INSERT INTO … SELECT …` | 🚧 |
| `INSERT` / `UPDATE` / `DELETE` (single-table) | 🚧 |
| `JSON_EXTRACT_*` family | 🚧 |
| Window / analytic functions (`OVER`) | 🔭 |
| `QUALIFY`, `PIVOT` / `UNPIVOT`, `TABLESAMPLE` | 🔭 |
| `MERGE` | 🔭 |
| Wildcard tables (`events_*`, `_TABLE_SUFFIX`) | 🔭 |
| Scripting (`BEGIN`/`END`, `DECLARE`, `SET`, `IF`, `WHILE`, `CALL`, …) | 🔭 |
| SQL & JS UDFs, table-valued functions, stored procedures | 🔭 |
| Materialized views, snapshots, clones, time travel (`FOR SYSTEM_TIME AS OF`) | 🔭 |
| Geography (`ST_*`) | 🔭 |
| BigQuery ML (`CREATE MODEL`, `ML.PREDICT`, …) | 🔭 |
| `SEARCH()`, `VECTOR_SEARCH` | 🔭 |

### Types

| BQ type | Status | Stored as |
|---|---|---|
| `STRING`, `BYTES`, `INT64`, `FLOAT64`, `BOOL` | ✅ | `VARCHAR`, `BLOB`, `BIGINT`, `DOUBLE`, `BOOLEAN` |
| `TIMESTAMP`, `DATETIME`, `DATE`, `TIME` | ✅ | DuckDB native temporal types |
| `NUMERIC` | ✅ | `DECIMAL(38,9)` |
| `BIGNUMERIC` | ✅ | `VARCHAR` (decimal string; DuckDB max precision is 38) |
| `JSON` | ✅ | DuckDB `JSON` |
| `ARRAY<T>` / `REPEATED` mode | ✅ | DuckDB `T[]` (LIST) |
| `STRUCT<…>` / `RECORD` | ✅ | DuckDB `STRUCT(…)` |
| `GEOGRAPHY` | ✅ | `VARCHAR` (WKT round-trip; no `ST_*` functions) |
| `INTERVAL` | 🔭 | |
| `RANGE<T>` | 🔭 | |

### Modes / nullability

| Mode | Status |
|---|---|
| `NULLABLE` | ✅ |
| `REQUIRED` | ✅ |
| `REPEATED` | ✅ (via DuckDB LIST) |

### Operational

| Capability | Status |
|---|---|
| REST on port 9050 | ✅ |
| gRPC port 9060 (bound, returns UNIMPLEMENTED) | ✅ |
| `--project`, `--port`, `--grpc-port`, `--database`, `--log-level`, `--log-format` | ✅ |
| Multi-arch Docker image (`linux/amd64` + `linux/arm64`) | ✅ |
| Persistent file store (`--database=path.duckdb`) and `:memory:` mode | ✅ |
| No auth required; accepts any/no credentials. For the official client, use `emulatorGoogleAuth()` (see [Quick start](#pointing-the-bigquery-node-client-at-it)) | ✅ |
| Accepts both raw (`/projects/...`) and prefixed (`/bigquery/v2/projects/...`) URL shapes | ✅ |
| Multi-tenant: one server serves any project id (URL-scoped) | ✅ |

---

## Quick start

### Docker

```bash
docker run --rm -p 9050:9050 -p 9060:9060 \
  jtwebman/bigquery-local:latest
```

The default port is `9050`. The container also exposes `9060` for gRPC
(every RPC returns `UNIMPLEMENTED` — see the [gRPC](#grpc) section).

### npx (no install)

```bash
npx bigquery-local --port=9050 --database=./bq.duckdb
```

### Pointing the BigQuery Node client at it

```ts
import { BigQuery } from '@google-cloud/bigquery';
import { emulatorGoogleAuth } from 'bigquery-local/auth';

const bigQuery = new BigQuery({
  projectId: 'local',
  apiEndpoint: 'http://localhost:9050',
  authClient: emulatorGoogleAuth(),
});
```

`emulatorGoogleAuth()` lives at the `bigquery-local/auth` subpath so
the core entry has zero auth dependencies. The helper itself imports
`google-auth-library`, which is declared as an **optional peer
dependency** — if you're using `@google-cloud/bigquery` you already
have it transitively; otherwise:

```bash
npm install --save-dev google-auth-library
```

The helper returns an `OAuth2Client` that attaches a placeholder
`Authorization: Bearer emulator` header without ever calling Google.
The emulator ignores the token; the header is only there so the
official client doesn't error before sending the request. The
emulator itself accepts any (or no) auth header.

One server serves any project id — projects are isolated by URL path,
the same way real BigQuery does it. The official client sends URLs
prefixed with `/bigquery/v2/...`; the emulator strips that prefix
internally, so a single route table serves both raw HTTP callers and
the client library.

**When you need `authClient` vs. when you can skip it.** The emulator
accepts any (or no) `Authorization` header — so on the *wire* an
`authClient` is never required. The catch is on the *client* side:
`@google-cloud/bigquery` runs `google-auth-library` before sending the
request. Two outcomes:

- **ADC is empty** (no `gcloud auth login` state, no
  `GOOGLE_APPLICATION_CREDENTIALS`) → the client falls through to
  unauthenticated and everything works. You can drop the `authClient`
  line. Typical of clean CI runners.
- **ADC has something** (e.g. you've ever run `gcloud auth login` on
  this machine) → the client tries to mint a real Google token, hits
  Google, fails, and never sends the request. You need
  `authClient: emulatorGoogleAuth()` to short-circuit that.

If you're not sure which state your machine is in, just use
`emulatorGoogleAuth()` — it's deterministic in both cases.

If you can't use the `authClient` option (different client library,
constructed deep inside framework code, etc.), the
`BIGQUERY_EMULATOR_HOST` env var also works:

```bash
BIGQUERY_EMULATOR_HOST=http://localhost:9050 \
GOOGLE_APPLICATION_CREDENTIALS=$(pwd)/fake-creds.json \
node my-app.js
```

`fake-creds.json` can be any valid-shaped service-account JSON — the
client lib uses it to skip the ADC lookup, then the request still
lands on the emulator.

**Heads up if you're coming from Datastore / Firestore / Pub/Sub /
Spanner / Storage:** those emulators' client libraries detect their
`*_EMULATOR_HOST` env var and skip auth entirely. `@google-cloud/bigquery`
is the odd one out — it reads `BIGQUERY_EMULATOR_HOST` only to redirect
the URL and still runs the full `google-auth-library` pipeline. That's
why setting the env var alone isn't enough; you need one of:

1. `authClient: emulatorGoogleAuth()` (deterministic, recommended),
2. **empty ADC state (clean CI runners work out of the box)**, or
3. `BIGQUERY_EMULATOR_HOST` + a fake `GOOGLE_APPLICATION_CREDENTIALS`
   file (matches the workaround used by other BQ emulators like
   `goccy/bigquery-emulator`).

### Embedding it in your tests

`bigquery-local` is also a Node library. Spin one up in-process —
no Docker, no global port — and tear it down in `afterAll`:

```bash
npm install --save-dev bigquery-local
```

```ts
import { createServer } from 'bigquery-local';
import { emulatorGoogleAuth } from 'bigquery-local/auth';
import { BigQuery } from '@google-cloud/bigquery';

const server = await createServer({ database: ':memory:' });
await server.listen(0); // 0 = pick a random free port

const bigQuery = new BigQuery({
  projectId: 'test',
  apiEndpoint: server.url,
  authClient: emulatorGoogleAuth(),
});

// ...run your tests against `bigQuery`...

await server.close(); // closes the HTTP listener and the DB
```

If you want to inspect or assert on the raw HTTP wire format directly,
`server.url` is just a normal `http://127.0.0.1:<port>` URL — `fetch()`
hits the same routes the client library uses.

---

## CLI

```
Usage: bigquery-local [options]

Options:
  --project=<id>         Default project id (informational; routes accept any).
  --port=<n>             REST API port (default: 9050; 0 = pick a free port).
  --grpc-port=<n>        gRPC port (default: 9060). Returns UNIMPLEMENTED to all RPCs.
  --database=<path>      DuckDB file path (default: ":memory:").
  --log-level=<level>    debug | info | warn | error (default: info).
  --log-format=<fmt>     json | text (default: text).
  --data-from-yaml=<f>   Seed data file (reserved; not yet implemented).
  -v, --version          Print version and exit.
  -h, --help             Print this help text and exit.
```

`--project` is informational — the server is multi-tenant by URL path,
so any project id a client uses just works. There's no need to declare
projects up front.

### gRPC

The container also binds the gRPC port (default `9060`). Every RPC
returns `UNIMPLEMENTED` (gRPC status 12), which is the canonical wire
shape every conforming gRPC client expects for synchronous errors.
This means a client like `@google-cloud/bigquery-storage` pointed at
this port gets a clean error instead of a hung connection — useful
when you have shared client code that constructs both REST and
Storage Read API handles.

---

## Storage

Backed by **DuckDB** via `@duckdb/node-api`. Datasets map to DuckDB
schemas, tables map to DuckDB tables, and BQ types map directly onto
DuckDB types (`ARRAY<T>` → `T[]`, `STRUCT<…>` → `STRUCT(…)`, `NUMERIC` →
`DECIMAL(38,9)`, `JSON` → `JSON`, etc.). Metadata (datasets, tables,
jobs) lives in a dedicated `_bq` schema.

Either point `--database` at a file path for persistence, or omit it to
run fully in-memory.

---

## Compatibility

The target is Google's published BigQuery REST API — anywhere your
client successfully hits real BigQuery, it should also work against
this emulator (within the features listed above).

Common CLI flags and the default port `9050` match the conventions used
by other BigQuery emulators, so swapping an existing emulator container
is typically a one-line image change plus dropping any `platform:
linux/amd64` pin (this image is multi-arch).

---

## Development

Source is TypeScript end-to-end, run directly under Node 24's native
type stripping — no transpile step.

```bash
npm install
npm run typecheck       # tsc --noEmit
npm run lint            # biome lint
npm run format:check    # biome format
npm test                # node --conditions=src --test
npm run test:coverage   # ≥ 90% lines / branches / functions

node bin/bigquery-local.ts --port=0
```

CI runs the full toolchain on **Ubuntu, macOS, and Windows × Node 24
and Node 26** — six jobs per PR. `noExplicitAny` is enforced;
`tsconfig.json` sets `erasableSyntaxOnly` so no syntax that would
require runtime transformation can slip in.

The library entrypoint resolves from `src/index.ts` in dev (via the
`src` export condition + `node --conditions=src`) and from
`dist/index.js` after publish — same import specifier in both worlds,
no rebuild step needed during local iteration.

---

## Releasing

Releases are cut as **GitHub Releases** — publishing a release creates the
git tag and triggers the publish workflow.

1. Land a PR that bumps `package.json` `version` to `X.Y.Z`.
2. From `main`, create the release:

   ```bash
   gh release create vX.Y.Z --generate-notes --title "vX.Y.Z"
   ```

   Or use the UI at https://github.com/jtwebman/bigquery-local/releases/new
   and tick "Generate release notes" — GitHub assembles the changelog from
   the PRs merged since the previous release.

Publishing the release triggers `.github/workflows/publish.yml`, which:

- verifies the tag matches `package.json` (fails fast if not),
- builds `linux/amd64` + `linux/arm64` and pushes
  `jtwebman/bigquery-local:X.Y.Z` and `:latest` to Docker Hub,
- runs `tsc -p tsconfig.build.json` and publishes the npm package as
  `bigquery-local@X.Y.Z` with `--provenance` (signed attestation tied
  to the GitHub release).

**Setup (one-time):**

- GitHub repository secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`.
- npm Trusted Publisher: on npmjs.com → package settings →
  **Trusted Publishers** → add a GitHub Actions publisher for repo
  `jtwebman/bigquery-local` and workflow `publish.yml`. No `NPM_TOKEN`
  secret needed; the workflow authenticates via GitHub's OIDC token,
  which also enables `npm publish --provenance`.

---

## License

MIT

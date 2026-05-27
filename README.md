# bigquery-local

[![npm](https://img.shields.io/npm/v/bigquery-local?label=npm)](https://www.npmjs.com/package/bigquery-local)
[![Docker Hub](https://img.shields.io/docker/v/jtwebman/bigquery-local?label=Docker%20Hub&sort=semver)](https://hub.docker.com/r/jtwebman/bigquery-local)
[![Image size](https://img.shields.io/docker/image-size/jtwebman/bigquery-local/latest?label=image%20size)](https://hub.docker.com/r/jtwebman/bigquery-local)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A local emulator for the Google BigQuery REST API, backed by
[DuckDB](https://duckdb.org/). Point any BigQuery client at it for tests, CI,
and local development. No code changes needed.

It works with `@google-cloud/bigquery`, the Python and Go clients, the `bq`
CLI, and JDBC/ODBC drivers. The image is multi-arch (amd64 and arm64), and
`PATCH` on datasets and tables actually changes state (some emulators skip
that).

> Status: v0.6.0, published to
> [Docker Hub](https://hub.docker.com/r/jtwebman/bigquery-local) and
> [npm](https://www.npmjs.com/package/bigquery-local). See `plan.md` and
> `BACKLOG.md` for scope and roadmap.

## Run it

### Docker

```bash
docker run --rm -p 9050:9050 -p 9060:9060 jtwebman/bigquery-local:latest
```

REST is on port 9050. Port 9060 is gRPC and returns `UNIMPLEMENTED` (see
[gRPC](#grpc)).

### Local (no install)

```bash
npx bigquery-local --port=9050 --database=./bq.duckdb
```

Leave off `--database` to run fully in memory.

### Point a client at it

```ts
import { BigQuery } from '@google-cloud/bigquery';
import { emulatorGoogleAuth } from 'bigquery-local/auth';

const bigQuery = new BigQuery({
  projectId: 'local',
  apiEndpoint: 'http://localhost:9050',
  authClient: emulatorGoogleAuth(),
});
```

Use any project id. Projects are isolated by URL path, the same way real
BigQuery does it.

### About auth

The emulator accepts any credentials, or none. The catch is on the client
side: `@google-cloud/bigquery` runs `google-auth-library` before it sends a
request. If your machine has real Google credentials (from `gcloud auth
login` or `GOOGLE_APPLICATION_CREDENTIALS`), the client tries to mint a real
token and fails before the request ever reaches the emulator.

`emulatorGoogleAuth()` fixes this. It attaches a placeholder token and never
calls Google, so it works whether or not your machine has credentials. Use it
and you are fine in every case.

It lives at the `bigquery-local/auth` subpath so the main entry has no auth
dependencies. It needs `google-auth-library`, which you already have if you
use `@google-cloud/bigquery`. Otherwise install it:

```bash
npm install --save-dev google-auth-library
```

If you cannot pass `authClient` (a different client, or one built deep inside
a framework), use env vars instead:

```bash
BIGQUERY_EMULATOR_HOST=http://localhost:9050 \
GOOGLE_APPLICATION_CREDENTIALS=$(pwd)/fake-creds.json \
node my-app.js
```

`fake-creds.json` can be any valid-shaped service-account JSON. Note:
`BIGQUERY_EMULATOR_HOST` alone is not enough, because the BigQuery client
still runs the full auth pipeline (unlike the Datastore or Pub/Sub
emulators).

### Use it in your tests

`bigquery-local` is also a Node library. Start one in-process, with no Docker
and no fixed port:

```bash
npm install --save-dev bigquery-local
```

```ts
import { createServer } from 'bigquery-local';
import { emulatorGoogleAuth } from 'bigquery-local/auth';
import { BigQuery } from '@google-cloud/bigquery';

const server = await createServer({ database: ':memory:' });
await server.listen(0); // 0 picks a free port

const bigQuery = new BigQuery({
  projectId: 'test',
  apiEndpoint: server.url,
  authClient: emulatorGoogleAuth(),
});

// ...run your tests...

await server.close();
```

`server.url` is a plain `http://127.0.0.1:<port>` URL, so you can also
`fetch()` the routes directly to assert on the raw wire format.

## Feature status

Legend: **✅ Supported**. **🚧 Planned** (on the roadmap). **❌ Not planned**
(out of scope on purpose).

### REST API

| Endpoint | Status |
|---|---|
| Discovery doc | ✅ |
| Datasets: GET / POST / PATCH / DELETE / list | ✅ |
| Tables: GET / POST / PATCH / DELETE / list | ✅ |
| `tabledata.insertAll` (insertId dedup, `templateSuffix`) | ✅ |
| `tabledata.list` (paginated, `selectedFields`) | ✅ |
| Queries: sync query + `getQueryResults` | ✅ |
| Jobs: insert / get / list / cancel / delete | ✅ |
| `dryRun` on queries and jobs | ✅ |
| Load jobs: CSV / NDJSON / Parquet (autodetect, GCS reads) | ✅ |
| Extract jobs: CSV / JSON / Avro / Parquet | ✅ |
| Copy jobs: copy / snapshot / clone | ✅ |
| Routines and Models CRUD | ✅ |
| Projects list + `getServiceAccount` | ✅ |
| `INFORMATION_SCHEMA` views | ✅ |
| Multi-project isolation, `--data-from-yaml` seed | ✅ |
| Storage Read API (gRPC) | 🚧 |
| Storage Write API (gRPC) | 🚧 |
| Sessions, Connections, Data Transfer Service | 🚧 |
| Reservations, RowAccessPolicies, IAM metadata APIs | 🚧 |
| Federated queries (Bigtable / Spanner / Cloud SQL) | 🚧 |
| IAM access enforcement | ❌ |

❌ The emulator accepts any (or no) credentials on purpose, so it does not
enforce access control. The IAM and policy metadata endpoints may still land
(🚧 above).

### SQL

| Feature | Status |
|---|---|
| SELECT, JOIN (all kinds), WHERE, GROUP BY, HAVING, ORDER BY, LIMIT, OFFSET | ✅ |
| GROUP BY ROLLUP / CUBE / GROUPING SETS | ✅ |
| Named params (`@name`), backtick table refs | ✅ |
| Subqueries: correlated, scalar, EXISTS, IN, ANY / SOME / ALL | ✅ |
| CTEs: WITH, WITH RECURSIVE | ✅ |
| Set ops: UNION, INTERSECT, EXCEPT | ✅ |
| UNNEST (with OFFSET), array subscripts (OFFSET / ORDINAL / SAFE_OFFSET) | ✅ |
| Window functions: OVER, frames, RANK, LAG, LEAD, FIRST_VALUE, ... | ✅ |
| QUALIFY, PIVOT / UNPIVOT, TABLESAMPLE, SELECT * EXCEPT / REPLACE | ✅ |
| Wildcard tables and `_TABLE_SUFFIX` | ✅ |
| DML: INSERT, UPDATE, DELETE, MERGE, TRUNCATE | ✅ |
| Transactions: BEGIN, COMMIT, ROLLBACK | ✅ |
| DDL: CREATE / DROP VIEW, SCHEMA, MATERIALIZED VIEW | ✅ |
| Scripting: DECLARE, SET, IF, WHILE, LOOP, FOR, CALL, EXECUTE IMMEDIATE | ✅ |
| SQL UDFs, table functions, stored procedures | ✅ |
| Function library: string, math, date/time, JSON, array, aggregate, hash (broad) | ✅ |
| Geography type + core ST_* (ST_GEOGPOINT, ST_DISTANCE, ST_INTERSECTS, ...) | ✅ |
| Long-tail ST_* (ST_BUFFER, ST_AREA, ST_UNION, ...) | 🚧 |
| JavaScript UDFs, scripting EXCEPTION handlers | 🚧 |
| Snapshots, clones, time travel (FOR SYSTEM_TIME AS OF) | 🚧 |
| BigQuery ML, SEARCH(), VECTOR_SEARCH | 🚧 |
| FARM_FINGERPRINT | 🚧 |

The function library is broad but not exhaustive. A function we have not
mapped returns a clear "unsupported" error, not a wrong result.

These functions are known gaps and return that error today (planned for a
later version): `INITCAP`, `REGEXP_INSTR`, `CONTAINS_SUBSTR`,
`CODE_POINTS_TO_STRING`, `CODE_POINTS_TO_BYTES`, `TO_CODE_POINTS`,
`SAFE_CONVERT_BYTES_TO_STRING`, `SOUNDEX`, `RANGE_BUCKET`, `TO_BASE32`,
`FROM_BASE32`, the `LAX_*` JSON accessors, `JSON_EXTRACT_ARRAY`,
`JSON_REMOVE`, `JSON_SET`, `JSON_STRIP_NULLS`, `APPROX_TOP_COUNT`,
`APPROX_TOP_SUM`, `APPROX_QUANTILES`, `HLL_COUNT.*`, `FARM_FINGERPRINT`,
and `ST_GEOHASH`.

### Types

| Type | Status | Stored as |
|---|---|---|
| STRING, BYTES, INT64, FLOAT64, BOOL | ✅ | VARCHAR, BLOB, BIGINT, DOUBLE, BOOLEAN |
| TIMESTAMP, DATETIME, DATE, TIME | ✅ | DuckDB temporal types |
| NUMERIC | ✅ | DECIMAL(38,9) |
| BIGNUMERIC | ✅ | VARCHAR (decimal string; DuckDB max precision is 38) |
| JSON | ✅ | DuckDB JSON |
| `ARRAY<T>` / REPEATED | ✅ | DuckDB `T[]` (LIST) |
| STRUCT / RECORD | ✅ | DuckDB STRUCT |
| GEOGRAPHY | ✅ | DuckDB GEOMETRY (spatial extension) |
| INTERVAL | ✅ | DuckDB INTERVAL |
| `RANGE<T>` | ✅ | epoch-encoded bounds |

### Modes

| Mode | Status |
|---|---|
| NULLABLE | ✅ |
| REQUIRED | ✅ |
| REPEATED | ✅ (DuckDB LIST) |

### Operational

| Capability | Status |
|---|---|
| REST on port 9050 | ✅ |
| gRPC on port 9060 (returns UNIMPLEMENTED) | ✅ |
| Flags: `--project`, `--port`, `--grpc-port`, `--database`, `--log-level`, `--log-format` | ✅ |
| Multi-arch Docker image (amd64 and arm64) | ✅ |
| File store (`--database=path.duckdb`) or in-memory | ✅ |
| Accepts raw (`/projects/...`) and prefixed (`/bigquery/v2/...`) URLs | ✅ |
| One server serves any project id | ✅ |

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
  --data-from-yaml=<f>   Seed data file (YAML), loaded at startup.
  -v, --version          Print version and exit.
  -h, --help             Print this help text and exit.
```

`--project` is informational. The server is multi-tenant by URL path, so any
project id a client uses just works. You do not declare projects up front.

## gRPC

The container binds the gRPC port (default 9060). Every RPC returns
`UNIMPLEMENTED` (gRPC status 12). That is the response a gRPC client expects
for an unsupported call, so a client like `@google-cloud/bigquery-storage`
gets a clean error instead of a hung connection.

## Storage

Backed by DuckDB via `@duckdb/node-api`. Datasets map to DuckDB schemas,
tables map to DuckDB tables, and BQ types map onto DuckDB types. Metadata
(datasets, tables, jobs) lives in a `_bq` schema. Point `--database` at a file
for persistence, or omit it to run in memory.

## Compatibility

The target is Google's published BigQuery REST API. Where your client hits
real BigQuery, it should also work here, within the features listed above.

The common CLI flags and the default port 9050 match other BigQuery
emulators, so swapping in this image is usually a one-line change (plus
dropping any `platform: linux/amd64` pin, since this image is multi-arch).

## Development

The source is TypeScript, run directly under Node 24 type stripping. No
build step.

```bash
npm install
npm run typecheck       # tsc --noEmit
npm run lint            # biome lint
npm run format:check    # biome format
npm test                # node --conditions=src --test
npm run test:coverage   # 90% lines / branches / functions

node bin/bigquery-local.ts --port=0
```

CI runs the full toolchain on Ubuntu, macOS, and Windows, on Node 24 and
Node 26. `noExplicitAny` is enforced, and `erasableSyntaxOnly` keeps out any
syntax that would need a runtime transform.

The library entry resolves from `src/index.ts` in dev and `dist/index.js`
after publish, using the same import path in both, so there is no rebuild
step while iterating.

## Releasing

Releases are GitHub Releases. Publishing a release creates the git tag and
triggers the publish workflow.

1. Land a PR that bumps `package.json` `version` to `X.Y.Z`.
2. From `main`, create the release:

   ```bash
   gh release create vX.Y.Z --generate-notes --title "vX.Y.Z"
   ```

   Or use the UI and tick "Generate release notes".

Publishing triggers `.github/workflows/publish.yml`, which:

- checks the tag matches `package.json` (fails fast if not),
- builds amd64 and arm64 and pushes `jtwebman/bigquery-local:X.Y.Z` and
  `:latest` to Docker Hub,
- builds and publishes the npm package `bigquery-local@X.Y.Z` with
  `--provenance`.

## License

MIT

# bigquery-local

[![npm](https://img.shields.io/npm/v/bigquery-local?label=npm)](https://www.npmjs.com/package/bigquery-local)
[![Docker Hub](https://img.shields.io/docker/v/jtwebman/bigquery-local?label=Docker%20Hub&sort=semver)](https://hub.docker.com/r/jtwebman/bigquery-local)
[![Image size](https://img.shields.io/docker/image-size/jtwebman/bigquery-local/latest?label=image%20size)](https://hub.docker.com/r/jtwebman/bigquery-local)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A local emulator for the Google BigQuery REST **and** gRPC APIs, backed by
[DuckDB](https://duckdb.org/). Point any BigQuery client at it for tests, CI,
and local development. No code changes needed.

It works with `@google-cloud/bigquery`, `@google-cloud/bigquery-storage`, the
Python / Go / Java / C# clients, dbt, and the `bq` CLI — exercised by a
5-language conformance suite. The image is multi-arch (amd64 and arm64), and
`PATCH` on datasets and tables actually changes state (some emulators skip that).

> Status: v0.7.0, published to
> [Docker Hub](https://hub.docker.com/r/jtwebman/bigquery-local) and
> [npm](https://www.npmjs.com/package/bigquery-local). See `BACKLOG.md` for
> the roadmap.

## Run it

### Docker

```bash
docker run --rm -p 9050:9050 -p 9060:9060 jtwebman/bigquery-local:latest
```

REST is on port 9050. gRPC is on port 9060 (BigQueryRead + BigQueryWrite
over plaintext HTTP/2 — see [gRPC](#grpc)).

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

## Client recipes

Each of the snippets below is exercised by the conformance suite in
[`test/clients/`](test/clients) on every CI run. They assume the
Docker image (or any standalone instance) running on the defaults
(REST `localhost:9050`, gRPC `localhost:9060`).

### Node — `@google-cloud/bigquery` + `@google-cloud/bigquery-storage`

```ts
import { BigQuery } from '@google-cloud/bigquery';
import { BigQueryReadClient } from '@google-cloud/bigquery-storage';
import * as grpc from '@grpc/grpc-js';
import { emulatorGoogleAuth } from 'bigquery-local/auth';

// REST.
const bq = new BigQuery({
  projectId: 'local',
  apiEndpoint: 'http://localhost:9050',
  authClient: emulatorGoogleAuth(),
});

// Storage Read (gRPC). google-gax wants host + port split apart.
const readClient = new BigQueryReadClient({
  apiEndpoint: 'localhost',
  port: 9060,
  sslCreds: grpc.credentials.createInsecure(),
  projectId: 'local',
});
```

### Python — `google-cloud-bigquery` + `google-cloud-bigquery-storage`

```python
import grpc
from google.api_core.client_options import ClientOptions
from google.auth.credentials import AnonymousCredentials
from google.cloud import bigquery, bigquery_storage
from google.cloud.bigquery_storage_v1.services.big_query_read.transports import (
    BigQueryReadGrpcTransport,
)

# REST.
bq = bigquery.Client(
    project="local",
    client_options=ClientOptions(api_endpoint="http://localhost:9050"),
    credentials=AnonymousCredentials(),
)

# Storage Read (gRPC). The default transport tries TLS; pass an
# insecure-channel-backed transport explicitly so the plaintext HTTP/2
# handshake against the emulator succeeds.
channel = grpc.insecure_channel("localhost:9060")
read_client = bigquery_storage.BigQueryReadClient(
    transport=BigQueryReadGrpcTransport(channel=channel),
)
```

### Go — `cloud.google.com/go/bigquery` + `.../storage/apiv1`

```go
import (
    "context"

    "cloud.google.com/go/bigquery"
    storage "cloud.google.com/go/bigquery/storage/apiv1"
    "google.golang.org/api/option"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

ctx := context.Background()

// REST.
bq, err := bigquery.NewClient(ctx, "local",
    option.WithEndpoint("http://localhost:9050"),
    option.WithoutAuthentication(),
)

// Storage Read (gRPC) over an insecure channel.
conn, err := grpc.NewClient("localhost:9060",
    grpc.WithTransportCredentials(insecure.NewCredentials()))
readClient, err := storage.NewBigQueryReadClient(ctx,
    option.WithGRPCConn(conn),
    option.WithoutAuthentication(),
)
```

### Java — `google-cloud-bigquery` + `google-cloud-bigquerystorage`

```java
import com.google.api.gax.core.NoCredentialsProvider;
import com.google.api.gax.grpc.GrpcTransportChannel;
import com.google.api.gax.rpc.FixedTransportChannelProvider;
import com.google.cloud.NoCredentials;
import com.google.cloud.bigquery.BigQuery;
import com.google.cloud.bigquery.BigQueryOptions;
import com.google.cloud.bigquery.storage.v1.BigQueryReadClient;
import com.google.cloud.bigquery.storage.v1.BigQueryReadSettings;
import io.grpc.ManagedChannel;
import io.grpc.ManagedChannelBuilder;

// REST.
BigQuery bq = BigQueryOptions.newBuilder()
    .setProjectId("local")
    .setHost("http://localhost:9050")
    .setCredentials(NoCredentials.getInstance())
    .build()
    .getService();

// Storage Read (gRPC).
ManagedChannel channel = ManagedChannelBuilder
    .forAddress("localhost", 9060)
    .usePlaintext()
    .build();
BigQueryReadSettings settings = BigQueryReadSettings.newBuilder()
    .setCredentialsProvider(NoCredentialsProvider.create())
    .setTransportChannelProvider(
        FixedTransportChannelProvider.create(GrpcTransportChannel.create(channel)))
    .build();
BigQueryReadClient readClient = BigQueryReadClient.create(settings);
```

### C# / .NET — `Google.Cloud.BigQuery.V2` + `Google.Cloud.BigQuery.Storage.V1`

```csharp
using Google.Cloud.BigQuery.V2;
using Google.Cloud.BigQuery.Storage.V1;
using Grpc.Core;

// REST.
var bq = new BigQueryClientBuilder
{
    ProjectId = "local",
    BaseUri = "http://localhost:9050",
}.Build();

// Storage Read (gRPC). The builder rejects setting both `CallInvoker`
// and credentials — let it construct the channel itself from the
// endpoint + insecure creds.
var readClient = await new BigQueryReadClientBuilder
{
    Endpoint = "localhost:9060",
    ChannelCredentials = ChannelCredentials.Insecure,
}.BuildAsync();
```

### dbt — via `dbt-bigquery`

The emulator includes a small shim
([`test/clients/dbt/sitecustomize.py`](test/clients/dbt/sitecustomize.py))
that patches `dbt-bigquery`'s underlying clients to talk to the emulator
when these env vars are set:

```bash
export BIGQUERY_EMULATOR_HOST=http://localhost:9050  # REST
export BIGQUERY_EMULATOR_GRPC_HOST=localhost:9060    # gRPC (optional)
export PYTHONPATH=$(pwd)/test/clients/dbt:$PYTHONPATH

dbt run --profiles-dir test/clients/dbt/project
```

The accompanying minimal profile:

```yaml
# profiles.yml
emu:
  target: dev
  outputs:
    dev:
      type: bigquery
      method: oauth
      project: dbt-emu
      dataset: analytics
      threads: 1
      location: US
```

### `bq` CLI

The Google Cloud SDK's `bq` is discovery-driven, so pointing it at the
emulator just works:

```bash
bq --api http://localhost:9050 --project_id=local query \
  --use_legacy_sql=false 'SELECT 1 AS x'
```

The full discovery doc is served at
`http://localhost:9050/discovery/v1/apis/bigquery/v2/rest`, and the
emulator's `bq`-CLI conformance suite in
[`test/clients/bq/`](test/clients/bq) exercises the common verbs
(`query`, `mk`, `ls`, `show`, `insert`, `head`, `rm`) on every CI run.

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
| Storage Read API (gRPC) — Avro + Arrow IPC, multi-stream, snapshot stub | ✅ |
| Storage Write API (gRPC) — `_default` / COMMITTED / BUFFERED / PENDING, FlushRows, BatchCommit, multiplexed streams | ✅ |
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
| JavaScript UDFs (V8 isolate via `isolated-vm`, 5 s CPU + 128 MB memory caps, `OPTIONS(library=[...])` honored — see section below) | ✅ |
| Scripting EXCEPTION handlers | 🚧 |
| Snapshots, clones, time travel (FOR SYSTEM_TIME AS OF) | 🚧 |
| BigQuery ML, SEARCH(), VECTOR_SEARCH | 🚧 |
| FARM_FINGERPRINT | 🚧 |

The function library is broad but not exhaustive. A function we have not
mapped returns a clear "unsupported" error, not a wrong result.

### JavaScript UDFs (sandboxed V8 isolate via `isolated-vm`)

`CREATE FUNCTION ... LANGUAGE js AS "..."` runs the UDF body inside a
real V8 isolate, via [`isolated-vm`](https://github.com/laverdet/isolated-vm)
— the same engine family BigQuery uses for its JS UDFs. Each `Db`
connection lazily creates one Isolate (128 MB memory cap); each UDF
invocation enforces a 5-second CPU timeout.

The isolate has no `process`, no `require`, no `Buffer`, no `global`
— UDF code can compute on its arguments and that's it. Runaway loops
surface as a `timed out` error rather than hanging the emulator;
allocations past 128 MB surface as a memory error.

`OPTIONS(library = ["url1", "url2"])` is honored: each URL is fetched
at `CREATE FUNCTION` time and the library source is injected into the
isolate's shared context before the UDF body runs. Per-file fetch cap
is 5 MB.

#### Distribution: `isolated-vm` is an optional install

`isolated-vm` is a native module. It's declared in
`optionalDependencies`, so:

- **`npm install bigquery-local` succeeds whether or not a prebuilt
  binary matches your Node/platform.** If isolated-vm doesn't install,
  everything else (REST, gRPC, SQL UDFs) still works.
- **JS UDFs require isolated-vm.** If you call
  `CREATE FUNCTION ... LANGUAGE js` without it installed, the response
  is a precise error pointing you at the install or the Docker image.

The cleanest way to guarantee JS UDFs work out of the box is the
**`ghcr.io/jtwebman/bigquery-local` Docker image**, which bundles a
working isolated-vm built against the image's Node version.

To install isolated-vm directly:

```sh
npm install isolated-vm
```

You may need a C++ toolchain (`build-essential` / Xcode CLT, plus
Python 3) if no prebuilt binary matches your platform.

#### Security caveat

The isolate boundary blocks accidents — a UDF body that does
`require('fs')` gets `undefined`, not a filesystem handle. It's
strong protection against *bugs* and reasonable protection against
*casual mischief*. It is **not** a substitute for process- or
hardware-level isolation if you're running fully untrusted code from
an unknown source. Don't expose this emulator over a public network
even with the isolate in place.

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
| BIGNUMERIC | ✅ | DECIMAL(38, 9) — values must fit in 29 integer digits + 9 decimal places (DuckDB caps DECIMAL precision at 38, less than BQ's 76); out-of-range values reject at insert. Wire encoders still emit BQ-fidelity precision 77 / scale 38. |
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
| gRPC on port 9060 (BigQueryRead + BigQueryWrite over plaintext HTTP/2) | ✅ |
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

The container binds the gRPC port (default 9060) and serves the BigQuery
Storage **Read** and **Write** APIs over plaintext HTTP/2:

- **`BigQueryRead`** — `CreateReadSession`, `ReadRows` (Avro + Arrow IPC),
  `SplitReadStream`. Multi-stream partitioning, `selectedFields`, and
  `row_restriction` are honored.
- **`BigQueryWrite`** — `CreateWriteStream`, `AppendRows` (bidi),
  `FinalizeWriteStream`, `BatchCommitWriteStreams`, `FlushRows`. All four
  stream types (`_default`, `COMMITTED`, `BUFFERED`, `PENDING`) work with
  BQ-faithful offset semantics; multiplexed streams over a single
  `AppendRows` connection are supported.

Conformance is validated by a **27-fixture replay suite** (21 Storage Read
fixtures + 6 Storage Write fixtures) captured against real BigQuery and
compared byte-for-byte (for the Avro/Arrow bytes) or value-equivalent (for
the row order, which BQ doesn't guarantee). Refresh via
`npm run bq-storage-replay:capture` / `bq-write-replay:capture`.

Clients exercised in the conformance suite: `@google-cloud/bigquery-storage`
(Node), `google-cloud-bigquery-storage` (Python), `cloud.google.com/go/...`
(Go), `google-cloud-bigquerystorage` (Java), and `Google.Cloud.BigQuery.Storage.V1`
(C#). dbt picks up Storage Read via the shim included in `test/clients/dbt`.

Point a client at `localhost:9060` with insecure channel credentials:

```python
import grpc
from google.cloud import bigquery_storage
from google.cloud.bigquery_storage_v1.services.big_query_read.transports import (
    BigQueryReadGrpcTransport,
)

channel = grpc.insecure_channel("localhost:9060")
client = bigquery_storage.BigQueryReadClient(
    transport=BigQueryReadGrpcTransport(channel=channel),
)
```

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

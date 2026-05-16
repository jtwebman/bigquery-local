# bigquery-local

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

> **Status:** pre-release. v0 is in active development — see
> `plan.md` for the v0 plan + full-BigQuery scope appendix, and
> `BACKLOG.md` for the work items.

---

## Feature status

Legend: ✅ shipped · 🚧 in progress · ⏳ planned for v0 · 🔭 later · ❌ not planned

### REST API

| Resource / endpoint | Status |
|---|---|
| `GET /discovery/v1/apis/bigquery/v2/rest` | ⏳ |
| Datasets — `GET`, `POST`, **`PATCH`**, `DELETE` | ⏳ |
| Tables — `GET`, `POST`, **`PATCH`**, `DELETE` | ⏳ |
| `POST .../tables/{t}/insertAll` (streaming inserts) | ⏳ |
| `POST /projects/{p}/queries` (sync query) | ⏳ |
| `POST /projects/{p}/jobs` (jobs.insert) | ⏳ |
| `GET /projects/{p}/jobs/{j}` | ⏳ |
| `GET /projects/{p}/queries/{j}` (getQueryResults) | ⏳ |
| List datasets / tables / jobs (paginated) | 🔭 |
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
| `SELECT` / `JOIN` (INNER/LEFT/RIGHT/FULL/CROSS) / `WHERE` / `ORDER BY` / `GROUP BY` / `HAVING` / `LIMIT` / `OFFSET` | ⏳ |
| Named parameters (`@name`) with `parameterMode=NAMED` | ⏳ |
| `INSERT INTO … SELECT …` | ⏳ |
| `INSERT` / `UPDATE` / `DELETE` (single-table) | ⏳ |
| Backtick-quoted refs: `` `dataset.table` ``, `` `project.dataset.table` `` | ⏳ |
| `UNNEST(@arr)` (DuckDB-native) | ⏳ |
| `JSON_VALUE`, `JSON_EXTRACT_*` (incl. quoted JSON path segments) | ⏳ |
| `TIMESTAMP_ADD`, `TIMESTAMP_SUB`, `CURRENT_TIMESTAMP`, `INTERVAL n {DAY,HOUR,...}` | ⏳ |
| `STARTS_WITH`, `ENDS_WITH` | ⏳ |
| `IS NOT NULL`, `COALESCE`, `IFNULL`, `NULLIF`, `LEAST`, `GREATEST` | ⏳ |
| Subqueries (correlated, scalar, `EXISTS`, `IN`, `ANY`/`SOME`/`ALL`) | ⏳ |
| `WITH` / `WITH RECURSIVE` (CTE) | ⏳ |
| Set ops: `UNION`, `INTERSECT`, `EXCEPT` (ALL / DISTINCT) | ⏳ |
| `SAFE_CAST` → `try_cast` | ⏳ |
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
| `STRING`, `BYTES`, `INT64`, `FLOAT64`, `BOOL` | ⏳ | `VARCHAR`, `BLOB`, `BIGINT`, `DOUBLE`, `BOOLEAN` |
| `TIMESTAMP`, `DATETIME`, `DATE`, `TIME` | ⏳ | DuckDB native temporal types |
| `NUMERIC` | ⏳ | `DECIMAL(38,9)` |
| `BIGNUMERIC` | ⏳ | `VARCHAR` (decimal string; DuckDB max precision is 38) |
| `JSON` | ⏳ | DuckDB `JSON` |
| `ARRAY<T>` / `REPEATED` mode | ⏳ | DuckDB `T[]` (LIST) |
| `STRUCT<…>` / `RECORD` | ⏳ | DuckDB `STRUCT(…)` |
| `GEOGRAPHY` | ⏳ | `VARCHAR` (WKT round-trip; no `ST_*` functions) |
| `INTERVAL` | 🔭 | |
| `RANGE<T>` | 🔭 | |

### Modes / nullability

| Mode | Status |
|---|---|
| `NULLABLE` | ⏳ |
| `REQUIRED` | ⏳ |
| `REPEATED` | ⏳ (via DuckDB LIST) |

### Operational

| Capability | Status |
|---|---|
| REST on port 9050 | ⏳ |
| gRPC port 9060 (bound, returns UNIMPLEMENTED) | ⏳ |
| `--project`, `--port`, `--grpc-port`, `--database`, `--log-level`, `--log-format` | ⏳ |
| Multi-arch Docker image (`linux/amd64` + `linux/arm64`) | ⏳ |
| Persistent file store (`--database=path.duckdb`) and `:memory:` mode | ⏳ |
| No auth required; accepts any/no credentials | ⏳ |
| Multi-project (repeatable `--project`) | 🔭 |

---

## Quick start

### Docker

```bash
docker run --rm -p 9050:9050 \
  jtwebman/bigquery-local:latest \
  --project=local --port=9050
```

### Node

```bash
npx bigquery-local --project=local --port=9050 --database=./bq.duckdb
```

### Pointing the BigQuery Node client at it

```ts
import { BigQuery } from '@google-cloud/bigquery';

const bigQuery = new BigQuery({
  projectId: 'local',
  apiEndpoint: 'http://localhost:9050',
});
```

No credentials needed. The emulator accepts any (or no) auth header.

### Embedding it in your tests

`bigquery-local` is also a Node library. Spin one up in-process —
no Docker, no global port — and tear it down in `afterAll`:

```ts
import { createServer } from 'bigquery-local';
import { BigQuery } from '@google-cloud/bigquery';

const server = await createServer({ project: 'test', database: ':memory:' });
await server.listen(0); // 0 = pick a random free port

const bigQuery = new BigQuery({
  projectId: 'test',
  apiEndpoint: server.url,
});

// ...run your tests against `bigQuery`...

await server.close();
```

---

## CLI

```
Usage: bigquery-local [flags]

Required:
  --project=<id>             BigQuery project id. Repeatable.

Optional:
  --port=<n>                 REST port (default 9050)
  --grpc-port=<n>            gRPC port (default 9060)
  --database=<path>          DuckDB file path; in-memory if omitted
  --log-level=<l>            debug | info | warn | error  (default: info)
  --log-format=<f>           console | json  (default: console)
  --data-from-yaml=<path>    YAML seed file (planned; parsed but no-op in v0)
  -v, --version
  -h, --help
```

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
npm run typecheck   # tsc --noEmit
npm run lint        # biome check
node --test
node bin/bigquery-local.ts --project=local --port=9050
```

CI runs `tsc --noEmit`, `biome check`, and `node --test` on Linux
and macOS, Node 24+. `noExplicitAny` is enforced; `tsconfig.json`
sets `erasableSyntaxOnly` so no syntax that would require runtime
transformation can slip in.

---

## License

MIT

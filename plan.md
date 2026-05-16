# bigquery-local — plan

A Node.js, Docker-friendly local emulator for the Google BigQuery REST
API, backed by DuckDB. The ambition: a **full local stand-in for
BigQuery** that any BigQuery client (`@google-cloud/bigquery`,
`google-cloud-bigquery` for Python, `bq` CLI, JDBC/ODBC drivers,
Looker/dbt/etc.) can point at without code changes — useful for
testing, CI, and local development against BQ-shaped data.

Not production-ready (single node, no auth, no encryption, no
multi-tenant isolation), but architected to stay close to real BQ so it
can also serve as a **migration on-ramp**: a project that later wants
to move off BigQuery onto DuckDB inherits a working translation layer.

---

## Why this exists

Today's options for running BigQuery locally have two common gaps:

- **`PATCH` on tables is often a no-op**, which breaks the
  schema-evolution path (`table.setMetadata({ schema })`). Any client
  that adds a column to an existing table — a common BigQuery
  pattern — fails silently against those emulators, and you only find
  out in prod.
- **Images tend to be amd64-only**, so on Apple Silicon they run
  under Rosetta. A native arm64 build is faster and stops the "works
  on my x86 CI but slow on my laptop" papercut.

The longer-term ambition is broader: a Node-based local BigQuery for
anyone who wants to test BigQuery code without paying for a real
project, and a usable on-ramp for projects that want to migrate away
from BigQuery onto DuckDB. v0 ships the supported surface listed
below — every entry has tests — and grows from there.

---

## Goals

1. **Implement the BigQuery REST API faithfully enough that any
   BigQuery client works unchanged.** Same default ports and flag
   names other emulators use (so swapping is one-line), but the real
   target is parity with Google's published API — not parity with any
   specific emulator.
2. **`PATCH` on datasets and tables actually mutates state**,
   including `schema.fields` additions (the immediate gap that kicked
   this off, and the most common reason emulators surprise people).
3. **One well-chosen native dep, otherwise stdlib.** DuckDB is the
   storage + SQL engine via `@duckdb/node-api`. Chosen because BQ's
   data model (`ARRAY`, `STRUCT`, `NUMERIC`, `UNNEST`) maps onto
   DuckDB almost 1:1 — the SQL translator stays small. Everything
   else uses Node 24+ built-ins: `node:http` for the server,
   `node:test` for tests, `node:crypto` for etags,
   `node:zlib`/`node:stream` for transport.
4. **Multi-arch Docker** (`linux/amd64` + `linux/arm64`).
5. **Either container or local binary**, same code path.
6. **No BigQuery-incompatible shortcuts.** No "convenience" endpoints,
   no non-standard query syntax, no emulator-only flags that change
   query semantics. The SQL translator stays a thin shim over DuckDB
   so it doubles as a reusable bridge for projects migrating off
   BigQuery.

## Non-goals (v0 — not forever)

- IAM resource APIs (not implemented anywhere in v0; later, semantic
  stubs).
- BigQuery ML.
- gRPC BigQuery Storage Read API and Storage Write API. v0 binds the
  gRPC port cleanly and returns UNIMPLEMENTED so clients fail fast
  instead of hanging; real implementation is a post-v0 milestone.
- JavaScript UDFs.
- Full BigQuery Standard SQL parity in v0 — the project grows toward
  parity in later releases. v0 covers the surface listed under "v0
  supported surface"; everything outside that returns a clear
  "unsupported feature" error so we can see exactly what to add next.
- Production hardening (auth, encryption, multi-tenancy, HA). Out of
  scope as a non-goal, but kept architecturally clean so it's
  addable later if anyone wants to push that direction.

---

## Compatibility surface

The CLI, ports, and behavior v0 commits to:

| Surface | v0 behavior |
|---|---|
| Default REST port | 9050 |
| Default gRPC port | 9060 (binds, returns UNIMPLEMENTED) |
| `--project` flag | required (repeatable for multi-project) |
| `--port`, `--grpc-port`, `--log-level`, `--log-format` | supported |
| `--database <file>` | DuckDB file path; `:memory:` if omitted |
| `--data-from-yaml` | parsed, applied (P1) |
| `STORAGE_EMULATOR_HOST` env | accepted; GCS load is P2 |
| Discovery doc | served at `/discovery/v1/apis/bigquery/v2/rest` |
| Auth | none; accepts any/no credentials |
| Container image | `docker.io/jtwebman/bigquery-local`, multi-arch (amd64 + arm64) |

---

## v0 supported surface

Everything in this section ships in v0 with dedicated tests in
`test/api/` and `test/conformance/`. Anything not listed is either
P1+ or returns a clear "unsupported feature" error.

**REST endpoints**

- `GET /discovery/v1/apis/bigquery/v2/rest`
- `GET`, `POST`, **`PATCH`**, `DELETE` on `/projects/{p}/datasets[/{d}]`
- `GET`, `POST`, **`PATCH`**, `DELETE` on `/projects/{p}/datasets/{d}/tables[/{t}]`
- `POST /projects/{p}/datasets/{d}/tables/{t}/insertAll` (streaming inserts)
- `POST /projects/{p}/queries` (`jobs.query`, including `params` + `parameterMode=NAMED`)
- `POST /projects/{p}/jobs` (`jobs.insert` — query jobs)
- `GET /projects/{p}/jobs/{j}`
- `GET /projects/{p}/queries/{j}` (`getQueryResults`)

ETags + `If-Match` on PATCH return `412` on mismatch.

**SQL features**

- Backtick refs: `` `dataset.table` ``, `` `project.dataset.table` ``
- `SELECT` with `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`, `OFFSET`
- `JOIN`: `INNER`, `LEFT`, `RIGHT`, `FULL OUTER`, `CROSS`, `CROSS JOIN UNNEST`
- Aggregates: `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `STRING_AGG`, `ARRAY_AGG`
- `IS [NOT] NULL`, `COALESCE`, `IFNULL`, `NULLIF`, `LEAST`, `GREATEST`
- `JSON_VALUE`, `JSON_EXTRACT_*`, `TO_JSON_STRING`, `PARSE_JSON`
- `CURRENT_TIMESTAMP`, `TIMESTAMP_ADD`, `TIMESTAMP_SUB`, `INTERVAL n {DAY|HOUR|MINUTE|SECOND}`
- `STARTS_WITH`, `ENDS_WITH`, `CONTAINS_SUBSTR`, `REGEXP_CONTAINS`
- Named parameters (`@name`) with `parameterMode=NAMED` and explicit `types`
- `UNNEST(@arr)` with `types: { name: ['STRING' | ...] }`
- `INSERT INTO … SELECT …`, `INSERT INTO … VALUES (...)`
- `WITH` / `WITH RECURSIVE` (CTEs)
- Subqueries: correlated, scalar, `EXISTS`, `IN`, `ANY`/`SOME`/`ALL`
- Set ops: `UNION` / `INTERSECT` / `EXCEPT` (ALL or DISTINCT)
- `SAFE_CAST(x AS t)`

**Types & modes**

- `STRING`, `BYTES`, `INT64`/`INTEGER`, `FLOAT64`/`FLOAT`, `BOOL`/`BOOLEAN`
- `NUMERIC`, `BIGNUMERIC` (latter preserved as decimal string)
- `TIMESTAMP`, `DATETIME`, `DATE`, `TIME`
- `JSON`
- `GEOGRAPHY` (WKT round-trip; `ST_*` functions are post-v0)
- `ARRAY<T>` (`REPEATED` mode)
- `STRUCT<…>` / `RECORD`
- Modes: `NULLABLE`, `REQUIRED`, `REPEATED`

**Headline end-to-end behavior in `test/conformance/`**

1. Create dataset → create table with initial schema.
2. Stream rows via `tabledata.insertAll`.
3. `PATCH` the table schema to add a column.
4. Subsequent `insertAll` populates the new column.
5. A parameterized query exercising `JSON_VALUE`, `TIMESTAMP_SUB`, and `UNNEST(@arr)` returns expected rows.

---

## Architecture

```
┌──────────────────────────────────┐
│  bin/bigquery-local.ts           │  CLI: parse flags → start server
└─────────────┬────────────────────┘
              ▼
┌──────────────────────────────────┐
│  src/server.ts (node:http)       │  router, JSON in/out, etag/If-Match
└─────────────┬────────────────────┘
              ▼
┌─────────────────────────────────────────────────┐
│  src/routes/{datasets,tables,jobs,queries,…}    │  REST handlers
└─────────────┬───────────────────────────────────┘
              ▼
┌──────────────────────────────────┐         ┌──────────────────────────┐
│  src/storage (DuckDB)            │ ◄─────► │  src/sql/translate.ts    │
│  metadata + table data           │         │  BQ SQL → DuckDB SQL     │
└──────────────────────────────────┘         └──────────────────────────┘
```

**No express.** With ~25 endpoints on fixed paths, a 60-line router on
`node:http` is simpler and removes the dep. Pattern: register
`(method, pathTemplate, handler)`; match against a precompiled regex table.

**One DuckDB file** (or `:memory:`) per emulator instance. Multi-project
support uses a `project` column on metadata tables; not separate DBs.

**Datasets map to DuckDB schemas**, tables map to DuckDB tables —
`CREATE SCHEMA "{dataset_id}"; CREATE TABLE "{dataset_id}"."{table_id}"
(...)`. That mirrors BigQuery's `dataset.table` namespacing without
mangling identifiers.

---

## SQL translation

This is the hard part. We're **not** writing a full parser. Approach:

1. **Tokenize** input SQL (handle strings, backticks, line/block comments).
2. **Walk-and-rewrite** with a small set of targeted transforms:

   | BQ idiom | DuckDB output |
   |---|---|
   | `` `proj.dataset.table` ``, `` `dataset.table` `` | `"dataset"."table"` |
   | `@name` | `$name` (DuckDB has native named parameters) |
   | `UNNEST(@arr)` / `UNNEST(arr)` | pass-through — DuckDB has native `UNNEST` |
   | `CURRENT_TIMESTAMP()` | `CURRENT_TIMESTAMP` (drop the parens) |
   | `TIMESTAMP_SUB(x, INTERVAL n DAY)` | `x - INTERVAL n DAY` |
   | `TIMESTAMP_ADD(x, INTERVAL n DAY)` | `x + INTERVAL n DAY` |
   | `JSON_VALUE(j, '$.path')` | `json_extract_string(j, '$.path')` |
   | `STARTS_WITH(s, p)` | pass-through (`starts_with`) |
   | `ENDS_WITH(s, p)` | pass-through (`ends_with`) |
   | `SAFE_CAST(x AS t)` | `try_cast(x AS t)` |
   | `IFNULL`, `COALESCE`, `NULLIF`, `LEAST`, `GREATEST` | pass-through |

   Most BQ idioms in the v0 supported surface are pass-through under
   DuckDB — the rewriter only needs to fix backtick identifiers,
   named params, a handful of function names, and `INTERVAL`-style
   arithmetic.

3. **Parameter binding.** Read `params` + `parameterMode=NAMED` from the
   request; preserve declaration order to map back to positional `?`. Use
   `types` hints to coerce input (e.g. `STRING` arrays serialized to JSON
   for `UNNEST`).
4. **Result shaping.** Map result columns back to BQ-style
   `{ schema: { fields: [...] }, rows: [{ f: [{ v: ... }, ...] }, ...] }`.
   Timestamps round-trip as ISO 8601; JSON columns as strings;
   `REPEATED` columns as arrays.
5. **Unknown idioms.** Fail loudly with a `queryJobError` containing the
   offending token. Easier to learn what to add next than to silently
   produce wrong results.

**Explicitly out of v0 SQL scope** (we'll add as needed):
- Window functions (PARTITION BY OVER)
- `WITH` CTEs pass through (DuckDB supports recursive + non-recursive)
- `MERGE`, `EXCEPT DISTINCT`, scripting (`DECLARE`, `SET`, `CALL`, `BEGIN`)
- ARRAY/STRUCT literal projection in result rows beyond JSON encoding

---

## Storage layout (DuckDB)

**On-disk format (v0):** a single DuckDB native file — `bq.duckdb` (or
whatever `--database=` points at), or fully in-memory when `--database`
is omitted. The file is DuckDB's own opaque columnar format; think of
it as the columnar equivalent of a `.sqlite` file: one file holds every
schema, table, index, and transaction log for the whole emulator.
DuckDB ships everything we need on top of that file out of the box —
`CREATE SCHEMA`, `CREATE TABLE`, `ALTER TABLE … ADD COLUMN` (which is
what makes `tables.patch` a few lines of SQL), `INSERT`, transactions,
ATTACH, and BigQuery-style types (`STRUCT`, `LIST`, `DECIMAL`, `JSON`).

A future option — **Parquet-backed tables** (each table is one or
more Parquet files in a directory, with a tiny DuckDB catalog
file pointing at them) — buys us inspectable storage, near-free
Storage Read API export, and near-free Parquet load jobs. Deferred
until we need any of those. Migration would be additive: views or
`CREATE TABLE AS SELECT * FROM read_parquet(…)` over the same `_bq`
metadata schema.

Metadata lives in a dedicated `_bq` schema so user-visible datasets get
clean DuckDB schemas of their own:

- `_bq.datasets(project, dataset_id, etag, location, friendly_name,
  description, labels JSON, default_table_expiration_ms,
  created_ms, updated_ms, PRIMARY KEY(project, dataset_id))`
- `_bq.tables(project, dataset_id, table_id, type, etag, schema JSON,
  description, num_rows, created_ms, updated_ms, expiration_ms,
  partitioning JSON, clustering JSON,
  PRIMARY KEY(project, dataset_id, table_id))`
- `_bq.jobs(project, job_id, state, statement_type, error JSON, query,
  params JSON, types JSON, created_ms, started_ms, ended_ms,
  result_schema JSON, result_total_rows,
  PRIMARY KEY(project, job_id))`
- `_bq.job_rows(project, job_id, row_index, row JSON,
  PRIMARY KEY(project, job_id, row_index))`

User data tables: `"{dataset_id}"."{table_id}"` with columns typed per
the BQ→DuckDB type map:

| BQ type | DuckDB | Notes |
|---|---|---|
| STRING | VARCHAR | |
| BYTES | BLOB | |
| INT64 / INTEGER | BIGINT | |
| FLOAT64 / FLOAT | DOUBLE | |
| BOOL / BOOLEAN | BOOLEAN | |
| NUMERIC | DECIMAL(38,9) | matches BQ precision/scale |
| BIGNUMERIC | VARCHAR | DuckDB caps DECIMAL at 38 precision; keep as decimal string |
| TIMESTAMP | TIMESTAMP WITH TIME ZONE | |
| DATETIME | TIMESTAMP | |
| DATE / TIME | DATE / TIME | |
| GEOGRAPHY | VARCHAR | WKT in, WKT out; no `ST_*` in v0 |
| JSON | JSON | DuckDB native |
| ARRAY<T> / `REPEATED` | `T[]` (LIST) | DuckDB native |
| STRUCT<…> / RECORD | STRUCT(…) | DuckDB native |

ETags: `sha256(canonicalJson(metadata)).slice(0,16)`. `PATCH` honors
`If-Match` when present and returns 412 on mismatch; otherwise applies.

---

## API surface (priority order)

**P0 — v0 supported surface**

- `GET /discovery/v1/apis/bigquery/v2/rest`
- Datasets: `GET`, `POST`, **`PATCH`**, `DELETE`
- Tables: `GET`, `POST`, **`PATCH`**, `DELETE`
- `POST .../tables/{t}/insertAll`
- Jobs query: `POST /projects/{p}/queries` (sync path)
- Jobs: `POST /projects/{p}/jobs`, `GET /projects/{p}/jobs/{j}`,
  `GET /projects/{p}/queries/{j}` (getQueryResults)

**P1 — broader emulator parity**

- List datasets, list tables, list jobs (with pagination)
- `--data-from-yaml` loader (treat YAML as initial seed)
- `tabledata.list`
- `jobs.cancel`, `jobs.delete`
- `POST /projects/{p}/datasets/{d}/tables/{t}/copy`

**P2 — later**

- Routines, models (stub with empty list responses)
- GCS load jobs (needs `STORAGE_EMULATOR_HOST` wiring)
- gRPC Storage Read API (Avro/Arrow) — large; separate effort

---

## CLI / package

```
$ bigquery-local --project=local --port=9050 --database=./bq.db
```

- Bin names: `bigquery-local`, `bqlocal`.
- Flag parser is hand-written (~40 lines, no `commander`).
- Logging: structured JSON when `--log-format=json`, console otherwise.

**Language: TypeScript end-to-end, run directly under Node 24's
native type stripping** — no transpile step for local dev, tests, or
the Docker image. TypeScript is in `devDependencies` purely for
type-checking (`tsc --noEmit`). Lint enforced by Biome (single
devDep, also formats, has a built-in `noExplicitAny` rule). No
`.mjs`, no `.js` source files — `.ts` only.

`tsconfig.json` is set to the strictest realistic profile. (TS 6.0
flipped `strict: true` to the default and bumped `target` to
`ES2025` / `module` to `esnext`; we still set the flags below
explicitly so the config is self-documenting and doesn't drift if
defaults change again.)

- `"strict": true` (the whole strict family)
- `"noUncheckedIndexedAccess": true` — indexed access returns `T | undefined`, forces explicit checks
- `"exactOptionalPropertyTypes": true` — `?:` and `| undefined` stay distinct
- `"noImplicitOverride": true`, `"noFallthroughCasesInSwitch": true`, `"noImplicitReturns": true`
- `"noPropertyAccessFromIndexSignature": true`
- `"useUnknownInCatchVariables": true` — `catch (e)` is `unknown`
- `"noUnusedLocals": true`, `"noUnusedParameters": true`
- `"isolatedModules": true`, `"verbatimModuleSyntax": true` — match Node's strip-types semantics
- **`"erasableSyntaxOnly": true`** — bans enums, namespaces,
  parameter properties, and other constructs that require
  transformation rather than erasure; keeps the "no build at runtime"
  guarantee enforceable at the type-checker level
- `"allowImportingTsExtensions": true` — imports must include `.ts`
- `"noEmit": true` — TS never emits at dev time; the runtime never sees TS syntax

Biome config bans explicit `any` (`suspicious/noExplicitAny: error`)
plus a small set of correctness rules. CI runs `tsc --noEmit`,
`biome check`, and `node --test` on every push.

`package.json`:
- `"type": "module"`
- `"engines": { "node": ">=24.0.0" }`
- `"dependencies": { "@duckdb/node-api": "1.5.2-r.1" }` — sole runtime dep.
- `"devDependencies": { "typescript": "6.0.3", "@biomejs/biome": "2.4.15", "@google-cloud/bigquery": "8.3.1" }`
  — typechecker, linter, real BQ client for `test/api/`. (TS 7 went
  beta in April 2026 on the native Go-based compiler; we'll evaluate
  once it's stable, but staying on 6 keeps editor/IDE compat broad.)

**Version pinning is exact, project-wide.** Every dep — runtime and
dev — is written as a plain `X.Y.Z` (or `X.Y.Z-tag` for the DuckDB
release suffix), no `^`, `~`, or `*`. A committed `.npmrc` sets
`save-exact=true` so `npm install <pkg>` never reintroduces a caret.
Upgrades are deliberate, one PR per bump, with the conformance
suite as the gate. Versions above are the latest stable as of
2026-05-15; we re-pin on every intentional upgrade.

**Minimizing devDeps further (open option):** `@google-cloud/bigquery`
is the heaviest devDep. We could drop it and write `test/api/`
against `fetch` directly — that would actually be a stronger
conformance check (we'd be testing the BigQuery REST wire protocol
rather than going through Google's permissive client). Keeping it
in v0 because catching real-world client behavior is high value
while the API surface is small. Reconsider in v0.x.
- **Library entry point**: `src/index.ts` exports a `createServer(config)`
  returning a server handle (with `.listen()`, `.close()`, `.url`)
  so other Node code can embed the emulator in-process — e.g., spin
  one up inside a test suite without Docker. CLI flags are just a
  thin wrapper around the same factory.
- `"exports"` and `"types"` route library consumers to the published
  build (see Publishing below); in-repo work loads `src/index.ts`
  directly.
- `"bin"`: `bigquery-local` → `bin/bigquery-local.ts`. Node 24+
  executes `.ts` files natively; the shebang is `#!/usr/bin/env node`.

**Publishing to npm** (separate from the Docker image): `prepublishOnly`
runs `tsc` to emit `.js` + `.d.ts` into `dist/`. `"main"`, `"types"`,
and `"exports"` point at `dist/` for published consumers, so anyone
on Node 20+ can `import { createServer } from 'bigquery-local'`
without needing strip-types. The Docker image and local dev never
touch `dist/` — they run the `.ts` source directly.

---

## npm scripts

```json
{
  "scripts": {
    "format":       "biome format --write .",
    "format:check": "biome format .",
    "lint":         "biome lint .",
    "lint:fix":     "biome lint --write .",
    "typecheck":    "tsc --noEmit",
    "test":         "node --test --test-reporter=spec",
    "test:coverage":"node --test --experimental-test-coverage --test-coverage-lines=90 --test-coverage-branches=90 --test-coverage-functions=90",
    "build":        "tsc",
    "prepublishOnly":"npm run build"
  }
}
```

- `format` / `format:check` — Biome formatter. CI uses `format:check`.
- `lint` / `lint:fix` — Biome linter; `noExplicitAny: error` is on.
- `typecheck` — strict `tsc --noEmit`.
- `test` — `node --test` walks `test/**/*.test.ts`, type-stripped at
  runtime.
- `test:coverage` — same plus thresholds; Node exits non-zero when
  any of line / branch / function coverage drops below 90%.
- `build` — emits `dist/` (`.js` + `.d.ts`) for npm consumers.
- `prepublishOnly` — npm's standard publish hook.

**CI pipeline (one shell line):**

```
npm ci && npm run format:check && npm run lint && npm run typecheck && npm run test:coverage
```

### Biome vs Prettier vs ESLint

The 2026 standard for new Node + TypeScript projects is **Biome** —
a single Rust binary that handles formatting (Prettier-compatible
defaults), linting (covers most ESLint + `typescript-eslint` rules
including `noExplicitAny`), and import sorting. TSLint has been
deprecated since 2019.

Picking Biome here:

- One devDep instead of four (`prettier`, `eslint`,
  `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`,
  plus `eslint-config-prettier`).
- One config file (`biome.json`) instead of `.prettierrc` +
  `.eslintrc.*` + plugin config.
- Single command for format / lint, simpler CI.
- Roughly 10–20× faster than ESLint+Prettier on the same codebase.

If we ever need a rule Biome doesn't have, the escape hatch is
adding ESLint alongside — but that's a later, deliberate step.

### Coverage target

Coverage threshold is **90% lines, 90% branches, 90% functions**,
enforced by `node --test`'s built-in thresholds. Node exits 1 when
any threshold is missed, which fails CI. We aim for the floor, not
a hard ceiling — 100% is rarely worth the test bloat. Add an
`/* node:coverage disable */` comment around clearly unreachable
branches (e.g., `default:` cases for exhaustive switches over union
types) rather than fake-covering them.

---

## Docker

- Base: `node:24-alpine`.
- Multi-stage: stage 1 prunes devDeps; stage 2 copies `src/`, `bin/`,
  `package.json`. Final image < 80 MB.
- `docker buildx` for `linux/amd64,linux/arm64` in CI.
- Publish to Docker Hub: `docker.io/jtwebman/bigquery-local`.
  Requires repo secrets `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN`
  (a Docker Hub access token, not the account password), wired into
  `docker/login-action@v3` in `publish.yml`.
- Drop-in for any existing BigQuery emulator container: point
  `image:` at `docker.io/jtwebman/bigquery-local:0.1.0`, drop any
  `platform: linux/amd64` pin (we're multi-arch), keep existing
  `command:` flags like `--project=<id> --port=9050`.

---

## Testing

- Runner: `node --test`. No Jest, no Vitest. Test files are `.ts`
  and run directly under Node 24's native type stripping — no
  transpile, no register hook.
- Layers:
  - `test/unit/sql/` — translator unit tests (BQ in → expected DuckDB out).
  - `test/unit/types/` — BQ↔DuckDB type coercion.
  - `test/api/` — boots an emulator on a random port via
    `createServer()` and drives it with the real
    `@google-cloud/bigquery` Node client (devDep). One test per
    endpoint covering happy path + a few errors + etag/If-Match.
  - `test/conformance/` — exercises the v0 supported surface
    end-to-end, including the **PATCH schema add column + re-insert**
    path most existing emulators stumble on.
- CI on every push: `tsc --noEmit` (type-check), `biome check`
  (lint + format check), `node --test`. Matrix on Node 24, Ubuntu +
  macOS.

---

## Repository layout

```
bigquery-local/
├── plan.md
├── README.md
├── LICENSE                    # MIT
├── package.json
├── tsconfig.json              # strict, erasableSyntaxOnly, noEmit
├── biome.json                 # noExplicitAny + formatter
├── .npmrc                     # save-exact=true (keeps every dep pinned)
├── .gitignore
├── .github/workflows/
│   ├── ci.yml                 # tsc --noEmit + biome check + node --test
│   └── publish.yml            # docker buildx + Docker Hub push on tag
├── Dockerfile
├── bin/
│   └── bigquery-local.ts      # CLI; runs natively under Node 24 strip-types
├── src/
│   ├── index.ts               # public library API: createServer(...)
│   ├── server.ts              # http + router + middleware
│   ├── routes/
│   │   ├── discovery.ts
│   │   ├── datasets.ts
│   │   ├── tables.ts
│   │   ├── tabledata.ts       # insertAll
│   │   ├── jobs.ts
│   │   └── queries.ts
│   ├── storage/
│   │   ├── db.ts              # @duckdb/node-api wrapper + connection
│   │   ├── meta.ts            # _bq.* CRUD
│   │   ├── data.ts            # user-table CRUD, type coercion
│   │   └── types.ts           # BQ ↔ DuckDB type map
│   ├── sql/
│   │   ├── tokenize.ts
│   │   ├── translate.ts
│   │   └── shape.ts           # row → BQ response shape
│   └── util/
│       ├── etag.ts
│       ├── ids.ts
│       ├── errors.ts          # BQ-shaped error responses
│       └── log.ts
└── test/
    ├── api/                   # *.test.ts
    ├── conformance/           # *.test.ts
    └── unit/                  # *.test.ts
```

---

## Work plan

The actual work is broken into single-context backlog items in
[`BACKLOG.md`](./BACKLOG.md). Each item is sized to fit a focused
~1–4 hour work session, has explicit dependencies, and lists its own
acceptance criteria so anyone (human or agent) can pick it up cold.

Phases in `BACKLOG.md`:

1. Repo & infra (scaffold, CI, gh repo create)
2. HTTP + DuckDB foundation (server, router, error shape, DuckDB
   connection, metadata schema, type map)
3. REST endpoints (datasets, tables, tabledata.insertAll)
4. SQL (tokenizer, translator, query endpoint, jobs endpoints)
5. CLI, library, packaging
6. Testing & coverage to 90%
7. Distribution (Docker, npm publish, README polish)

Total v0 estimate is ~40 focused hours across ~25 backlog items.

---

## Open questions

1. **Support older Node versions?** v0 targets Node 24+ so we get
   native `.ts` type stripping with zero transpile. Anyone on Node
   20–23 still gets the published library via the compiled `dist/`,
   but the Docker image and CLI are Node 24+ only. Revisit if someone
   asks for an older-Node Docker tag.
2. **`@google-cloud/bigquery` client retries.** It retries 5xx with
   backoff. Our error shape needs to match closely enough that retries
   trigger on transient errors and not on validation 4xx. Verify via
   `test/api/` smoke tests early in M1.
3. **ETag semantics.** Real BQ uses opaque etags. We can use any stable
   hash; the only constraint is the client compares for equality. Confirm
   `@google-cloud/bigquery` doesn't parse the etag.
4. **Multi-project.** The current emulator takes a single `--project`.
   We'll allow repeated `--project` flags but default to one for parity.
5. **Long-running queries.** Real BQ returns `jobComplete: false` when
   a query times out, and the client polls `getQueryResults`. DuckDB
   queries run synchronously on the calling thread — we can always set
   `jobComplete: true` on first response. Keep `getQueryResults`
   working for clients that still poll.
6. **gRPC Storage Read API.** Big enough to be its own milestone after
   v0. Bind `9060` and return UNIMPLEMENTED in v0 so client failures are
   loud and we get signal on demand.

---

## Definition of done for v0 (0.1.0)

- [ ] `gh repo create jtwebman/bigquery-local --public` exists with
      MIT license and a README that shows how to point a real
      BigQuery client at it.
- [ ] `node --test` passes locally and in CI.
- [ ] `docker buildx build --platform linux/amd64,linux/arm64` succeeds.
- [ ] `docker.io/jtwebman/bigquery-local:0.1.0` published.
- [ ] End-to-end behavior in `test/conformance/` passes:
      - creates a dataset + table on first run,
      - adds a new column via `PATCH` and inserts rows that populate it,
      - inserts rows successfully through `tabledata.insertAll`,
      - returns expected results from a parameterized query
        exercising `JSON_VALUE`, `TIMESTAMP_SUB`, and `UNNEST(@arr)`.

---

# Appendix: Full BigQuery scope survey

Scoping reference, **not** a commitment. Goal: enumerate everything
Google BigQuery exposes so we can knowingly decide what stays out of
v0 and what gets pushed to v1/v2/never. Hours are real coding hours
(per the "don't estimate in engineer-days" rule), not calendar time.
When a number has a wide range, the low end assumes we allow a
runtime dep for that piece (e.g. a Parquet reader); the high end is
zero-deps.

**Headline:** full parity is on the order of **1,000–1,500 hours** of
coding before counting BigQuery ML. With ML, multiply by ~2–3×. This
isn't a weekend project at full scope — it's a 6–9 month effort. v0
is ruthlessly carved out of the items marked **P0** below; see
`BACKLOG.md` for the actual phased work.

> **Engine note.** Many of the per-feature hours below were estimated
> against a generic SQL engine. v0 uses DuckDB, which has native
> support for `ARRAY`, `STRUCT`, `NUMERIC`/`DECIMAL`, `JSON`,
> `UNNEST`, window functions, and most of the SQL surface, so the
> realized v0 hours for the items DuckDB covers natively are
> substantially lower than the survey numbers suggest.

---

## 1. REST API surface (v2)

| Resource | Methods | Hours | Priority |
|---|---|---|---|
| Datasets | get, insert, list, patch, update, delete, undelete | 6 | P0 |
| Tables | get, insert, list, patch, update, delete | 8 | P0 |
| Tabledata | insertAll, list (paginated) | 6 | P0 |
| Jobs | get, insert, list, cancel, delete, query (sync), getQueryResults | 8 | P0 |
| Routines | get, insert, list, update, delete | 4 | P1 |
| Models | get, list, patch, delete | 4 | P2 |
| Projects | list, getServiceAccount | 1 | P1 |
| RowAccessPolicies | list, getIamPolicy, setIamPolicy, testIamPermissions | 4 | P2 |
| IAM bindings (datasets / tables / models / routines) | get/set/test | 6 | P2 |
| Reservations API (slots) | get/list/insert/update/delete + assignments | 6 | P3 (stub) |
| Connections API (external data source configs) | CRUD | 4 | P2 |
| Discovery doc | static | 1 | P0 ✓ |
| Error shapes (Google-style `{ error: { code, errors[], message } }`) | — | 4 | P0 |
| ETag / If-Match semantics across resources | — | 4 | P0 |

**REST subtotal: ~66 hours.**

---

## 2. SQL — type system

| Type | Storage strategy | Hours |
|---|---|---|
| INT64, FLOAT64, BOOL, STRING, BYTES | native in any SQL engine | 2 |
| NUMERIC (38 digit), BIGNUMERIC (77 digit) decimals | engine `DECIMAL` (DuckDB caps at 38) + string fallback for the wider type | 15 |
| DATE, DATETIME, TIME, TIMESTAMP | engine temporal types + semantic rules | 12 |
| INTERVAL | canonical form + arithmetic rules | 6 |
| GEOGRAPHY | WKB/WKT serde | 8 |
| JSON | native in DuckDB; TEXT + JSON1 in SQLite | 4 |
| ARRAY<T> | DuckDB native LIST; JSON-encoded TEXT elsewhere | 8 |
| STRUCT<…> | DuckDB native STRUCT; JSON-encoded TEXT elsewhere | 6 |
| RANGE<T> | canonical form | 4 |

**Type system subtotal: ~65 hours** (lower under DuckDB for most rows).

Implicit-cast rules, comparison rules, NULL semantics, type coercion
in arithmetic, format strings (`FORMAT_TIMESTAMP`, `PARSE_*`,
%-tokens): another **~20 hours** sprinkled across the function set.

---

## 3. SQL — built-in functions

BQ has on the order of **700+ built-in functions**. By category:

| Category | Approx count | Hours | Notes |
|---|---|---|---|
| String | ~50 | 15 | `SUBSTR`, `REGEXP_*`, `FORMAT`, `LPAD`/`RPAD`, `NORMALIZE`, … |
| Numeric / math | ~40 | 10 | `TRUNC`, `MOD`, `SAFE_DIVIDE`, `IEEE_DIVIDE`, … |
| Date / time | ~80 across DATE/DATETIME/TIME/TIMESTAMP/INTERVAL | 30 | `FORMAT_*`, `PARSE_*`, `DATE_TRUNC`, `GENERATE_DATE_ARRAY`, … |
| JSON | ~20 | 10 | `JSON_VALUE`, `JSON_QUERY`, `JSON_EXTRACT_*`, `TO_JSON`, `PARSE_JSON`, `JSON_KEYS`, `JSON_TYPE`, … |
| Array | ~30 | 15 | `ARRAY_AGG`, `ARRAY_CONCAT`, `ARRAY_LENGTH`, `ARRAY_TO_STRING`, `GENERATE_*_ARRAY`, `UNNEST`, `ARRAY_REVERSE`, `OFFSET`/`ORDINAL`/`SAFE_OFFSET`, … |
| Aggregate | ~30 | 15 | `SUM`, `COUNT`, `ARRAY_AGG`, `STRING_AGG`, `ANY_VALUE`, `LOGICAL_AND`/`OR`, `BIT_AND`/`OR`/`XOR`, … |
| Approximate aggregation | ~15 | 15 | `APPROX_COUNT_DISTINCT`, `APPROX_QUANTILES`, `HLL_COUNT.*`, `KLL_QUANTILES.*` — needs sketches |
| Statistical aggregate | ~10 | 8 | `CORR`, `COVAR_*`, `STDDEV_*`, `VAR_*` |
| Window / analytic | ~15 | 10 | `OVER` + frame syntax is supported by DuckDB; need to map BQ-specific spellings |
| Hash / fingerprint | ~6 | 4 | `FARM_FINGERPRINT`, `MD5`, `SHA1`/`256`/`512` |
| Bitwise | ~5 | 3 | `BIT_COUNT`, shifts, bit ops |
| Conditional / null | ~10 | 5 | `IF`, `IFNULL`, `COALESCE`, `NULLIF`, `CASE`, `GREATEST`, `LEAST` |
| Conversion / cast | ~10 | 6 | `CAST`, `SAFE_CAST`, format-aware conversions |
| Net / debugging | ~10 | 4 | `NET.IP_FROM_STRING`, `NET.IP_TO_STRING`, `NET.HOST`, … |
| `SAFE.` prefix on every function | — | 6 | Wrap any function to return `NULL` on error instead of raising |
| Geography (`ST_*`) | ~70 | 40–80 | Needs S2 cells or a geo lib. `ST_GEOGFROMTEXT`, `ST_INTERSECTS`, `ST_DISTANCE`, `ST_BUFFER`, … |
| `ML.*` functions | ~15 | 60+ | Only meaningful with trained models — skip in any realistic scope |
| Search (`SEARCH` function, search indexes) | ~5 | 15 | Tokenizer + inverted index |
| Vector (`VECTOR_SEARCH`, `ML.DISTANCE` in vector mode) | ~5 | 25 | ANN index, embedding distance |
| Federated / external (`EXTERNAL_QUERY`) | ~3 | 30 | Needs target system clients (Spanner / Cloud SQL / Bigtable) — skip |

**Functions subtotal (excluding ML / federated): ~250–300 hours.**

---

## 4. SQL — statements & language features

| Feature | Hours | Notes |
|---|---|---|
| `SELECT` (`FROM` / `WHERE` / `GROUP` / `HAVING` / `ORDER` / `LIMIT` / `OFFSET`) | 4 | mostly engine pass-through |
| `JOIN`: `INNER`, `LEFT`/`RIGHT`/`FULL OUTER`, `CROSS`, `LATERAL` (`CROSS JOIN UNNEST`) | 6 | `LATERAL UNNEST` is the tricky one (DuckDB-native) |
| Set ops: `UNION`/`INTERSECT`/`EXCEPT` (ALL or DISTINCT) | 3 | |
| Subqueries: correlated, scalar, `EXISTS`, `IN`, `ANY`/`SOME`/`ALL` | 4 | |
| `WITH` CTE, `WITH RECURSIVE` | 3 | DuckDB supports natively |
| `GROUP BY ROLLUP` / `CUBE` / `GROUPING SETS` | 8 | Rewrite to `UNION ALL` of regular `GROUP BY` |
| `QUALIFY` | 3 | Rewrite to outer subquery + `WHERE` |
| `PIVOT` / `UNPIVOT` | 8 | Rewrite to `UNION ALL` + conditional aggregation |
| `TABLESAMPLE` | 3 | Random rows or sysrandom |
| Wildcard tables (`events_*` + `_TABLE_SUFFIX`) | 8 | Resolve at parse time to `UNION ALL` |
| `INSERT` / `UPDATE` / `DELETE` | 4 | engine-native |
| `MERGE` | 8 | Non-trivial to rewrite if the engine doesn't support it directly |
| `TRUNCATE TABLE` | 1 | |
| DDL: `CREATE`/`ALTER`/`DROP TABLE` | 6 | Schema diffs, table options |
| DDL: `VIEW` (incl. authorized views) | 4 | |
| DDL: `MATERIALIZED VIEW` | 12 | DDL + refresh strategy + query rewrite to use them |
| DDL: `SCHEMA` (dataset) | 2 | |
| DDL: `TABLE FUNCTION` (TVF) | 12 | Returns relation; needs procedural runtime |
| DDL: `FUNCTION` (SQL UDF + JS UDF) | SQL=8, JS=20 | JS UDFs need an isolated JS sandbox |
| DDL: `PROCEDURE` | 25 | Calls scripting runtime |
| DDL: `SEARCH INDEX` | 10 | |
| DDL: `MODEL` | 6 | Metadata only (no training) |
| DDL: `ROW ACCESS POLICY` | 4 | |
| DDL: `EXTERNAL TABLE` / `OBJECT TABLE` | 15 | Reading files from GCS emulator |
| DDL: `SNAPSHOT` / `CLONE` | 8 | COW semantics on metadata |
| `EXPORT DATA` / `LOAD DATA` | 8 | |
| `GRANT` / `REVOKE` | 4 | IAM bindings updates |
| Scripting: `BEGIN`/`END`, `DECLARE`, `SET`, `IF`/`ELSE`, `WHILE`, `LOOP`, `FOR`, `REPEAT`, `BREAK`/`CONTINUE`, `RETURN`, `CALL`, `EXECUTE IMMEDIATE`, exception handlers | 30 | Build a procedural interpreter on top of SQL |
| Multi-statement transactions (`BEGIN`/`COMMIT`/`ROLLBACK`) | 6 | DuckDB has these natively; align semantics |
| Sessions (TEMP scoping, session params) | 8 | |
| `SAFE.` prefix on functions (compile-time wrap) | — | counted above |
| Query parameters (NAMED, POSITIONAL, `@p`, types) | 4 | |
| Time travel (`FOR SYSTEM_TIME AS OF`) | 30 | Requires versioned storage — biggest single feature |
| Dry run (`dryRun: true`) — return schema + bytes-processed estimate | 6 | |
| Query cache (`useQueryCache`) | 6 | Optional |

**Statements / features subtotal: ~270 hours.**

---

## 5. SQL — parsing strategy

The hard architectural call. Three options:

| Approach | Hours | Quality |
|---|---|---|
| **Targeted rewriter (v0 approach):** tokenize, walk, transform a fixed list of BQ idioms → DuckDB SQL | 30–50 | Brittle past covered idioms; great for our queries, poor for arbitrary SQL |
| **Hand-written recursive-descent parser** for BQ Standard SQL → AST → engine codegen | 200–300 | Full coverage of syntax we implement; isolates execution from engine quirks |
| **Embed an existing SQL parser** (e.g. ANTLR grammar, `sqlparser-rs` via WASM) | 60–120 | Faster but pulls a dep and a binding |

Choosing the second path is where most of the SQL hours go in a "full
support" world. v0 stays on path 1.

---

## 6. Streaming ingest (REST)

| Feature | Hours |
|---|---|
| `tabledata.insertAll` happy path | 4 |
| `insertId` dedup window | 3 |
| Template tables (`templateSuffix`) | 4 |
| `skipInvalidRows`, `ignoreUnknownValues` | 2 |
| Partial failure response shape | 2 |

**Streaming REST subtotal: ~15 hours.**

---

## 7. Load jobs

| Source format | Hours (with lib) | Hours (no deps) | Notes |
|---|---|---|---|
| CSV | 4 | 8 | Quoting, header detection |
| JSON (newline-delimited) | 3 | 4 | |
| Avro | 4 | 30 | Avro spec is non-trivial; binary + schema resolution |
| Parquet | 6 | 60+ | Column-store + Thrift + nested types; realistically a dep |
| ORC | 6 | 60+ | Same as Parquet |
| Datastore / Firestore export | 8 | 12 | LevelDB-style export format |
| Apache Iceberg | 15 | 30 | Manifest + snapshot resolution |
| Schema auto-detect | 6 | 6 | |
| Hive partitioning options | 6 | 6 | |
| Local file upload (multipart resumable) | 6 | 6 | |
| GCS reads via `STORAGE_EMULATOR_HOST` | 4 | 4 | Talk to GCS emulator |

**Load jobs subtotal: ~70h (with deps) / ~230h (zero-deps).** DuckDB
reads Parquet natively, which collapses the Parquet row substantially
if we accept that runtime path.

---

## 8. Extract & copy jobs

| Job | Hours |
|---|---|
| Extract to GCS (CSV / JSON / Avro / Parquet) with compression | 10 |
| Copy table (snapshot, clone, deep copy) — uses `jobs.insert` | 5 |

**Extract+copy subtotal: ~15 hours.**

---

## 9. Storage Write API (gRPC, the hard one)

| Feature | Hours (with gRPC lib) | Hours (zero-deps) |
|---|---|---|
| gRPC server scaffold | 4 | 25 (write a minimal gRPC over HTTP/2) |
| Default stream (at-least-once) | 8 | 8 |
| Application streams: buffered, committed, pending | 12 | 12 |
| FlushRows / FinalizeWriteStream / BatchCommitWriteStreams | 6 | 6 |
| Schema updates mid-stream | 4 | 4 |
| Multiplexing | 4 | 4 |
| AppendRows offset semantics + idempotence | 8 | 8 |
| Tests against real `@google-cloud/bigquery-storage` client | 6 | 6 |

**Storage Write subtotal: ~50h / ~75h.**

---

## 10. Storage Read API (gRPC, also hard)

| Feature | Hours (with libs) | Hours (zero-deps) |
|---|---|---|
| gRPC server scaffold | shared above | shared above |
| `CreateReadSession` + selected fields + row restriction | 8 | 8 |
| Avro stream encoding | 4 | 25 |
| Arrow IPC stream encoding | 8 | 40 (write a minimal Arrow writer) |
| Multiple parallel streams over a session | 6 | 6 |
| Snapshot time consistency | 4 | 8 |
| Tests against `@google-cloud/bigquery-storage` Node client | 6 | 6 |

**Storage Read subtotal: ~40h / ~100h.** Lower under DuckDB if we
adopt Parquet-backed table storage (a v0.x option in plan §Storage);
DuckDB can export Arrow IPC directly.

---

## 11. INFORMATION_SCHEMA

Synthesized views over our metadata:

| View family | Hours |
|---|---|
| `TABLES`, `TABLE_OPTIONS`, `COLUMNS`, `COLUMN_FIELD_PATHS` | 6 |
| `VIEWS`, `MATERIALIZED_VIEWS` | 4 |
| `ROUTINES`, `PARAMETERS`, `ROUTINE_OPTIONS` | 4 |
| `JOBS`, `JOBS_BY_USER`, `JOBS_BY_PROJECT`, `JOBS_BY_ORGANIZATION`, `JOBS_TIMELINE_*` | 8 |
| `SCHEMATA`, `SCHEMATA_OPTIONS` | 2 |
| `SEARCH_INDEXES`, `VECTOR_INDEXES` | 3 |
| `SESSIONS_BY_USER`, `SESSIONS_BY_PROJECT` | 3 |
| `STREAMING_TIMELINE_BY_*` | 4 |

**INFORMATION_SCHEMA subtotal: ~34 hours.**

---

## 12. Partitioning, clustering, MVs, snapshots

| Feature | Hours |
|---|---|
| Ingestion-time partitioning (`_PARTITIONTIME` / `_PARTITIONDATE`) | 10 |
| Column partitioning (DATE / TIMESTAMP / DATETIME) | 10 |
| Integer-range partitioning | 6 |
| Partition pruning at query time | 8 |
| Clustering (sort writes, store cluster keys) | 8 |
| Materialized views: DDL + refresh strategies + query rewrite | 25 |
| Snapshot tables (read-only point-in-time copy) | 6 |
| Table clones (COW semantics) | 12 |
| Time-travel queries (versioned storage with TTL) | 30 |

**Partitioning + storage features subtotal: ~115 hours.**

---

## 13. Security & access

| Feature | Hours |
|---|---|
| IAM roles & permissions model (in-memory store) | 12 |
| Auth integration (accept OAuth tokens, parse but don't verify) | 8 |
| Row-level security (`CREATE ROW ACCESS POLICY` + apply at query) | 12 |
| Column-level security & masking (policy tags) | 12 |
| Authorized views, authorized datasets, authorized routines | 8 |
| CMEK encryption (declared, no-op crypto) | 4 |

**Security subtotal: ~56 hours.**

---

## 14. Other plumbing

| Feature | Hours |
|---|---|
| Discovery document maintenance | 2 |
| Query plan / explain (`statistics.query.queryPlan`) | 6 |
| Query result pagination + `pageToken` semantics | 6 |
| Cost estimation: `totalBytesProcessed` / `totalSlotMs` | 6 |
| Job priorities (INTERACTIVE / BATCH — semantic only) | 2 |
| Labels everywhere (datasets, tables, jobs, models, routines) | 4 |
| Locations (US / EU / regional) — accept, store, surface | 4 |
| Slot reservations API (stubbed) | 4 |
| Data transfer service (separate API, usually out of scope) | — / skip |

**Plumbing subtotal: ~34 hours.**

---

## 15. Testing infrastructure (at full scope)

| Layer | Hours |
|---|---|
| Per-endpoint REST conformance against `@google-cloud/bigquery` Node client | 30 |
| SQL translator unit tests (~700 functions × happy / null / `SAFE_` paths) | 80 |
| gRPC conformance against `@google-cloud/bigquery-storage` Node client | 20 |
| Cross-runner CI matrix (Node 24, Ubuntu / macOS / Windows / arm64 / amd64) | 8 |
| Golden query suite (BQ public datasets — `bigquery-public-data.*`) | 40 |
| Performance benchmarks vs real BQ (sanity, not parity) | 20 |

**Testing subtotal: ~200 hours.**

---

## Grand totals

| Bucket | Hours (with prudent deps) | Hours (zero-runtime-deps stretch) |
|---|---|---|
| REST API | 66 | 66 |
| SQL types | 65 | 65 |
| SQL functions (no ML / federated) | 270 | 280 |
| SQL statements & features | 270 | 280 |
| SQL parsing (full RD parser path) | 250 | 300 |
| Streaming ingest (REST) | 15 | 15 |
| Load jobs | 70 | 230 |
| Extract + copy | 15 | 15 |
| Storage Write API (gRPC) | 50 | 75 |
| Storage Read API (gRPC) | 40 | 100 |
| INFORMATION_SCHEMA | 34 | 34 |
| Partitioning / clustering / MVs / time travel | 115 | 115 |
| Security & access | 56 | 56 |
| Plumbing | 34 | 34 |
| Testing infra | 200 | 220 |
| **Subtotal (no BQML, no full geo, no federated)** | **~1,550** | **~1,885** |
| Geography (S2 + ~70 `ST_*` funcs) | 40 (lib) | 80 |
| BQML (training + predict for a couple model types) | 400+ | 600+ |
| Federated external queries | 50 (file-only) | 500+ |

So **realistically full-but-pragmatic = ~1,500–2,000 hours**. Anywhere
near *complete* parity (ML + geo + federated) is **3,000+ hours** —
multi-engineer, multi-year, and at that point you're rebuilding a
proprietary product.

---

## What this means for v0

The v0 work in `BACKLOG.md` picks **the smallest slice that delivers
a tested surface**: CRUD + `PATCH` on datasets and tables, streaming
inserts, and a focused SQL subset including parameterized queries,
`JSON_VALUE`, `TIMESTAMP_SUB`, `UNNEST(@arr)`, and `INSERT…SELECT` —
roughly:

- §1 REST: P0 rows only (~30h of the ~66)
- §2 Types: just the ones in the v0 surface (~15h of the ~65)
- §3 Functions: ~10 specific functions in the v0 surface (~5h of the ~270)
- §4 Statements: `SELECT` / `JOIN` / `INSERT…SELECT` / parameterized queries (~10h)
- §5 Parsing: targeted rewriter only (~30h)
- §6 Streaming ingest: happy path (~5h)
- §11 `INFORMATION_SCHEMA`: skip
- §12 Partitioning etc.: skip
- §13 Security: accept-anything auth, skip rest
- §14 Plumbing: minimum (~10h)
- §15 Testing: focused conformance suite (~15h)

**v0 total: ~40–50 focused hours** — i.e. a few weekends, not one.
DuckDB's native support for ARRAY/STRUCT/NUMERIC/JSON/UNNEST shaves
~20h off the raw survey numbers.

---

## Things to decide before pruning v0 further

1. **Are we OK pulling one or two well-chosen runtime deps later?** A
   Parquet reader (largely free via DuckDB) and a gRPC implementation
   are the big-ticket items. The strict "no deps" line costs ~300
   extra hours across load + storage APIs.
2. **Do we ever need the Storage Read/Write APIs locally?** If the
   target consumers only talk REST + streaming inserts, the entire
   gRPC layer (~100h) can be deferred indefinitely.
3. **How much SQL coverage do downstream consumers need?** If only
   one service with a narrow SQL surface points at the emulator, the
   function set stays tiny. If analytics tools, dbt, BI dashboards,
   or other languages' clients also point at it, the surface widens
   fast.
4. **Geography support?** If `GEOGRAPHY` columns only round-trip WKT
   and nobody queries them with `ST_*`, treat `GEOGRAPHY` as opaque
   WKT and skip all `ST_*` functions (~80h saved).

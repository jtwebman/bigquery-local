# BACKLOG

The v0 work broken into single-context items. Each is sized to fit a
focused ~1–4 hour work session and has explicit dependencies,
acceptance criteria, and scope boundaries so it can be picked up
cold (by a human or by an agent in a fresh session).

**Status legend:** ⏳ planned · 🚧 in progress · ✅ done

**Working agreements for every item:**

- Land it on a feature branch, open a PR, get CI green before merging.
- CI is `npm run format:check && npm run lint && npm run typecheck && npm run test:coverage`. All four must pass.
- Coverage target: 90% lines / 90% branches / 90% functions.
- No `any`. No `^` / `~` in `package.json`. No work-project references.
- TypeScript only; tests live under `test/**/*.test.ts`.

**Scope of this file:** every item from v0 through eventual full
BigQuery parity. Completed (✅) items are collapsed to a one-line title;
their detail lives in the code and git history. Open (⏳ / 🚧) items keep
their full scope/acceptance blocks.

**Estimates:**

- v0.x polish (Phase 8): ~30h.
- v1.0.0 remaining (see milestone below): **~60 focused hours** (Phase 18/19 gRPC Storage Read/Write).

---

## v1.0.0 milestone

The remaining v1.0.0 scope is the minimum set of features needed for
the emulator to be the obvious choice over `goccy/bigquery-emulator`
for **dbt + Node-client users plus Spark/Beam pipelines**. Total
estimate: ~60h (the gRPC Storage Read + Write APIs).

Positioning at 1.0.0 (vs `goccy/bigquery-emulator`): we lead on the
**management / metadata surface** — copy jobs, table snapshots/clones,
Routines & Models CRUD, a comprehensive `INFORMATION_SCHEMA`, plus
partitioning/clustering metadata, cost estimation, and `useQueryCache` —
all of which goccy lists as not-yet-implemented or goals. The REST CRUD,
query, load/extract, streaming, and view surface is at parity, and we
match on **gRPC Storage Read/Write** once Phase 18/19 lands.

goccy still leads on **raw SQL function completeness** (their
googlesqlite engine reimplements GoogleSQL — ~570 functions, per
goccy's own status matrix) and on **JavaScript UDFs** (BL-070,
deferred). Type-wise we actually cover *more* BQ types than goccy:
all 17 BQ types work end-to-end (STRING/BYTES/INT64/FLOAT64/BOOL/
NUMERIC/BIGNUMERIC/TIMESTAMP/DATETIME/DATE/TIME/JSON/GEOGRAPHY/
INTERVAL/RANGE/STRUCT + ARRAY-as-mode), including BIGNUMERIC
arithmetic / aggregates / casts / comparisons — backed by DECIMAL(38, 9)
internally (DuckDB caps precision at 38 vs BQ's 76, ample for any test
data fitting 29 integer digits + 9 decimal places; out-of-range values
reject cleanly at insert time). RANGE uses STRUCT(start, end BIGINT)
storage; a few rare range functions surface as precise
`unsupportedFeature` errors. Schema readback (INFORMATION_SCHEMA,
`tables.get`) reports BIGNUMERIC, and wire encoders (Avro
precision=77/scale=38, Arrow Decimal256(76, 38)) pad the unscaled int
on the way out for byte-for-byte BQ fidelity. goccy's published type
matrix reports `16 / 18` with BIGNUMERIC not implemented at all
(their "18" includes googlesql types like ENUM that aren't in BQ
proper). So they're ahead on the SQL *function* tail, not on type
breadth.
Architectural difference: goccy reimplements GoogleSQL for fidelity; we
lean on DuckDB and translate the diffs — faster to build, but the
function tail and silent-divergence risk are ours to close (the
bq-replay conformance suite + sql-coverage test are how we do it).

**In v1.0.0 (by phase):**

- **Phase 12** — BL-071 Routines REST CRUD · BL-072 Models REST CRUD · BL-073 getServiceAccount
- **Phase 13** — BL-075 TABLES/COLUMNS/COLUMN_FIELD_PATHS/TABLE_OPTIONS · BL-076 VIEWS/MATERIALIZED_VIEWS · BL-077 ROUTINES/PARAMETERS/ROUTINE_OPTIONS · BL-078 JOBS\* · BL-079 SCHEMATA
- **Phase 14** — BL-083 Load CSV · BL-084 Load NDJSON · BL-085 Load Parquet · BL-090 schema autodetect · BL-093 GCS reads · BL-094 Extract jobs · BL-095 Copy jobs
- **Phase 15** — BL-096 ingestion-time partitioning · BL-097 column partitioning · BL-099 partition pruning · BL-100 clustering · BL-101 MV DDL + storage · BL-102 MV manual refresh
- **Phase 18** — BL-116 gRPC server scaffold · BL-117 CreateReadSession · BL-118 Avro stream encoding · BL-119 Arrow IPC stream encoding · BL-120 parallel streams · BL-121 snapshot-time consistency
- **Phase 19** — BL-122 Default stream · BL-123 buffered/committed/pending streams · BL-124 Flush/Finalize/BatchCommit · BL-125 AppendRows offset semantics · BL-126 schema updates mid-stream · BL-127 multiplexing
- **Phase 24** — BL-152 cost estimation · BL-154 labels propagation · BL-155 locations metadata · BL-157 useQueryCache

**Explicitly deferred to post-1.0 (with rationale):**

- **BL-069 EXCEPTION handlers · BL-070 JS UDFs** — already ⏸; SQL UDF / procedure / scripting story we have is enough for dbt users.
- **BL-074 Sessions** — minor; TEMP scoping is the only common case and it works inside scripts already.
- **BL-080–082 INFORMATION_SCHEMA** (SEARCH/VECTOR/SESSIONS/STREAMING) — depend on deferred features.
- **BL-086 Avro · BL-087 ORC · BL-088 Datastore export · BL-089 Iceberg** — niche file formats; CSV/JSON/Parquet cover ≥95% of real loads.
- **BL-091 Hive partitioning · BL-092 resumable upload** — niche.
- **BL-098 Integer-range partitioning** — niche vs date partitioning.
- **BL-103 MV query rewrite** — planner-complex; defer until users ask.
- **Phase 16 (BL-104–107) Snapshots / clones / time travel** — expensive versioned storage; emulators rarely need it.
- **Phase 17 (BL-108–115) IAM / RLS / CLS / CMEK** — emulators shouldn't enforce access control; aligns with Datastore/Firestore convention.
- **Phase 20 (BL-128–133) Geography** — GIS-team niche.
- **Phase 21 (BL-134–139) Search & vector indexes** — newer; not yet mainstream.
- **Phase 22 (BL-140–145) BigQuery ML** — separate product surface; most BQ users never touch it.
- **Phase 23 (BL-146–150) Federated external queries** — already flagged "may never ship".
- **BL-151 queryPlan · BL-153 priorities · BL-156 slot reservations** — operational metadata that real BQ exposes but rarely drives client behavior.
- **Phase 25 (BL-158–159) Connections + DTS** — separate APIs.

Anything not listed above stays in its existing phase and is in 1.0.0
scope by virtue of already being ✅. Once an item moves from
post-1.0 back into scope, edit this section *and* the per-item entry
below.

---

## Phase 1 — Repo & infra

### BL-001 — Repo skeleton ✅ · Est: 1h · Deps: —

### BL-002 — CI workflow ✅ · Est: 30m · Deps: BL-001

### BL-003 — gh repo create + first commit ✅ · Est: 15m · Deps: BL-001, BL-002

## Phase 2 — HTTP + DuckDB foundation

### BL-004 — HTTP server + router ✅ · Est: 2h · Deps: BL-001

### BL-005 — Error response shape ✅ · Est: 1h · Deps: BL-004

### BL-006 — Discovery doc endpoint ✅ · Est: 30m · Deps: BL-004

### BL-007 — DuckDB connection layer ✅ · Est: 1.5h · Deps: BL-001

### BL-008 — Metadata schema + ETag ✅ · Est: 2h · Deps: BL-007, BL-005

### BL-009 — BQ ↔ DuckDB type map ✅ · Est: 2h · Deps: BL-007

## Phase 3 — REST endpoints

### BL-010 — Datasets routes ✅ · Est: 2h · Deps: BL-008

### BL-011 — Tables routes ✅ · Est: 3h · Deps: BL-010, BL-009

### BL-012 — Tabledata.insertAll ✅ · Est: 3h · Deps: BL-011

## Phase 4 — SQL

### BL-013 — SQL tokenizer ✅ · Est: 2h · Deps: BL-001

### BL-014 — SQL translator ✅ · Est: 4h · Deps: BL-013

### BL-015 — Query endpoint (POST /queries) ✅ · Est: 3h · Deps: BL-014, BL-008, BL-009

### BL-016 — Jobs endpoints ✅ · Est: 2h · Deps: BL-015

## Phase 5 — CLI, library, packaging

### BL-017 — CLI bin ✅ · Est: 1.5h · Deps: BL-004

### BL-018 — Library entrypoint ✅ · Est: 30m · Deps: BL-015

### BL-019 — gRPC port bind + UNIMPLEMENTED ✅ · Est: 1h · Deps: BL-004

## Phase 6 — Testing & coverage

### BL-020 — Conformance test: schema-evolution flow ✅ · Est: 2h · Deps: BL-011, BL-012, BL-015

### BL-021 — Coverage to 90% ✅ · Est: 2h · Deps: BL-016, BL-020

## Phase 7 — Distribution

### BL-022 — Dockerfile (multi-stage, multi-arch) ✅ · Est: 1.5h · Deps: BL-017

### BL-023 — Publish workflow ✅ · Est: 1h · Deps: BL-022

### BL-024 — npm publish path ✅ · Est: 1h · Deps: BL-018

### BL-025 — README polish for first publish ✅ · Est: 1h · Deps: BL-024, BL-022

# Post-v0 roadmap

Everything below is post-v0. Items below use a **compressed format**:
title + 1-line scope + 1-line acceptance + deps. Expand any item
into full detail (matching the v0 items above) before starting work
on it.

Phases are loosely ordered by likely sequencing, not strict dependency
— many phases can interleave once their gating deps are done.

## Phase 8 — v0.x polish (drop-in completeness)

### BL-026 — `--data-from-yaml` initial seed ✅ · Est: 2h · Deps: BL-010, BL-011

### BL-027 — Datasets list endpoint with pagination ✅ · Est: 1.5h · Deps: BL-010

### BL-028 — Tables list endpoint with pagination ✅ · Est: 1.5h · Deps: BL-011

### BL-029 — Jobs list endpoint with filters ✅ · Est: 2h · Deps: BL-016

### BL-030 — `jobs.cancel` + `jobs.delete` ✅ · Est: 1h · Deps: BL-016

### BL-031 — `tabledata.list` paginated ✅ · Est: 2h · Deps: BL-012

### BL-032 — `insertAll` insertId-based dedup ✅ · Est: 2h · Deps: BL-012

### BL-033 — `insertAll` templateSuffix tables ✅ · Est: 2h · Deps: BL-012

### BL-034 — Multi-project: repeatable `--project` ✅ · Est: 1h · Deps: BL-017, BL-008

### BL-035 — `dryRun: true` for queries ✅ · Est: 2h · Deps: BL-015

### BL-036 — Query result `pageToken` semantics ✅ · Est: 1h · Deps: BL-016

## Phase 9 — SQL function coverage

### BL-037 — String function expansion ✅ · Est: 3h · Deps: BL-014

### BL-038 — Numeric/math function expansion ✅ · Est: 2h · Deps: BL-014

### BL-039 — Date/time function expansion (1) ✅ · Est: 3h · Deps: BL-014

### BL-040 — Date/time function expansion (2) ✅ · Est: 2h · Deps: BL-039

### BL-041 — JSON function expansion ✅ · Est: 2h · Deps: BL-014

### BL-042 — Array function expansion ✅ · Est: 2h · Deps: BL-014

### BL-043 — Aggregate function expansion ✅ · Est: 2h · Deps: BL-014

### BL-044 — Window/analytic functions ✅ · Est: 3h · Deps: BL-014

### BL-045 — Approximate aggregation ✅ · Est: 4h · Deps: BL-014

### BL-046 — Statistical aggregate ✅ · Est: 1.5h · Deps: BL-014

### BL-047 — Hash & fingerprint functions ✅ · Est: 1h · Deps: BL-014

### BL-048 — Bitwise functions ✅ · Est: 30m · Deps: BL-014

### BL-049 — Conversion / cast formatting ✅ · Est: 2h · Deps: BL-014

### BL-050 — Net functions ✅ · Est: 1h · Deps: BL-014

### BL-051 — `SAFE.` function prefix ✅ · Est: 2h · Deps: BL-014

## Phase 10 — SQL statements & language features

### BL-052 — INSERT / UPDATE / DELETE (single-table) ✅ · Est: 2h · Deps: BL-014, BL-015

### BL-053 — MERGE ✅ · Est: 4h · Deps: BL-052

### BL-054 — DDL: VIEW ✅ · Est: 2h · Deps: BL-011

### BL-055 — DDL: SCHEMA (CREATE/DROP) ✅ · Est: 1h · Deps: BL-010

### BL-056 — GROUP BY ROLLUP / CUBE / GROUPING SETS ✅ · Est: 3h · Deps: BL-014

### BL-057 — QUALIFY ✅ · Est: 2h · Deps: BL-044

### BL-058 — PIVOT / UNPIVOT ✅ · Est: 3h · Deps: BL-014

### BL-059 — TABLESAMPLE ✅ · Est: 1.5h · Deps: BL-014

### BL-060 — Wildcard tables + `_TABLE_SUFFIX` ✅ · Est: 3h · Deps: BL-014

### BL-061 — TRUNCATE TABLE ✅ · Est: 30m · Deps: BL-052

### BL-062 — Multi-statement transactions ✅ · Est: 2h · Deps: BL-052

## Phase 11 — Functions, procedures, scripting

### BL-063 — SQL UDF (`CREATE FUNCTION`) ✅ · Est: 3h · Deps: BL-014

### BL-064 — Table-valued functions ✅ · Est: 4h · Deps: BL-063

### BL-065 — Stored procedures (`CREATE PROCEDURE`) ✅ · Est: 4h · Deps: BL-063, BL-066

### BL-066 — Scripting: DECLARE / SET / IF ✅ · Est: 4h · Deps: BL-014

### BL-067 — Scripting: loops ✅ · Est: 3h · Deps: BL-066

### BL-068 — Scripting: CALL / EXECUTE IMMEDIATE / RETURN ✅ · Est: 3h · Deps: BL-066

### BL-069 — Scripting: EXCEPTION handlers ⏸ deferred · Est: 2h · Deps: BL-066

Scope: BEGIN … EXCEPTION WHEN ERROR THEN … END. Acceptance: errors caught by handler; `@@error.message` populated.

**Deferred at v0.4.0** — most BQ users don't write procedures with exception handling. Lands when a real-world script needs it; the interpreter's signal-class pattern (BreakSignal / ReturnSignal) already shows how to wire a new control flow.

### BL-070 — JS UDFs ⏸ deferred · Est: 8h · Deps: BL-063

Scope: sandboxed JS UDFs via `vm` module; BQ argument/return type marshalling. Acceptance: a `RETURNS FLOAT64 LANGUAGE js AS '''return x * 2;'''` example works.

**Deferred at v0.4.0** — heaviest BL in the phase (vm sandbox + BQ↔JS type marshalling). Lower priority than wire-fidelity gaps (BOOL/NUMERIC string encoding, error message shapes) which break real BQ clients today.

## Phase 12 — Routines / models / sessions

### BL-071 — Routines REST CRUD ✅ · Est: 2h · Deps: BL-063

### BL-072 — Models REST CRUD (metadata) ✅ · Est: 2h · Deps: BL-008

### BL-073 — Projects + getServiceAccount endpoints ✅ · Est: 30m · Deps: BL-004

### BL-074 — Sessions: TEMP scoping + session params ⏳ · Est: 3h · Deps: BL-016

Scope: session ID tracked in `_bq.sessions`; TEMP tables/functions scoped per session; session-scoped variables. Acceptance: TEMP table visible within session, gone after `endSession`.

## Phase 13 — INFORMATION_SCHEMA

### BL-075 — TABLES / COLUMNS / COLUMN_FIELD_PATHS / TABLE_OPTIONS ✅ · Est: 3h · Deps: BL-011

### BL-076 — VIEWS / MATERIALIZED_VIEWS ✅ · Est: 2h · Deps: BL-054

### BL-077 — ROUTINES / PARAMETERS / ROUTINE_OPTIONS ✅ · Est: 2h · Deps: BL-063

### BL-078 — JOBS / JOBS*BY_USER / JOBS_BY_PROJECT / JOBS_BY_ORGANIZATION / JOBS_TIMELINE*\* ✅ · Est: 4h · Deps: BL-016

### BL-079 — SCHEMATA + SCHEMATA_OPTIONS ✅ · Est: 1h · Deps: BL-010

### BL-080 — SEARCH_INDEXES + VECTOR_INDEXES ⏳ · Est: 1h · Deps: BL-134, BL-137

Scope: virtual views over search/vector index metadata. Acceptance: created indexes appear.

### BL-081 — SESSIONS_BY_USER + SESSIONS_BY_PROJECT ⏳ · Est: 1h · Deps: BL-074

Scope: virtual views over sessions. Acceptance: active sessions appear with start/end timestamps.

### BL-082 — STREAMING*TIMELINE_BY*\* ⏳ · Est: 2h · Deps: BL-012

Scope: time-bucketed counts of streaming inserts. Acceptance: inserted rows show up in the correct timestamp bucket.

## Phase 14 — Load / extract / copy jobs

### BL-083 — Load: CSV ✅ · Est: 4h · Deps: BL-016, BL-093

### BL-084 — Load: NDJSON ✅ · Est: 2h · Deps: BL-083

### BL-085 — Load: Parquet ✅ · Est: 2h · Deps: BL-083

### BL-086 — Load: Avro ⏳ · Est: 6h · Deps: BL-083

Scope: sourceFormat=AVRO; pull a small Avro reader dep or use DuckDB's avro extension. Acceptance: Avro file becomes rows.

### BL-087 — Load: ORC ⏳ · Est: 6h · Deps: BL-083

Scope: sourceFormat=ORC; pull a small ORC reader dep. Acceptance: ORC file becomes rows.

### BL-088 — Load: Datastore / Firestore export ⏳ · Est: 6h · Deps: BL-083

Scope: parse LevelDB-style export format. Acceptance: a sample export becomes rows.

### BL-089 — Load: Iceberg ⏳ · Est: 10h · Deps: BL-085

Scope: Iceberg manifest + snapshot resolution; read underlying Parquet via DuckDB. Acceptance: pointing load at an Iceberg location reads the current snapshot.

### BL-090 — Schema autodetect ✅ · Est: 4h · Deps: BL-083

### BL-091 — Hive partitioning options ⏳ · Est: 3h · Deps: BL-085

Scope: `hivePartitioningOptions.mode=AUTO|STRINGS|CUSTOM`; expose partition columns. Acceptance: load from a Hive-partitioned tree exposes the partition keys.

### BL-092 — Local file multipart resumable upload ⏳ · Est: 4h · Deps: BL-083

Scope: implement the resumable upload protocol the gcloud client uses for `bq load`. Acceptance: `bq load` from local file works.

### BL-093 — GCS reads via `STORAGE_EMULATOR_HOST` ✅ · Est: 3h · Deps: BL-001

### BL-094 — Extract jobs ✅ · Est: 6h · Deps: BL-093

### BL-095 — Copy table jobs ✅ · Est: 3h · Deps: BL-016

## Phase 15 — Partitioning, clustering, materialized views

### BL-096 — Ingestion-time partitioning ✅ · Est: 4h · Deps: BL-011

### BL-097 — Column partitioning (DATE/TIMESTAMP/DATETIME) ✅ · Est: 3h · Deps: BL-011

### BL-098 — Integer-range partitioning ⏳ · Est: 3h · Deps: BL-011

Scope: `range_partitioning` with start/end/interval. Acceptance: integer-bucketed partitions readable by range.

### BL-099 — Partition pruning at query time ✅ · Est: 4h · Deps: BL-096, BL-097, BL-098

### BL-100 — Clustering keys ✅ · Est: 4h · Deps: BL-011

### BL-101 — Materialized views: DDL + storage ✅ · Est: 4h · Deps: BL-054

### BL-102 — MV manual refresh ✅ · Est: 3h · Deps: BL-101

### BL-103 — MV query rewrite ⏳ · Est: 6h · Deps: BL-101

Scope: at query time, rewrite eligible queries to read from the MV instead of the base table. Acceptance: a query covered by an MV plans against the MV.

## Phase 16 — Snapshots, clones, time travel

### BL-104 — Snapshot tables ⏳ · Est: 4h · Deps: BL-011

Scope: read-only point-in-time copy; metadata-only initially. Acceptance: snapshot of table T contains exactly T's rows at the snapshot time.

### BL-105 — Table clones ⏳ · Est: 6h · Deps: BL-104

Scope: COW semantics — writes to clone diverge from source. Acceptance: write to clone doesn't affect source; write to source doesn't affect clone.

### BL-106 — Versioned storage for time travel ⏳ · Est: 20h · Deps: BL-011

Scope: keep N hours of history for every table (default 7 days in real BQ); GC older. Acceptance: a row deleted 1h ago is visible at `SYSTEM_TIME` 2h ago.

### BL-107 — `FOR SYSTEM_TIME AS OF` ⏳ · Est: 6h · Deps: BL-106

Scope: parser + planner routes reads to the historical snapshot. Acceptance: time-travel query returns historical rows correctly.

## Phase 17 — Security & access

### BL-108 — IAM roles + permissions model ⏳ · Est: 6h · Deps: BL-008

Scope: in-memory store of roles → permissions; standard predefined roles. Acceptance: `testIamPermissions` returns correct subset.

### BL-109 — OAuth token parsing (accept, don't verify) ⏳ · Est: 3h · Deps: BL-005

Scope: extract bearer token from Authorization header; parse `sub` claim; never verify signature. Acceptance: requests with a token are tagged with the subject in logs.

### BL-110 — Row-level security ⏳ · Est: 6h · Deps: BL-108

Scope: `CREATE ROW ACCESS POLICY`; apply policy predicate at query time. Acceptance: a user without access sees zero rows from a row-access-restricted table.

### BL-111 — Column-level security + masking ⏳ · Est: 6h · Deps: BL-108

Scope: policy tags on columns; mask values for unauthorized users. Acceptance: masked column returns SHA256 / null per policy.

### BL-112 — Authorized views / datasets / routines ⏳ · Est: 4h · Deps: BL-108, BL-054

Scope: grants that let a view read tables across IAM boundaries. Acceptance: authorized view executes against underlying tables the caller can't directly read.

### BL-113 — CMEK encryption declaration ⏳ · Est: 2h · Deps: BL-008

Scope: accept and store `encryptionConfiguration.kmsKeyName`; no actual crypto. Acceptance: round-trips in metadata responses.

### BL-114 — RowAccessPolicies API ⏳ · Est: 2h · Deps: BL-110

Scope: REST endpoints for listing / IAM management on policies. Acceptance: CRUD round-trips.

### BL-115 — IAM bindings API ⏳ · Est: 3h · Deps: BL-108

Scope: `getIamPolicy` / `setIamPolicy` on datasets, tables, models, routines. Acceptance: setting a binding makes it visible to `getIamPolicy`.

## Phase 18 — gRPC Storage Read API

### BL-116 — gRPC server scaffold ✅ · Est: 10h · Deps: BL-001

Landed at v0.7.x: `src/grpc.ts` boots `@grpc/grpc-js`'s `Server` with no services registered, so every RPC falls through to grpc-js's built-in UNIMPLEMENTED response. Real `@grpc/grpc-js` clients connect and get a canonical `Status.UNIMPLEMENTED` error. Subsequent items (BL-117+) plug their service handlers in via `server.addService(...)`.

### BL-117 — CreateReadSession ✅ · Est: 4h · Deps: BL-116, BL-011

Landed at v0.7.x: `src/grpc-impl/bigQueryRead.ts` registers the `CreateReadSession` RPC on the grpc-js Server when a `Db` is supplied. Looks up the table via `getTable(db, project, dataset, table)`, builds an Avro JSON schema (`src/grpc-impl/avroSchema.ts`) honoring `selected_fields`, echoes `row_restriction` on the response's `readOptions`, and returns a `ReadSession` with `name`, `expireTime`, `streams[]`, and `estimatedRowCount = TableMeta.numRows`. Wire is exercised end-to-end in `test/api/grpc-create-read-session.test.ts` via a real `@grpc/grpc-js` `Client`. `data_format=ARROW` returns `UNIMPLEMENTED` until BL-119; the actual `ReadRows` streaming is BL-118+.

### BL-118 — Avro stream encoding ✅ · Est: 6h · Deps: BL-117

Landed at v0.7.x: `src/grpc-impl/avroRows.ts` projects DuckDB columns into Avro-friendly shapes (`epoch_us(t)::BIGINT` for TIMESTAMP/DATETIME, `date_diff('day', ...)` for DATE, full-precision VARCHAR for NUMERIC/BIGNUMERIC) and converts each row to the JS form `avsc` expects (numbers/bigints, two's-complement bytes for decimals, nested objects for STRUCT, arrays for REPEATED). `src/grpc-impl/sessionStore.ts` keeps ReadSession state in-memory keyed by session name; `ReadRows` looks up the session by stream name and streams `ReadRowsResponse` batches of up to 1000 rows each, embedding the Avro schema in the first response. Round-trip exercised end-to-end in `test/api/grpc-read-rows.test.ts` — rows decoded via `avsc` against the same schema. Added `avsc 5.7.9` runtime dep.

Real-BQ conformance: `test/conformance/bq-storage-fixtures/` (15 fixtures: scalars, BYTES, every date/time logical type, NUMERIC ± edges, BIGNUMERIC, REPEATED, nested STRUCT, JSON, `selected_fields`, `row_restriction`). All 15 captured against real BQ and decoded values match byte-for-byte (Avro encoding is deterministic; the harness decodes + sorts + structurally compares since neither engine guarantees row order). The full suite **runs twice** — once with `:memory:`, once against a file-backed DuckDB that's closed and reopened between fixture-setup and the reads, so WAL replay + table catalog round-trip get exercised on every fixture. Captured-fidelity fixes that landed alongside: top-level record name is the literal `__root__`, nested structs use `__s_N`, NULLABLE unions omit the `default: null` Avro spec sugar, NUMERIC pads to 16 bytes and BIGNUMERIC to 32 (the precision-implied storage width), BIGNUMERIC's Avro `precision` is 77 not the user-visible 76, DATETIME is an ISO `string` with custom `datetime` logical type (not `local-timestamp-micros`), JSON columns carry the `sqlType: JSON` marker, `estimatedRowCount` is the actual count of rows in the table, and `ReadRowsResponse.rowCount` stays unset (row count is implicit in the bytes). Capture via `npm run bq-storage-replay:capture`; see `test/conformance/BQ-STORAGE-REPLAY.md`.

### BL-119 — Arrow IPC stream encoding ✅ · Est: 8h · Deps: BL-117

Landed at v0.7.x: `data_format=ARROW` builds an `apache-arrow` Schema from the BQ TableSchema (`src/grpc-impl/arrowSchema.ts`: INT64→Int64, NUMERIC→Decimal128(38,9), BIGNUMERIC→Decimal256(76,38), DATE→Date32(DAY), TIME→Time64(µs), TIMESTAMP→Timestamp(µs,UTC), DATETIME→Timestamp(µs, null), STRUCT→Struct, REPEATED→List). `src/grpc-impl/arrowRows.ts` converts each DuckDB row into a `RecordBatch`, serializes the IPC stream via `tableToIPC`, then splits it into individual messages (using `Message.decode(...).bodyLength` to compute boundaries) so `ReadSession.arrow_schema.serialized_schema` and each `ReadRowsResponse.arrow_record_batch.serialized_record_batch` get exactly one IPC message. Encoding wrinkles: Timestamp data uses a hand-built `BigInt64Array` (vectorFromArray treats input numbers as JS millis and would silently scale by 1000); DATE is a JS Date constructed from days; Decimal128/256 are fed as `Uint32Array(N)` (vectorFromArray spreads bytes one-per-uint32). Round-trip verified end-to-end in `test/api/grpc-read-rows-arrow.test.ts` via apache-arrow's `RecordBatchReader`. Replay-suite parity confirmed across 5 Arrow fixtures (`020-024`) against captured BigQuery output. Added `apache-arrow 21.1.0` runtime dep.

### BL-120 — Multiple parallel streams ✅ · Est: 4h · Deps: BL-118, BL-119

Landed at v0.7.x: `CreateReadSession` honors `maxStreamCount` and splits the filtered row count into N non-overlapping slices. Each stream stores its `{ name, offset, size }` in the session; `ReadRows` reads only its slice via `ORDER BY rowid LIMIT size OFFSET offset`. Edge handling: `maxStreamCount` defaults to 1, caps at the filtered row count (no empty trailing slices), and an empty result still gets one stream so clients have somewhere to receive the schema. The filtered count + slicing is what changes when `row_restriction` is set — `estimatedRowCount` still matches BQ (raw table count). Tests in `test/api/grpc-parallel-streams.test.ts` verify: 4-stream split of 23 rows yields the exact set [1..23]; cap-by-row-count for max=1000; `row_restriction` applied before slicing; empty-table still emits one schema-only stream. Conformance verified against real BQ via the `030-multi-stream` fixture (BQ's small-table heuristic returned 1 stream where we returned 4; canonicalizer drops `streamCount` from the structural compare and relies on the row-set decode match, which is the actual correctness invariant).

### BL-121 — Snapshot time consistency ✅ (stub) · Est: 30m · Deps: BL-117

Landed at v0.7.x as a stub: `CreateReadSession` accepts `tableModifiers.snapshotTime` and echoes it on the response. The data path serves the current table state — we don't keep versioned storage (BL-106 deferred as Phase 16). Within a single test run the table doesn't change underneath the session so reads are trivially repeatable, satisfying the acceptance criterion for the emulator's primary use case (CI / dbt tests). Real `FOR SYSTEM_TIME AS OF` semantics would need Phase 16 — see the post-1.0 deferral note.

## Phase 19 — gRPC Storage Write API

### BL-122 — Default stream (at-least-once) ✅ · Est: 6h · Deps: BL-116, BL-012

Landed at v0.7.x: `AppendRows` (bidirectional streaming) on the `_default` stream. `src/grpc-impl/protoRows.ts` compiles each incoming `WriterSchema.proto_descriptor` (DescriptorProto) into a runtime `protobufjs.Type` — accepts both numeric (`3`) and symbolic (`TYPE_INT64`) forms of the `FieldDescriptorProto.Type` enum since grpc-js deserialization can hand us either depending on the `enums` option. Each `serialized_rows[i]` decodes against that Type, gets mapped to BQ-wire values via per-field converters (INT64 → decimal string, DATE → `YYYY-MM-DD`, TIME → `HH:MM:SS.ffffff`, NUMERIC → decimal string, BYTES → base64, etc.), then INSERT'd via the existing `bqValueToDuck` + `bqInsertExpression` machinery. The writer schema is required on the first request and cached on the stream context for subsequent ones (the BQ Storage Write contract). `appendResult.offset` echoes the table's pre-append row count. Non-`_default` streams return `INVALID_ARGUMENT` (explicit application streams land in BL-123). Unknown tables return `NOT_FOUND`. `arrow_rows` payload returns `UNIMPLEMENTED` (deferred). 5 acceptance tests in `test/api/grpc-append-rows.test.ts` + 15 protoRows unit tests covering every supported FieldDescriptorProto.Type and BqField conversion path.

### BL-123 — Application streams: buffered / committed / pending ✅ · Est: 8h · Deps: BL-122

Landed at v0.7.x: explicit write streams via `CreateWriteStream` with three types — COMMITTED (immediate visibility), BUFFERED (rows buffered until `FlushRows`, BL-124), and PENDING (rows buffered until `BatchCommitWriteStreams`). `src/grpc-impl/writeStreamStore.ts` keeps per-stream state (`ACTIVE` → `FINALIZED` → `COMMITTED`) plus an in-memory row buffer for non-COMMITTED types. `AppendRows` dispatches by stream type: COMMITTED writes go straight to the table (offset-tracked); PENDING/BUFFERED rows queue in the buffer. `FinalizeWriteStream` transitions ACTIVE → FINALIZED and rejects further appends with `FAILED_PRECONDITION`. `BatchCommitWriteStreams` flushes each finalized PENDING stream's buffer atomically (per-stream-prepared SQL) and surfaces per-stream errors via `StorageError.entity` (not `writeStream` — that's the proto field name) instead of failing the whole batch. Acceptance verified in `test/api/grpc-application-streams.test.ts`: PENDING rows invisible until commit; finalize blocks subsequent appends; mixed batch surfaces COMMITTED-and-unknown errors without affecting a valid PENDING commit. `FlushRows` and `GetWriteStream` stay unregistered → grpc-js UNIMPLEMENTED until BL-124.

### BL-124 — FlushRows / FinalizeWriteStream / BatchCommitWriteStreams ✅ · Est: 4h · Deps: BL-123

Landed at v0.7.x. `FinalizeWriteStream` and `BatchCommitWriteStreams` shipped with BL-123; `FlushRows` is the BL-124 piece: promotes BUFFERED-stream rows to visible up to the requested `offset` (or all currently buffered when `offset` is unset). The stream runtime now tracks both `offset` (total appended) and `flushedOffset` (visibility watermark); BUFFERED holds rows in `[flushedOffset, offset)` and FlushRows drains the prefix into the table via the existing prepared-INSERT path. Errors: `FAILED_PRECONDITION` on COMMITTED/PENDING streams (those have different commit semantics); `OUT_OF_RANGE` for offsets beyond what was appended or behind already-flushed (BQ-faithful); `NOT_FOUND` for unknown streams. Verified in `test/api/grpc-flush-rows.test.ts` — 7 tests covering partial flush, whole-buffer flush, type-rejection, both out-of-range conditions, and unknown-stream handling.

### BL-125 — AppendRows offset semantics ✅ · Est: 4h · Deps: BL-123

Landed at v0.7.x. `AppendRowsRequest.offset` (an `Int64Value` wrapper, optional) is now enforced against the stream's running offset for explicit streams: `offset == stream.offset` accepts and writes; `offset < stream.offset` is treated as an idempotent replay (no second write, success response echoes the client's requested offset); `offset > stream.offset` returns `OUT_OF_RANGE`. Unset offset preserves the at-least-once `_default` semantics. Verified end-to-end in `test/api/grpc-offsets-schema-mux.test.ts`.

### BL-126 — Schema updates mid-stream ✅ · Est: 3h · Deps: BL-122

Landed at v0.7.x. The AppendRows context caches the destination table's etag at first-touch; every subsequent request re-checks via `getTable(...)` and, on an etag bump (e.g. an `ALTER TABLE ADD COLUMN` that lands between two batches on a live stream), refreshes the field list, invalidates the cached INSERT SQL, and emits `updated_schema` on the next response. Verified by holding a single bidi AppendRows call open across an `ALTER TABLE`; the second batch's response carries the new field list.

### BL-127 — Multiplexing ✅ · Est: 3h · Deps: BL-122

Landed at v0.7.x. One bidirectional `AppendRows` call can target arbitrary write streams — the handler keeps a `Map<streamName, AppendContext>` and routes each message to its own context, so per-stream offsets, schemas, and writer types stay isolated. `write_stream` is required on every message (no implicit propagation from earlier messages — keeps the multiplexing contract explicit). 3 tests verify the mux story: multi-stream interleaving, independent per-stream offsets, and the missing-`write_stream` guard.

Real-BQ conformance for the whole Storage Write surface: `test/conformance/bq-write-fixtures/` (6 fixtures: PENDING lifecycle, COMMITTED immediate, BUFFERED+FlushRows, offset validation with replay + out-of-order, schema update mid-stream, multiplexed streams). Each fixture is a sequence of typed operations; the capture script (`scripts/bq-write-replay-capture.mts`) replays the sequence against real BigQuery and records canonicalized response shapes. Surfaced one significant behavior the docs gloss over: real BQ **never errors on offset mismatch** — both replays and out-of-order requests come back as success responses with `appendResult.offset` unset, and the row is silently dropped (the client tells them apart by tracking expected offsets locally). Our emulator was originally returning `OUT_OF_RANGE` for out-of-order; now matches BQ. FlushRows offset semantics were also corrected to be the inclusive last-row index (not a row count). Capture via `npm run bq-write-replay:capture`; needs ADC.

## Phase 20 — Geography

### BL-128 — GEOGRAPHY type round-trip ✅

### BL-129 — Spatial library bridge ✅

### BL-130 — Predicate `ST_*` functions ⏳ · Est: 6h · Deps: BL-129

Scope: ST_INTERSECTS, ST_CONTAINS, ST_WITHIN, ST_COVERS, ST_TOUCHES, ST_EQUALS. Acceptance: 1 test per function with a known-result fixture.

### BL-131 — Distance `ST_*` functions ⏳ · Est: 4h · Deps: BL-129

Scope: ST_DISTANCE, ST_DWITHIN, ST_MAX_DISTANCE. Acceptance: distance within ±1m of expected.

### BL-132 — Construction `ST_*` functions ⏳ · Est: 6h · Deps: BL-129

Scope: ST_BUFFER, ST_UNION, ST_INTERSECTION, ST_DIFFERENCE, ST_CENTROID, ST_CONVEXHULL. Acceptance: 1 test per function.

### BL-133 — Remaining `ST_*` ⏳ · Est: 12h · Deps: BL-129

Scope: the long tail (~40 more): ST_AREA, ST_LENGTH, ST_PERIMETER, ST_X, ST_Y, ST_NUMPOINTS, ST_GEOHASH, etc. Acceptance: function table on docs page is exhaustively covered.

## Phase 21 — Search & vector

### BL-134 — Search index DDL ⏳ · Est: 4h · Deps: BL-011

Scope: `CREATE SEARCH INDEX … ON tbl(col, …)`; persist metadata. Acceptance: index appears in `INFORMATION_SCHEMA.SEARCH_INDEXES`.

### BL-135 — Tokenizer + inverted index ⏳ · Est: 8h · Deps: BL-134

Scope: BM25-style inverted index; persist alongside table. Acceptance: known tokens lookup → correct row IDs.

### BL-136 — `SEARCH()` function ⏳ · Est: 3h · Deps: BL-135

Scope: `SEARCH(tbl, 'query string')` returns rows. Acceptance: BQ search example returns matches.

### BL-137 — Vector index DDL ⏳ · Est: 4h · Deps: BL-011

Scope: `CREATE VECTOR INDEX`; store ANN structure (IVF or HNSW). Acceptance: index appears in `INFORMATION_SCHEMA.VECTOR_INDEXES`.

### BL-138 — `VECTOR_SEARCH()` ⏳ · Est: 8h · Deps: BL-137

Scope: top-k ANN over the vector index. Acceptance: 1 test with known nearest neighbors.

### BL-139 — `ML.DISTANCE` (vector mode) ⏳ · Est: 2h · Deps: BL-138

Scope: euclidean / cosine / dot product distances over ARRAY<FLOAT64>. Acceptance: numeric tests vs hand-computed values.

## Phase 22 — BigQuery ML (deferred — split each into smaller items first)

### BL-140 — `CREATE MODEL` DDL + metadata ⏳ · Est: 6h · Deps: BL-072

Scope: parse + store model DDL; reject training in this item. Acceptance: model record visible via REST.

### BL-141 — Linear / logistic regression ⏳ · Est: 20h · Deps: BL-140

Scope: train via gradient descent; persist coefficients; `ML.PREDICT` + `ML.EVALUATE`. Acceptance: train + predict on a small fixture matches scikit-learn within ±5%.

### BL-142 — K-means ⏳ · Est: 15h · Deps: BL-140

Scope: clustering + centroid persistence + `ML.PREDICT` returning cluster assignments. Acceptance: known clusters recovered on a separable fixture.

### BL-143 — ARIMA_PLUS time-series ⏳ · Est: 25h · Deps: BL-140

Scope: training + `ML.FORECAST`. Acceptance: forecast on a synthetic seasonal series matches expectation within tolerance.

### BL-144 — Boosted-tree classifier / regressor ⏳ · Est: 30h · Deps: BL-140

Scope: gradient-boosted tree training + prediction. Acceptance: model trained on the wine dataset achieves stated accuracy.

### BL-145 — `ML.FEATURE_IMPORTANCE` / `ML.GLOBAL_EXPLAIN` ⏳ · Est: 8h · Deps: BL-144

Scope: surface model introspection. Acceptance: returns shape matching BQ docs.

## Phase 23 — Federated external queries

### BL-146 — External tables over GCS ⏳ · Est: 8h · Deps: BL-085, BL-093

Scope: `CREATE EXTERNAL TABLE` over CSV/JSON/Parquet/Avro on GCS; queries delegate to DuckDB's `read_*` functions. Acceptance: query returns rows directly from the file without copying.

### BL-147 — Iceberg external tables ⏳ · Est: 8h · Deps: BL-089

Scope: declare an Iceberg table location; queries read current snapshot. Acceptance: query returns rows from the snapshot.

### BL-148 — BigLake metadata + access ⏳ · Est: 12h · Deps: BL-146

Scope: BigLake's metadata layer + fine-grained access. Acceptance: per-row access controls applied at read.

### BL-149 — Object tables (unstructured data) ⏳ · Est: 8h · Deps: BL-146

Scope: `CREATE EXTERNAL OBJECT TABLE` exposing file metadata as rows. Acceptance: file listing query returns expected rows.

### BL-150 — `EXTERNAL_QUERY` to external systems ⏳ · Est: 40h+ · Deps: —

Scope: Bigtable / Spanner / Cloud SQL federation. **Heavy; may never ship.** Acceptance: per-system fixture passes.

## Phase 24 — Operational polish

### BL-151 — Query plan / `queryPlan` statistics ⏳ · Est: 6h · Deps: BL-015

Scope: synthesize plan stages from DuckDB's EXPLAIN; expose under `statistics.query.queryPlan`. Acceptance: response includes a recognizable plan tree.

### BL-152 — Cost estimation ✅ · Est: 4h · Deps: BL-035

### BL-153 — Job priorities (INTERACTIVE / BATCH) ⏳ · Est: 1h · Deps: BL-016

Scope: accept and surface; no actual scheduling. Acceptance: round-trips through job metadata.

### BL-154 — Labels propagation ✅ · Est: 2h · Deps: BL-008

### BL-155 — Locations metadata ✅ · Est: 2h · Deps: BL-008

### BL-156 — Slot reservations API (stub) ⏳ · Est: 4h · Deps: BL-004

Scope: reservations / assignments REST surface; no real slot semantics. Acceptance: CRUD round-trips.

### BL-157 — `useQueryCache` semantics ✅ · Est: 4h · Deps: BL-015

## Real-BQ parity gaps (surfaced by bq-replay)

Caught by the conformance suite (`npm run bq-replay:capture` + replay
tests). Each is a real wire divergence between bigquery-local and
real BigQuery.

### UNNEST of array literals wraps in STRUCT ✅

### STRUCT(x AS name, ...) literal not recognized ✅

### `^` operator is XOR in BQ, exponentiation in DuckDB ✅

### INITCAP has no DuckDB equivalent ⏳

BQ's INITCAP (capitalize first letter of each word) isn't a DuckDB
scalar function. Would need composing via regexp/split. Uncommon;
deferred.

### SAFE_NEGATE(INT64_MIN) doesn't overflow ⏳

`SAFE_NEGATE(-9223372036854775808)` returns NULL in BQ (negating INT64
min overflows INT64) but DuckDB promotes the operand to a wider int so
`TRY(-(...))` yields 9223372036854775808 instead of NULL. Matching
would require casting the operand to BIGINT *only when it's an integer*
— the translator doesn't carry operand types. Extreme edge; SAFE_NEGATE
works for all other inputs.

### FORMAT %t / %T specifiers ⏳

BQ's `FORMAT()` supports `%t` (compact type-aware string) and `%T`
(literal representation) for any value. DuckDB's `printf` (which we
map FORMAT to) has no equivalent and errors on the specifier. The
common C-style specifiers (`%d %s %f %x %05d` etc.) all work.
Supporting `%t`/`%T` would need format-string parsing to convert the
matching argument to its string form first.

### Decimal literals type as NUMERIC, not FLOAT64 ✅

### Mixed named/positional STRUCT in array literals ⏳

`[STRUCT(1 AS id, 'a' AS name), STRUCT(2, 'b')]` — BQ propagates the
first element's field names to subsequent positional structs so the
array is uniformly typed. Our translator processes each STRUCT
independently, leaving an inconsistent mix of `{id, name}` and
`(2, 'b')` that DuckDB rejects. Fix would need array-aware STRUCT
translation (look-back to sibling structs' field names). Workaround:
write the data using `UNION ALL` of named-column SELECTs.

### Unbackticked `dataset.table` references not project-qualified ⏳

Real BQ accepts `SELECT * FROM ds.tbl` (no backticks); our translator
only rewrites a `dataset.table` ref to the project-qualified DuckDB
schema (`project__ds.tbl`) when it's backticked (`` `ds.tbl` ``).
Unbackticked, DuckDB sees a literal `ds` schema that doesn't exist.
Surfaced by the `bq` CLI (which passes user SQL verbatim). Fix needs the
table-ref recognizer to also qualify unquoted `ident.ident` table
references. Workaround: backtick table references.

## Client-library coverage

Official client SDKs we exercise end-to-end against the emulator:

| Language | REST (`google-cloud-bigquery`) | Storage Read (gRPC) | Storage Write (gRPC) |
|----------|--------------------------------|----------------------|-----------------------|
| Node     | ✅ (existing internals)         | ✅ `test/clients/node/grpc-storage.test.ts` | ✅ same file |
| Python   | ✅ `test/clients/python/test_*.py` | ✅ `test_grpc_storage.py` | ✅ same file (`_default` stream) |
| Go       | ✅ `test/clients/go/*_test.go`     | ✅ `storage_test.go`        | ✅ `storage_write_test.go` (`_default` stream) |
| Java     | ✅ `test/clients/java/.../*Test.java` | ✅ `StorageTest.java` (Read) | ✅ `StorageTest.java` (Write — `_default` stream) |
| C#       | ✅ `test/clients/csharp/StorageReadTests.cs` (uses `BigQueryClientBuilder` w/ `BaseUri`) | ✅ same file | ✅ `StorageWriteTests.cs` (`_default` stream) |
| `bq` CLI | ✅                              | n/a (REST-only)       | n/a |
| dbt-bigquery | ✅ via `sitecustomize.py` shim | shim patches the Storage Read transport too (BL-119+) when `BIGQUERY_EMULATOR_GRPC_HOST` is set | — |

One known gap surfaced while adding the gRPC clients: pandas-gbq's
`bq.query(...).to_dataframe(bqstorage_client=...)` reads the query's
anonymous result table via Storage Read; we don't yet expose
`_bqlocal_anon.<uuid>` to the Storage Read layer. Skipped with a
documented reason in `test_grpc_storage.py`.

## dbt readiness

`dbt-bigquery` runs against the emulator via the monkeypatch shim in
`test/clients/dbt` (connection) + the translator support below (DDL). A real
project — `table` / `view` / `incremental` (MERGE) models + `dbt test` — runs
green; exercised in CI by the `dbt` job. The shim now also patches the
`google.cloud.bigquery_storage` clients (when `BIGQUERY_EMULATOR_GRPC_HOST`
is set, which `run.sh` exports) so dbt's Storage Read fast-path for
SELECT result materialization routes through the emulator.

### BL-160 — `OPTIONS(...)` clause on CREATE TABLE / VIEW ✅ — strip + warn-when-non-empty

### BL-161 — 3-part `project.dataset.table` name resolution ✅ — per-segment + single-token backticks; targets, schema names, and FROM refs

### BL-162 — `PARTITION BY` / `CLUSTER BY` on CREATE TABLE AS ✅ — captured into timePartitioning/clustering metadata + ORDER-BY-on-write for the pruning characteristic

### BL-163 — dbt workflow gaps blocked by other features ⏳ · Deps: see below

Not DDL-translation issues — these depend on features deferred elsewhere:
- **Seeds** (load local CSV) need the resumable/multipart upload endpoint
  (BL-092). Until then `dbt seed` fails.
- **Grants** (`+grants` config) need IAM/access (Phase 17, deferred by
  design — emulators don't enforce access). dbt must run with grants off.
- **Python models** need Dataproc/Spark — out of scope entirely.
- **Custom-macro function tail**: dbt packages can call GoogleSQL functions
  DuckDB lacks; these surface as precise `unsupportedFeature` errors and are
  closed case-by-case (sql-coverage test).

## Upstream

### Report @duckdb/node-bindings scalar-UDF event-loop leak ⏳

`connection.registerScalarFunction(...)` creates a napi ThreadSafeFunction
(the bridge that lets DuckDB's execution thread call the JS callback) that
the binding never `unref`s or releases — not even on `connection.closeSync()`
/ `instance.closeSync()`. A ref'd TSFN keeps the libuv event loop alive, so
the process never exits on its own.

**Repro (minimal):** open instance + connection, `registerScalarFunction`,
run one query, `closeSync` both → the process hangs (does not exit). A bare
connection and a `LOAD spatial` connection both exit cleanly; only the UDF
registration leaks. Reproduces on `@duckdb/node-api` `1.5.2-r.1` *and* the
latest `1.5.3-r.2`. Not surfaced in `process._getActiveHandles()` or
`getActiveResourcesInfo()`, so there is no JS-side `unref` lever.

**How it bit us:** the leak was masked for weeks because `node --test`
force-exits past lingering handles on Node 24.15.0 / 26. Node 24.16.0's
test_runner drains the loop instead → CI hung in the coverage step (all
tests passing, no exit). `--test-force-exit` "fixed" the hang but then
crashed Windows (`UV_HANDLE_CLOSING` libuv assertion) by tearing down while
the TSFN async handle was mid-close.

**Suggested fix (PR):** `napi_unref_threadsafe_function` the UDF's TSFN at
creation (a registered function shouldn't pin the process open) and
`napi_release_threadsafe_function` it on connection close. The change is
portable napi C++ — one source edit — but the release must **republish every
per-platform binary**, including `@duckdb/node-bindings-{linux,darwin}-arm64`
(not just x64) and `-win32-x64`; offer to help verify on arm. Can't be
patched locally: it's compiled native code (patch-package is JS-only) and
the bindings ship prebuilt, so a self-fix means forking + the full
cross-platform build matrix.

**Status:** not reported upstream (searched duckdb/duckdb-node-neo issues;
the closest, #375 "fix scalar fn race", is a different bug). Action: file
the issue with the repro above + propose the PR.

**Why it matters:** fixing it unlocks leak-free pure-JS scalar UDFs in
general — we could drop the crypto-extension dependency for SHA512 and
implement FARM_FINGERPRINT in pure JS (see below) without any native build.

### dbt-bigquery custom endpoint (upstream gap, worked around) ⏳

`dbt-bigquery` has no profiles.yml option for a custom API endpoint /
anonymous credentials, so it can't natively point at an emulator. Tracked
upstream as [dbt-bigquery #358](https://github.com/dbt-labs/dbt-bigquery/issues/358).
We work around it with a `sitecustomize.py` monkeypatch (`test/clients/dbt`)
that redirects the BigQuery client when `BIGQUERY_EMULATOR_HOST` is set; a real
project runs green in CI. Drop the shim if/when #358 lands so dbt can be
pointed at the emulator by config alone.

### FARM_FINGERPRINT ⏳

BQ's `FARM_FINGERPRINT(value)` → INT64 via Google FarmHash `Fingerprint64`
(the stable, platform-independent variant — not `Hash64`). Only useful if
bit-exact with BQ, so it can't be approximated with DuckDB's `hash()`. Two
viable native paths (a Node-callback UDF is ruled out — see the leak above):
- **Upstream a FarmHash DuckDB extension** (C++ vendoring Google's MIT
  source) to community-extensions, then `INSTALL farmhash FROM community`
  like we do `crypto`. The community pipeline owns the per-platform/version
  builds. Preferred over a per-project extension (which we'd have to rebuild
  for every DuckDB version × platform).
- **Pure-JS** `Fingerprint64` UDF — only viable once the binding leak above
  is fixed; still needs a JS impl verified bit-exact against BQ.
Currently a precise `unsupportedFeature` error. Moderately common in BQ for
deterministic bucketing / sharding / sampling / surrogate keys.

## Phase 25 — Connections, transfer, kitchen sink

### BL-158 — Connections API ⏳ · Est: 4h · Deps: BL-004

Scope: external data source connection configs (CRUD). Acceptance: config round-trips.

### BL-159 — Data Transfer Service (DTS) ⏳ · Est: 20h+ · Deps: —

Scope: separate API for scheduled transfers from various sources. **Stretch; may stay out of scope.** Acceptance: configured transfer runs on its schedule and writes rows.

---

## Notes for picking items up cold

- New here? `README.md` covers what's built and how it works; architecture lives in the code.
- Every backlog item lists its deps. Don't start one whose deps aren't ✅.
- If you find an item underspecified for what you actually need to do, **update the item in this file** as part of the work, then proceed. Don't silently expand scope.
- If you split an item into smaller pieces, give the new items IDs (`BL-XXX.1`, `BL-XXX.2`) and update deps elsewhere.
- The "Working agreements" at the top apply to every item; they're not repeated per-item.

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
- v1.0.0 remaining (see milestone below): **~75–85 focused hours**.

---

## v1.0.0 milestone

The remaining v1.0.0 scope is the minimum set of features needed for
the emulator to be the obvious choice over `goccy/bigquery-emulator`
for **dbt + Node-client users**. Total estimate: ~75–85h.

Positioning at 1.0.0: *bigquery-local has better SQL & scripting
coverage (procedures, MERGE, QUALIFY, PIVOT, transactions, EXECUTE
IMMEDIATE, etc.) and a comprehensive `INFORMATION_SCHEMA`; goccy has
the gRPC Storage Read/Write APIs.* Both have equivalent REST surface
once 1.0.0 lands.

**In v1.0.0 (by phase):**

- **Phase 12** — BL-071 Routines REST CRUD · BL-072 Models REST CRUD · BL-073 getServiceAccount
- **Phase 13** — BL-075 TABLES/COLUMNS/COLUMN_FIELD_PATHS/TABLE_OPTIONS · BL-076 VIEWS/MATERIALIZED_VIEWS · BL-077 ROUTINES/PARAMETERS/ROUTINE_OPTIONS · BL-078 JOBS\* · BL-079 SCHEMATA
- **Phase 14** — BL-083 Load CSV · BL-084 Load NDJSON · BL-085 Load Parquet · BL-090 schema autodetect · BL-093 GCS reads · BL-094 Extract jobs · BL-095 Copy jobs
- **Phase 15** — BL-096 ingestion-time partitioning · BL-097 column partitioning · BL-099 partition pruning · BL-100 clustering · BL-101 MV DDL + storage · BL-102 MV manual refresh
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
- **Phase 18 (BL-116–121) gRPC Storage Read API** — used by Spark/Beam, not by dbt/Node apps. Point users to goccy if they need it.
- **Phase 19 (BL-122–127) gRPC Storage Write API** — same calculus as Storage Read.
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

### BL-116 — gRPC server scaffold ⏳ · Est: 10h · Deps: BL-001

Scope: bind HTTP/2 on `--grpc-port`; either write minimal gRPC framing or pull `@grpc/grpc-js` as a runtime dep (decide here). Acceptance: a real gRPC client connects and gets a recognizable response.

### BL-117 — CreateReadSession ⏳ · Est: 4h · Deps: BL-116, BL-011

Scope: honor `selected_fields`, `row_restriction`. Acceptance: session created with the right schema + estimated rows.

### BL-118 — Avro stream encoding ⏳ · Est: 6h · Deps: BL-117

Scope: stream Avro bytes over `ReadRows`. Acceptance: client decodes rows correctly.

### BL-119 — Arrow IPC stream encoding ⏳ · Est: 8h · Deps: BL-117

Scope: leverage DuckDB's Arrow result interface; stream Arrow IPC over `ReadRows`. Acceptance: pyarrow can read the stream.

### BL-120 — Multiple parallel streams ⏳ · Est: 4h · Deps: BL-118, BL-119

Scope: session offers N streams; each read its slice. Acceptance: rows are partitioned without duplicates across streams.

### BL-121 — Snapshot time consistency ⏳ · Est: 3h · Deps: BL-117, BL-106

Scope: `snapshot_time` parameter routes the session to the historical view. Acceptance: same session read against a fixed snapshot is repeatable.

## Phase 19 — gRPC Storage Write API

### BL-122 — Default stream (at-least-once) ⏳ · Est: 6h · Deps: BL-116, BL-012

Scope: `_default` stream maps to existing `insertAll` semantics. Acceptance: `AppendRows` against default stream writes rows.

### BL-123 — Application streams: buffered / committed / pending ⏳ · Est: 8h · Deps: BL-122

Scope: per-stream buffering state machine. Acceptance: pending → finalize → batch commit makes data visible only after commit.

### BL-124 — FlushRows / FinalizeWriteStream / BatchCommitWriteStreams ⏳ · Est: 4h · Deps: BL-123

Scope: control RPCs. Acceptance: each RPC has the documented effect on stream state.

### BL-125 — AppendRows offset semantics ⏳ · Est: 4h · Deps: BL-123

Scope: explicit offsets, idempotent retries, out-of-order detection. Acceptance: replayed AppendRows is a no-op; out-of-order offset → error.

### BL-126 — Schema updates mid-stream ⏳ · Est: 3h · Deps: BL-122

Scope: when destination schema changes, server notifies client to refresh. Acceptance: live stream survives an `ALTER TABLE ADD COLUMN`.

### BL-127 — Multiplexing ⏳ · Est: 3h · Deps: BL-122

Scope: multiple write streams on one connection. Acceptance: concurrent streams don't interleave bytes.

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

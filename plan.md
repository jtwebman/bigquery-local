# bigquery-local — BigQuery scope survey

The full map of what Google BigQuery exposes and the rough effort to reach
parity. A scoping reference, **not** a commitment. Current features live in
`README.md`; actionable work items in `BACKLOG.md`. This doc is the "why is X
deferred and how big is it" picture behind those.

Hours are real coding hours (per the "don't estimate in engineer-days" rule),
not calendar time.
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

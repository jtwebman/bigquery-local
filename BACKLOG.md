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
BigQuery parity. v0 items (Phases 1–7, BL-001–025) are detailed; the
post-v0 roadmap (Phases 8 onward) uses a compressed format — expand
those items into full scope/acceptance blocks when their phase
arrives.

**Estimates:**
- v0 (Phases 1–7): **~40 focused hours**.
- v0.x polish (Phase 8): ~30h.
- Full BigQuery parity (everything): **~1,500 hours** before BQML and
  federated; see `plan.md` Appendix for the cost breakdown.

---

## Phase 1 — Repo & infra

### BL-001 — Repo skeleton ✅ · Est: 1h · Deps: —

**Why:** Foundation for everything else.

**Scope:**
- `package.json` with `"type": "module"`, `"engines": { "node": ">=24.0.0" }`, exact-pin deps from plan §language.
- `tsconfig.json` with the full strict profile (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `noEmit`).
- `biome.json` with `suspicious/noExplicitAny: error` and formatter defaults.
- `.npmrc` with `save-exact=true`.
- `.gitignore` covering `node_modules`, `dist/`, `*.duckdb`, `.DS_Store`, `coverage/`.
- `LICENSE` (MIT).
- Empty `src/index.ts` (re-exports nothing yet).
- npm scripts from plan §"npm scripts" wired into `package.json`.

**Acceptance:**
- `npm install` exits 0, writes no caret ranges.
- `npm run typecheck`, `npm run lint`, `npm run format:check` all exit 0.
- `npm test` runs (zero tests, exits 0).

---

### BL-002 — CI workflow ✅ · Est: 30m · Deps: BL-001

**Why:** Quality gate from day one.

**Scope:**
- `.github/workflows/ci.yml`:
  - Triggers: `push`, `pull_request`.
  - Matrix: Node 24 on `ubuntu-latest` + `macos-latest`.
  - Steps: checkout → setup-node (cache npm) → `npm ci` → `format:check` → `lint` → `typecheck` → `test:coverage`.
  - Fails on any non-zero step.

**Acceptance:**
- A pushed branch with the BL-001 scaffold turns the CI badge green on both runners.

---

### BL-003 — gh repo create + first commit ✅ · Est: 15m · Deps: BL-001, BL-002

**Why:** Make the project pushable and visible.

**Scope:**
- Initial commit message: `Initial scaffold`.
- `gh repo create jtwebman/bigquery-local --public --source=. --remote=origin --push`.
- Repo description + topics set via `gh repo edit`.

**Acceptance:**
- Repo visible at `github.com/jtwebman/bigquery-local`; CI green on `main`.

---

## Phase 2 — HTTP + DuckDB foundation

### BL-004 — HTTP server + router ✅ · Est: 2h · Deps: BL-001

**Why:** Every endpoint depends on the router.

**Scope:**
- `src/server.ts` exports `createServer(config)` → `{ listen(port?): Promise<void>, close(): Promise<void>, url: string }`.
- Pure `node:http`. No express, no koa.
- Route registry: `route(method, pathTemplate, handler)`; templates use `{name}` segments compiled to regex.
- JSON request body parsing + JSON response serialization.
- 404 default handler returns Google-style error shape (see BL-005).

**Acceptance:**
- Unit tests cover: route match on method + path, path param extraction, 404 default, body parse error → 400.
- A separate test boots a server on port 0, hits a registered route, and closes cleanly.

---

### BL-005 — Error response shape ✅ · Est: 1h · Deps: BL-004

**Why:** BQ clients depend on Google's exact error shape for retry vs abort decisions.

**Scope:**
- `src/util/errors.ts` exports `BqError(code, reason, message, location?)`.
- Serializer: `BqError → { error: { code, errors: [{ reason, message, location? }], message } }`.
- Reasons covered: `notFound`, `duplicate`, `invalid`, `accessDenied`, `internalError`, `quotaExceeded`, `unsupportedFeature`.
- Server middleware: any thrown `BqError` becomes the serialized response with the correct HTTP status (mapped from `code`).

**Acceptance:**
- Unit tests assert shape for each reason, including HTTP status mapping (e.g. `notFound` → 404, `duplicate` → 409, `invalid` → 400).

---

### BL-006 — Discovery doc endpoint ⏳ · Est: 30m · Deps: BL-004

**Why:** `@google-cloud/bigquery` probes this on init.

**Scope:**
- `GET /discovery/v1/apis/bigquery/v2/rest` returns a minimal valid discovery document describing only the v0 resources.
- Document is a committed JSON file under `src/routes/discovery.json` (not fetched at runtime).

**Acceptance:**
- `curl http://localhost:9050/discovery/v1/apis/bigquery/v2/rest | jq .name` returns `"bigquery"`.
- The `@google-cloud/bigquery` client constructed with `apiEndpoint: server.url` doesn't error on init.

---

### BL-007 — DuckDB connection layer ⏳ · Est: 1.5h · Deps: BL-001

**Why:** Storage substrate everything else uses.

**Scope:**
- `src/storage/db.ts` wraps `@duckdb/node-api` `Instance` + `Connection`.
- `createDb(config) → { exec, query, prepare, close }` with `:memory:` or file path.
- Statement reuse: prepared-statement cache keyed by SQL string.

**Acceptance:**
- Unit tests open an in-memory DB, run `SELECT 1`, close. No leaked handles.

---

### BL-008 — Metadata schema + ETag ⏳ · Est: 2h · Deps: BL-007, BL-005

**Why:** Datasets/tables/jobs need persisted metadata; `PATCH` needs ETags.

**Scope:**
- On startup, ensure `_bq` schema + `_bq.datasets`, `_bq.tables`, `_bq.jobs`, `_bq.job_rows` exist (DDL from plan §Storage layout).
- `src/util/etag.ts`: `etag(value) = sha256(canonicalJson(value)).slice(0,16)`.
- `src/storage/meta.ts`: `getDataset`, `upsertDataset`, `deleteDataset`, `getTable`, `upsertTable`, `deleteTable`, `getJob`, `upsertJob`.
- `If-Match` helper: throws `BqError(412, 'conditionNotMet', ...)` on mismatch.

**Acceptance:**
- Unit tests: ETag stable across reordered keys; If-Match success and failure paths.

---

### BL-009 — BQ ↔ DuckDB type map ⏳ · Est: 2h · Deps: BL-007

**Why:** Tables, insertAll, query results all need consistent type translation.

**Scope:**
- `src/storage/types.ts`: `bqTypeToDuck(field) → string` and `duckTypeToBq(type) → BqField` for every v0 type (STRING/BYTES/INT64/FLOAT64/BOOL/NUMERIC/BIGNUMERIC/TIMESTAMP/DATETIME/DATE/TIME/JSON/GEOGRAPHY/ARRAY/STRUCT).
- Row coercion: `bqRowToDuck(row, schema)` and `duckRowToBq(row, schema)`.
- `REPEATED` mode collapses to DuckDB `LIST`; `STRUCT` to DuckDB `STRUCT`.

**Acceptance:**
- Round-trip tests for every v0 type: encode → decode → equal.

---

## Phase 3 — REST endpoints

### BL-010 — Datasets routes ⏳ · Est: 2h · Deps: BL-008

**Scope:**
- `GET`, `POST`, `PATCH`, `DELETE` on `/projects/{p}/datasets[/{d}]`.
- `PATCH` honors `If-Match`; partial-update semantics (only fields present in body update).
- 404 on missing, 409 on duplicate `POST`, 412 on If-Match mismatch.

**Acceptance:**
- `test/api/datasets.test.ts` covers happy paths + 404 / 409 / 412.

---

### BL-011 — Tables routes ⏳ · Est: 3h · Deps: BL-010, BL-009

**Why:** The headline `PATCH` gap lives here. Test thoroughly.

**Scope:**
- `GET`, `POST`, `PATCH`, `DELETE` on `/projects/{p}/datasets/{d}/tables[/{t}]`.
- `POST`: translate `schema.fields` → DuckDB `CREATE TABLE "{d}"."{t}" (...)`.
- `PATCH` with `schema.fields`: diff against stored schema, issue `ALTER TABLE … ADD COLUMN` per new column. Reject narrowing changes with 400.
- Store / update schema JSON in `_bq.tables`.

**Acceptance:**
- `test/api/tables.test.ts` covers happy paths + PATCH-add-column reflected in DuckDB DDL + 404 / 409 / 412 / narrowing-rejected.

---

### BL-012 — Tabledata.insertAll ⏳ · Est: 3h · Deps: BL-011

**Scope:**
- `POST /projects/{p}/datasets/{d}/tables/{t}/insertAll`.
- Type-coerce each row against stored schema using BL-009 helpers.
- Return `{ kind: "bigquery#tableDataInsertAllResponse", insertErrors: [{ index, errors: [...] }] }` on partial failures.
- `skipInvalidRows` + `ignoreUnknownValues` honored if trivial; otherwise reject with 400.

**Acceptance:**
- `test/api/tabledata.test.ts`: insertAll → rows visible via `SELECT *`; mismatched-type rows → partial failure shape.

---

## Phase 4 — SQL

### BL-013 — SQL tokenizer ⏳ · Est: 2h · Deps: BL-001

**Scope:**
- `src/sql/tokenize.ts` produces a flat token list from a BQ SQL string.
- Token kinds: identifier, backtick-identifier, string (single/double/raw/bytes prefixes), number, operator, keyword, line-comment, block-comment, punctuation, whitespace.
- Robust to: strings containing `--`, comments containing quotes, escaped quote chars.

**Acceptance:**
- Unit tests cover every token kind plus 10+ edge cases.

---

### BL-014 — SQL translator ⏳ · Est: 4h · Deps: BL-013

**Scope:**
- `src/sql/translate.ts` walks tokens, applies the rewrite table from plan §"SQL translation":
  - `` `proj.ds.tbl` `` / `` `ds.tbl` `` → `"ds"."tbl"`
  - `@name` → `$name`
  - `TIMESTAMP_SUB`/`TIMESTAMP_ADD(x, INTERVAL n UNIT)` → `x ± INTERVAL n UNIT`
  - `CURRENT_TIMESTAMP()` → `CURRENT_TIMESTAMP`
  - `JSON_VALUE(j, '$.path')` → `json_extract_string(j, '$.path')`
  - `STARTS_WITH`/`ENDS_WITH` → pass-through
  - `SAFE_CAST(x AS t)` → `try_cast(x AS t)`
- Unknown idioms → throw `BqError(400, 'unsupportedFeature', "BigQuery feature not supported in v0: <token>")`.

**Acceptance:**
- `test/unit/sql/translate.test.ts`: one happy-path test per rewrite + 3 "unsupported feature" rejections.

---

### BL-015 — Query endpoint (POST /queries) ⏳ · Est: 3h · Deps: BL-014, BL-008, BL-009

**Scope:**
- `POST /projects/{p}/queries`: translate → bind named params → execute via DuckDB → map results to BQ wire format `{ schema, rows: [{ f: [{ v }] }], jobComplete: true, totalRows, jobReference }`.
- Persist job + result rows in `_bq.jobs` / `_bq.job_rows` for later `getQueryResults` polling.

**Acceptance:**
- `test/api/queries.test.ts` runs every parameterized query shape in plan §v0 surface against fixture data.

---

### BL-016 — Jobs endpoints ⏳ · Est: 2h · Deps: BL-015

**Scope:**
- `POST /projects/{p}/jobs` for `configuration.query` only in v0; reject other job types with 400 `unsupportedFeature`.
- `GET /projects/{p}/jobs/{j}` returns persisted job record.
- `GET /projects/{p}/queries/{j}` paginates `_bq.job_rows` using `pageToken` + `maxResults`.

**Acceptance:**
- `test/api/jobs.test.ts`: full lifecycle works; pagination returns correct slices.

---

## Phase 5 — CLI, library, packaging

### BL-017 — CLI bin ⏳ · Est: 1.5h · Deps: BL-004

**Scope:**
- `bin/bigquery-local.ts` with shebang `#!/usr/bin/env node`.
- Hand-written flag parser (~40 lines) — no `commander`, no `yargs`.
- Flags: `--project`, `--port`, `--grpc-port`, `--database`, `--log-level`, `--log-format`, `--data-from-yaml`, `-v`, `-h`.
- Calls `createServer()` with parsed config and waits for SIGTERM/SIGINT to gracefully close.

**Acceptance:**
- `node bin/bigquery-local.ts --help` prints the usage block.
- `node bin/bigquery-local.ts --project=local --port=0` boots and accepts a SIGTERM.

---

### BL-018 — Library entrypoint ⏳ · Est: 30m · Deps: BL-015

**Scope:**
- `src/index.ts` re-exports `createServer`, the public `ServerConfig` type, and the public `BqError` type. Nothing else.
- `test/api/library-surface.test.ts` imports only from `'bigquery-local'` (via path alias to `src/index.ts`) and exercises a happy path end-to-end.

**Acceptance:**
- Library-surface test passes; running it against a scratch TS consumer compiles with no warnings.

---

### BL-019 — gRPC port bind + UNIMPLEMENTED ⏳ · Est: 1h · Deps: BL-004

**Scope:**
- Bind a TCP listener on `--grpc-port` (default 9060) and respond at the HTTP/2 framing level minimally enough to return a gRPC `UNIMPLEMENTED` status to any RPC.
- No grpc library dep; respond with the canonical `grpc-status: 12` trailers in a HEADERS frame.

**Acceptance:**
- A real `@google-cloud/bigquery-storage` client constructed against `localhost:9060` and calling `createReadSession` gets a clean `UNIMPLEMENTED` error, not a hang.

---

## Phase 6 — Testing & coverage

### BL-020 — Conformance test: schema-evolution flow ⏳ · Est: 2h · Deps: BL-011, BL-012, BL-015

**Scope:** End-to-end test in `test/conformance/schema-evolution.test.ts`:

1. `createServer({ project: 'test', database: ':memory:' })` → `listen(0)`.
2. Create dataset → create table with initial schema.
3. `insertAll` 5 rows.
4. `PATCH` the table to add a column.
5. `insertAll` 5 more rows that include the new column.
6. Run a parameterized query exercising `JSON_VALUE`, `TIMESTAMP_SUB`, and `UNNEST(@arr)`.
7. Assert all rows present and expected values returned.

**Acceptance:** `node --test test/conformance/schema-evolution.test.ts` passes deterministically.

---

### BL-021 — Coverage to 90% ⏳ · Est: 2h · Deps: BL-016, BL-020

**Scope:** Run `npm run test:coverage`, identify gaps from the coverage report, add targeted unit tests in `test/unit/` until each threshold ≥ 90. Mark genuinely unreachable branches with `/* node:coverage disable */` rather than padding with fake tests.

**Acceptance:** `npm run test:coverage` exits 0 with lines, branches, and functions all ≥ 90%.

---

## Phase 7 — Distribution

### BL-022 — Dockerfile (multi-stage, multi-arch) ⏳ · Est: 1.5h · Deps: BL-017

**Scope:**
- Multi-stage `Dockerfile` on `node:24-alpine`:
  - Stage 1: `npm ci --omit=dev` after copying only `package.json` + `package-lock.json` + `.npmrc`.
  - Stage 2: copy `node_modules`, `bin/`, `src/`, `package.json`.
- `ENTRYPOINT ["node", "bin/bigquery-local.ts"]`.
- Healthcheck: `wget -qO- http://localhost:9050/discovery/v1/apis/bigquery/v2/rest >/dev/null || exit 1`.

**Acceptance:**
- `docker buildx build --platform linux/amd64,linux/arm64 -t test .` succeeds locally.
- Running the image with `--project=local --port=9050` serves the discovery doc.

---

### BL-023 — Publish workflow ⏳ · Est: 1h · Deps: BL-022

**Scope:**
- `.github/workflows/publish.yml`, triggered on tag `v*`.
- Steps: checkout → `docker/setup-qemu-action` → `docker/setup-buildx-action` → `docker/login-action@v3` (uses `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN` secrets) → `docker/build-push-action` with `linux/amd64,linux/arm64` and tags `jtwebman/bigquery-local:${{ tag }}` + `:latest`.
- Document required repo secrets in `.github/SECRETS.md` (not committed values).

**Acceptance:**
- Pushing tag `v0.1.0` produces a successful publish; `docker pull jtwebman/bigquery-local:0.1.0` works on both arches.

---

### BL-024 — npm publish path ⏳ · Est: 1h · Deps: BL-018

**Scope:**
- Add `"build": "tsc"` and `"prepublishOnly": "npm run build"` scripts.
- Configure `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`, `"exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } }`, `"bin": { "bigquery-local": "./bin/bigquery-local.js" }`, `"files": ["dist", "bin"]`.
- Add `bin/bigquery-local.js` as the compiled CLI entry (emitted by `tsc`).
- Verify with `npm pack` + inspect tarball contents.

**Acceptance:** `npm pack` produces a tarball with exactly `dist/`, `bin/`, `package.json`, `README.md`, `LICENSE`. A scratch consumer can `npm i ./tarball.tgz` and call `createServer` from TS or JS.

---

### BL-025 — README polish for first publish ⏳ · Est: 1h · Deps: BL-024, BL-022

**Scope:** Bring `README.md` to ship-quality: install via Docker + npm, embedded usage example using `createServer`, CLI reference, feature-status table reflecting **actually-implemented** features (flip ⏳ → ✅ where appropriate), pointers to `plan.md` and `BACKLOG.md`.

**Acceptance:** README renders cleanly on GitHub and on the npm package page.

---

# Post-v0 roadmap

Everything below is post-v0. Items below use a **compressed format**:
title + 1-line scope + 1-line acceptance + deps. Expand any item
into full detail (matching the v0 items above) before starting work
on it.

Phases are loosely ordered by likely sequencing, not strict dependency
— many phases can interleave once their gating deps are done.

## Phase 8 — v0.x polish (drop-in completeness)

### BL-026 — `--data-from-yaml` initial seed ⏳ · Est: 2h · Deps: BL-010, BL-011
Scope: parse a YAML seed file at startup, create the declared datasets/tables and `insertAll` declared rows. Acceptance: a published seed YAML round-trips through startup and the data is queryable.

### BL-027 — Datasets list endpoint with pagination ⏳ · Est: 1.5h · Deps: BL-010
Scope: `GET /projects/{p}/datasets` with `pageToken`, `maxResults`. Acceptance: list returns all datasets paginated; `pageToken` round-trips.

### BL-028 — Tables list endpoint with pagination ⏳ · Est: 1.5h · Deps: BL-011
Scope: `GET /projects/{p}/datasets/{d}/tables` with pagination. Acceptance: matches Datasets list semantics.

### BL-029 — Jobs list endpoint with filters ⏳ · Est: 2h · Deps: BL-016
Scope: `GET /projects/{p}/jobs` with `stateFilter`, `minCreationTime`, `maxCreationTime`, `projection`. Acceptance: filters narrow results correctly.

### BL-030 — `jobs.cancel` + `jobs.delete` ⏳ · Est: 1h · Deps: BL-016
Scope: terminate / remove a job record. Acceptance: cancelled job's state becomes `DONE` with `errorResult.reason='stopped'`; delete removes row.

### BL-031 — `tabledata.list` paginated ⏳ · Est: 2h · Deps: BL-012
Scope: `GET /projects/{p}/datasets/{d}/tables/{t}/data` with pagination, `selectedFields`. Acceptance: paginates correctly; `selectedFields` projects.

### BL-032 — `insertAll` insertId-based dedup ⏳ · Est: 2h · Deps: BL-012
Scope: maintain a per-table insertId LRU; skip duplicate inserts within the dedup window. Acceptance: same `insertId` twice → second is a no-op.

### BL-033 — `insertAll` templateSuffix tables ⏳ · Est: 2h · Deps: BL-012
Scope: when request includes `templateSuffix`, auto-create `<base>_<suffix>` table from base schema. Acceptance: insertAll against a template suffix creates the target table on first hit.

### BL-034 — Multi-project: repeatable `--project` ⏳ · Est: 1h · Deps: BL-017, BL-008
Scope: parser accepts multiple `--project` flags; metadata is scoped by project. Acceptance: two projects with same dataset name don't collide.

### BL-035 — `dryRun: true` for queries ⏳ · Est: 2h · Deps: BL-015
Scope: when `dryRun` is set, translate + parse without executing, return schema + bytes-processed estimate. Acceptance: `dryRun` returns `jobComplete: true, statistics.totalBytesProcessed` without writing rows.

### BL-036 — Query result `pageToken` semantics ⏳ · Est: 1h · Deps: BL-016
Scope: opaque page tokens encoded as `{ jobId, offset }`; honor `startIndex` + `maxResults`. Acceptance: token round-trips; out-of-range token → 400.

## Phase 9 — SQL function coverage

### BL-037 — String function expansion ⏳ · Est: 3h · Deps: BL-014
Scope: REGEXP_CONTAINS / EXTRACT / EXTRACT_ALL / REPLACE, FORMAT, LPAD / RPAD, NORMALIZE / NORMALIZE_AND_CASEFOLD, TRANSLATE, REPEAT, REVERSE, OCTET_LENGTH. Acceptance: 1 happy-path test per function.

### BL-038 — Numeric/math function expansion ⏳ · Est: 2h · Deps: BL-014
Scope: TRUNC, MOD, ABS, SIGN, CEIL, FLOOR, ROUND, POWER, EXP, LN, LOG, LOG10, SQRT, SAFE_DIVIDE, IEEE_DIVIDE, IS_INF, IS_NAN. Acceptance: 1 test per function.

### BL-039 — Date/time function expansion (1) ⏳ · Est: 3h · Deps: BL-014
Scope: DATE_TRUNC / TIMESTAMP_TRUNC / DATETIME_TRUNC, FORMAT_TIMESTAMP / FORMAT_DATE, PARSE_TIMESTAMP / PARSE_DATE, EXTRACT, DATE_DIFF / TIMESTAMP_DIFF. Acceptance: format strings match BQ spec (%Y %m %d %H %M %S %z).

### BL-040 — Date/time function expansion (2) ⏳ · Est: 2h · Deps: BL-039
Scope: GENERATE_DATE_ARRAY / GENERATE_TIMESTAMP_ARRAY, LAST_DAY, DATE_FROM_UNIX_DATE, UNIX_DATE, UNIX_SECONDS / MILLIS / MICROS. Acceptance: 1 test per function.

### BL-041 — JSON function expansion ⏳ · Est: 2h · Deps: BL-014
Scope: JSON_QUERY, JSON_QUERY_ARRAY, JSON_VALUE_ARRAY, JSON_TYPE, JSON_KEYS, TO_JSON, TO_JSON_STRING, PARSE_JSON, BOOL/INT64/FLOAT64/STRING/SAFE_TO_* JSON conversions. Acceptance: tests cover happy path + null path for each.

### BL-042 — Array function expansion ⏳ · Est: 2h · Deps: BL-014
Scope: ARRAY_AGG, GENERATE_ARRAY, ARRAY_TO_STRING, ARRAY_CONCAT, ARRAY_LENGTH, ARRAY_REVERSE, OFFSET / ORDINAL / SAFE_OFFSET subscripts, FLATTEN. Acceptance: 1 test per function.

### BL-043 — Aggregate function expansion ⏳ · Est: 2h · Deps: BL-014
Scope: STRING_AGG, ANY_VALUE, LOGICAL_AND / LOGICAL_OR, BIT_AND / BIT_OR / BIT_XOR, COUNTIF, MIN/MAX over arrays, ARRAY_CONCAT_AGG. Acceptance: 1 test per function.

### BL-044 — Window/analytic functions ⏳ · Est: 3h · Deps: BL-014
Scope: ROW_NUMBER, RANK, DENSE_RANK, PERCENT_RANK, CUME_DIST, NTILE, LAG, LEAD, FIRST_VALUE, LAST_VALUE, NTH_VALUE + frame syntax. Acceptance: tests cover PARTITION BY + ORDER BY + frame.

### BL-045 — Approximate aggregation ⏳ · Est: 4h · Deps: BL-014
Scope: APPROX_COUNT_DISTINCT, APPROX_QUANTILES, APPROX_TOP_COUNT, HLL_COUNT.INIT / MERGE / EXTRACT, KLL_QUANTILES.INIT / MERGE / EXTRACT_POINT. Acceptance: numeric tolerance tests (±5%) vs exact counterparts.

### BL-046 — Statistical aggregate ⏳ · Est: 1.5h · Deps: BL-014
Scope: CORR, COVAR_POP, COVAR_SAMP, STDDEV_POP, STDDEV_SAMP, VAR_POP, VAR_SAMP. Acceptance: 1 test per function, ±1e-9 tolerance.

### BL-047 — Hash & fingerprint functions ⏳ · Est: 1h · Deps: BL-014
Scope: MD5, SHA1, SHA256, SHA512, FARM_FINGERPRINT. Acceptance: known-vector tests for each.

### BL-048 — Bitwise functions ⏳ · Est: 30m · Deps: BL-014
Scope: BIT_COUNT, `<<`, `>>`, `&`, `|`, `^`, `~`. Acceptance: 1 test per operator.

### BL-049 — Conversion / cast formatting ⏳ · Est: 2h · Deps: BL-014
Scope: format-aware CAST (`CAST(x AS STRING FORMAT 'YYYY-MM-DD')`), PARSE_DATE / PARSE_TIMESTAMP with format strings, FORMAT() function. Acceptance: format-string spec tests.

### BL-050 — Net functions ⏳ · Est: 1h · Deps: BL-014
Scope: NET.IP_FROM_STRING, NET.IP_TO_STRING, NET.IPV4_FROM_INT64, NET.IPV4_TO_INT64, NET.HOST, NET.PUBLIC_SUFFIX, NET.REG_DOMAIN. Acceptance: 1 test per function.

### BL-051 — `SAFE.` function prefix ⏳ · Est: 2h · Deps: BL-014
Scope: lexer recognizes `SAFE.<func>(...)`; translator wraps the call so errors return NULL. Acceptance: `SAFE.DIVIDE(1, 0) IS NULL` returns true.

## Phase 10 — SQL statements & language features

### BL-052 — INSERT / UPDATE / DELETE (single-table) ⏳ · Est: 2h · Deps: BL-014, BL-015
Scope: full DML pass-through to DuckDB. Acceptance: each statement type has end-to-end tests.

### BL-053 — MERGE ⏳ · Est: 4h · Deps: BL-052
Scope: full MERGE statement support; map to DuckDB upsert idioms where needed. Acceptance: BigQuery's MERGE examples pass.

### BL-054 — DDL: VIEW ⏳ · Est: 2h · Deps: BL-011
Scope: `CREATE VIEW`, `DROP VIEW`; stored as DuckDB view + metadata. Acceptance: view appears in `_bq.tables` with `type='VIEW'`; SELECT against it works.

### BL-055 — DDL: SCHEMA (CREATE/DROP) ⏳ · Est: 1h · Deps: BL-010
Scope: SQL DDL surface for dataset metadata (parity with REST). Acceptance: `CREATE SCHEMA test` creates a dataset visible via REST GET.

### BL-056 — GROUP BY ROLLUP / CUBE / GROUPING SETS ⏳ · Est: 3h · Deps: BL-014
Scope: rewrite to UNION ALL of regular GROUP BY (or pass through if DuckDB supports). Acceptance: standard ROLLUP example from BQ docs passes.

### BL-057 — QUALIFY ⏳ · Est: 2h · Deps: BL-044
Scope: rewrite `… QUALIFY <window-expr>` to outer subquery + WHERE. Acceptance: example QUALIFY queries return expected rows.

### BL-058 — PIVOT / UNPIVOT ⏳ · Est: 3h · Deps: BL-014
Scope: rewrite PIVOT/UNPIVOT clauses (DuckDB supports natively). Acceptance: BQ doc examples pass.

### BL-059 — TABLESAMPLE ⏳ · Est: 1.5h · Deps: BL-014
Scope: `TABLESAMPLE SYSTEM (n PERCENT)` rewrite. Acceptance: sample size within ±20% of expected on 10k-row table.

### BL-060 — Wildcard tables + `_TABLE_SUFFIX` ⏳ · Est: 3h · Deps: BL-014
Scope: resolve `\`ds.events_*\`` at translate time to `UNION ALL`; expose `_TABLE_SUFFIX` pseudo column. Acceptance: wildcard query returns rows from all matching tables with correct suffix.

### BL-061 — TRUNCATE TABLE ⏳ · Est: 30m · Deps: BL-052
Scope: drop and recreate the underlying DuckDB table. Acceptance: row count goes to 0; schema preserved.

### BL-062 — Multi-statement transactions ⏳ · Est: 2h · Deps: BL-052
Scope: BEGIN / COMMIT / ROLLBACK; align semantics with BQ docs (limited rollback in real BQ). Acceptance: transactional rollback test passes.

## Phase 11 — Functions, procedures, scripting

### BL-063 — SQL UDF (`CREATE FUNCTION`) ⏳ · Est: 3h · Deps: BL-014
Scope: persistent + temporary SQL UDFs; type signatures stored in `_bq.routines`. Acceptance: defined UDF is callable in subsequent queries.

### BL-064 — Table-valued functions ⏳ · Est: 4h · Deps: BL-063
Scope: TVFs that return relations. Acceptance: TVF used in FROM clause returns expected rows.

### BL-065 — Stored procedures (`CREATE PROCEDURE`) ⏳ · Est: 4h · Deps: BL-063, BL-066
Scope: procedure body parsed and executed via scripting runtime; `CALL` invokes. Acceptance: `CALL test.my_proc()` runs body's statements.

### BL-066 — Scripting: DECLARE / SET / IF ⏳ · Est: 4h · Deps: BL-014
Scope: variable scoping; conditional execution; multi-statement script entrypoint. Acceptance: example scripts from BQ docs run end-to-end.

### BL-067 — Scripting: loops ⏳ · Est: 3h · Deps: BL-066
Scope: WHILE, LOOP, FOR, REPEAT, BREAK, CONTINUE. Acceptance: standard loop examples run with correct iteration counts.

### BL-068 — Scripting: CALL / EXECUTE IMMEDIATE / RETURN ⏳ · Est: 3h · Deps: BL-066
Scope: dynamic SQL execution and procedure invocation. Acceptance: EXECUTE IMMEDIATE example runs.

### BL-069 — Scripting: EXCEPTION handlers ⏳ · Est: 2h · Deps: BL-066
Scope: BEGIN … EXCEPTION WHEN ERROR THEN … END. Acceptance: errors caught by handler; `@@error.message` populated.

### BL-070 — JS UDFs ⏳ · Est: 8h · Deps: BL-063
Scope: sandboxed JS UDFs via `vm` module; BQ argument/return type marshalling. Acceptance: a `RETURNS FLOAT64 LANGUAGE js AS '''return x * 2;'''` example works.

## Phase 12 — Routines / models / sessions

### BL-071 — Routines REST CRUD ⏳ · Est: 2h · Deps: BL-063
Scope: `GET`, `POST`, `PATCH`, `DELETE` on `/projects/{p}/datasets/{d}/routines[/{r}]`. Acceptance: routines CRUD via REST round-trips.

### BL-072 — Models REST CRUD (metadata) ⏳ · Est: 2h · Deps: BL-008
Scope: model metadata storage + endpoints. No actual training. Acceptance: model record visible via REST `GET` after `POST`.

### BL-073 — Projects + getServiceAccount endpoints ⏳ · Est: 30m · Deps: BL-004
Scope: minimal stubs returning configured projects list and a fake service account. Acceptance: BQ client `getProjects()` returns the right list.

### BL-074 — Sessions: TEMP scoping + session params ⏳ · Est: 3h · Deps: BL-016
Scope: session ID tracked in `_bq.sessions`; TEMP tables/functions scoped per session; session-scoped variables. Acceptance: TEMP table visible within session, gone after `endSession`.

## Phase 13 — INFORMATION_SCHEMA

### BL-075 — TABLES / COLUMNS / COLUMN_FIELD_PATHS / TABLE_OPTIONS ⏳ · Est: 3h · Deps: BL-011
Scope: virtual views over `_bq.tables`. Acceptance: `SELECT * FROM \`region-us\`.INFORMATION_SCHEMA.TABLES` returns sane rows.

### BL-076 — VIEWS / MATERIALIZED_VIEWS ⏳ · Est: 2h · Deps: BL-054
Scope: virtual views over view metadata. Acceptance: view DDL appears in `view_definition` column.

### BL-077 — ROUTINES / PARAMETERS / ROUTINE_OPTIONS ⏳ · Est: 2h · Deps: BL-063
Scope: virtual views over routine metadata. Acceptance: UDF rows present and well-shaped.

### BL-078 — JOBS / JOBS_BY_USER / JOBS_BY_PROJECT / JOBS_BY_ORGANIZATION / JOBS_TIMELINE_* ⏳ · Est: 4h · Deps: BL-016
Scope: virtual views over `_bq.jobs`. Acceptance: jobs visible per filter scope; `JOBS_TIMELINE` returns plausible numbers.

### BL-079 — SCHEMATA + SCHEMATA_OPTIONS ⏳ · Est: 1h · Deps: BL-010
Scope: virtual views over datasets. Acceptance: shape matches BQ doc.

### BL-080 — SEARCH_INDEXES + VECTOR_INDEXES ⏳ · Est: 1h · Deps: BL-134, BL-137
Scope: virtual views over search/vector index metadata. Acceptance: created indexes appear.

### BL-081 — SESSIONS_BY_USER + SESSIONS_BY_PROJECT ⏳ · Est: 1h · Deps: BL-074
Scope: virtual views over sessions. Acceptance: active sessions appear with start/end timestamps.

### BL-082 — STREAMING_TIMELINE_BY_* ⏳ · Est: 2h · Deps: BL-012
Scope: time-bucketed counts of streaming inserts. Acceptance: inserted rows show up in the correct timestamp bucket.

## Phase 14 — Load / extract / copy jobs

### BL-083 — Load: CSV ⏳ · Est: 4h · Deps: BL-016, BL-093
Scope: jobs.insert with `configuration.load`, sourceFormat=CSV, from GCS emulator. Honor quoting, header detection, schema autodetect (BL-090). Acceptance: a CSV in the GCS emulator becomes table rows.

### BL-084 — Load: NDJSON ⏳ · Est: 2h · Deps: BL-083
Scope: sourceFormat=NEWLINE_DELIMITED_JSON. Acceptance: NDJSON file becomes rows; nested types map to STRUCT/ARRAY.

### BL-085 — Load: Parquet ⏳ · Est: 2h · Deps: BL-083
Scope: sourceFormat=PARQUET via DuckDB's native `read_parquet`. Acceptance: Parquet file becomes rows; schema autodetected from file.

### BL-086 — Load: Avro ⏳ · Est: 6h · Deps: BL-083
Scope: sourceFormat=AVRO; pull a small Avro reader dep or use DuckDB's avro extension. Acceptance: Avro file becomes rows.

### BL-087 — Load: ORC ⏳ · Est: 6h · Deps: BL-083
Scope: sourceFormat=ORC; pull a small ORC reader dep. Acceptance: ORC file becomes rows.

### BL-088 — Load: Datastore / Firestore export ⏳ · Est: 6h · Deps: BL-083
Scope: parse LevelDB-style export format. Acceptance: a sample export becomes rows.

### BL-089 — Load: Iceberg ⏳ · Est: 10h · Deps: BL-085
Scope: Iceberg manifest + snapshot resolution; read underlying Parquet via DuckDB. Acceptance: pointing load at an Iceberg location reads the current snapshot.

### BL-090 — Schema autodetect ⏳ · Est: 4h · Deps: BL-083
Scope: when no schema provided, infer from first N rows. Acceptance: load with `autodetect: true` produces correct schema.

### BL-091 — Hive partitioning options ⏳ · Est: 3h · Deps: BL-085
Scope: `hivePartitioningOptions.mode=AUTO|STRINGS|CUSTOM`; expose partition columns. Acceptance: load from a Hive-partitioned tree exposes the partition keys.

### BL-092 — Local file multipart resumable upload ⏳ · Est: 4h · Deps: BL-083
Scope: implement the resumable upload protocol the gcloud client uses for `bq load`. Acceptance: `bq load` from local file works.

### BL-093 — GCS reads via `STORAGE_EMULATOR_HOST` ⏳ · Est: 3h · Deps: BL-001
Scope: HTTP client honoring the env var; minimal range-get support. Acceptance: load against fake-gcs-server works.

### BL-094 — Extract jobs ⏳ · Est: 6h · Deps: BL-093
Scope: destination format CSV / JSON / Avro / Parquet, optional compression, to GCS. Acceptance: extract writes the file; round-trip via load returns the same rows.

### BL-095 — Copy table jobs ⏳ · Est: 3h · Deps: BL-016
Scope: snapshot / clone / deep copy via `configuration.copy`. Acceptance: copied table has the source's rows + schema.

## Phase 15 — Partitioning, clustering, materialized views

### BL-096 — Ingestion-time partitioning ⏳ · Est: 4h · Deps: BL-011
Scope: `_PARTITIONTIME` / `_PARTITIONDATE` pseudo columns; partition by ingestion time. Acceptance: queries scoped to a partition only read that partition's rows.

### BL-097 — Column partitioning (DATE/TIMESTAMP/DATETIME) ⏳ · Est: 3h · Deps: BL-011
Scope: declare a partition column; expose `_PARTITION*` pseudo columns. Acceptance: `WHERE date_col = '2026-05-15'` reads only that partition.

### BL-098 — Integer-range partitioning ⏳ · Est: 3h · Deps: BL-011
Scope: `range_partitioning` with start/end/interval. Acceptance: integer-bucketed partitions readable by range.

### BL-099 — Partition pruning at query time ⏳ · Est: 4h · Deps: BL-096, BL-097, BL-098
Scope: parse WHERE clause partition predicates and route reads to only matching partitions. Acceptance: `_PARTITIONTIME` filter cuts bytes-processed in the dry-run estimate.

### BL-100 — Clustering keys ⏳ · Est: 4h · Deps: BL-011
Scope: store clustering metadata; on write, sort buffers by cluster keys before flushing. Acceptance: cluster keys reduce scanned bytes on point lookups.

### BL-101 — Materialized views: DDL + storage ⏳ · Est: 4h · Deps: BL-054
Scope: `CREATE MATERIALIZED VIEW`; materialize as a real table backed by `_bq.tables`. Acceptance: MV row count matches its source query at creation time.

### BL-102 — MV manual refresh ⏳ · Est: 3h · Deps: BL-101
Scope: `CALL BQ.REFRESH_MATERIALIZED_VIEW()`. Acceptance: refresh updates MV rows from source.

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

### BL-128 — GEOGRAPHY type round-trip ⏳ · Est: 4h · Deps: BL-009
Scope: parse WKT + WKB on input; emit WKT on query output. Acceptance: round-trip of a POINT / POLYGON / MULTIPOLYGON preserves coordinates.

### BL-129 — Spatial library bridge ⏳ · Est: 8h · Deps: BL-128
Scope: pull DuckDB spatial extension OR a JS S2 implementation. Decide here and document. Acceptance: a `ST_*` call against the engine returns a recognized type.

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

### BL-152 — Cost estimation ⏳ · Est: 4h · Deps: BL-035
Scope: `totalBytesProcessed`, `totalSlotMs`. Acceptance: byte estimate matches actual bytes within ±20% for fixture queries.

### BL-153 — Job priorities (INTERACTIVE / BATCH) ⏳ · Est: 1h · Deps: BL-016
Scope: accept and surface; no actual scheduling. Acceptance: round-trips through job metadata.

### BL-154 — Labels propagation ⏳ · Est: 2h · Deps: BL-008
Scope: labels on datasets/tables/jobs/models/routines round-trip via REST. Acceptance: labels survive PATCH.

### BL-155 — Locations metadata ⏳ · Est: 2h · Deps: BL-008
Scope: store `location` on datasets; reject cross-location operations with the right error. Acceptance: dataset.location round-trips; mismatched-location job fails with `invalid`.

### BL-156 — Slot reservations API (stub) ⏳ · Est: 4h · Deps: BL-004
Scope: reservations / assignments REST surface; no real slot semantics. Acceptance: CRUD round-trips.

### BL-157 — `useQueryCache` semantics ⏳ · Est: 4h · Deps: BL-015
Scope: cache query results keyed by SQL + params; return cached results when `useQueryCache: true`. Acceptance: cache hit increments a counter; bypass works.

## Phase 25 — Connections, transfer, kitchen sink

### BL-158 — Connections API ⏳ · Est: 4h · Deps: BL-004
Scope: external data source connection configs (CRUD). Acceptance: config round-trips.

### BL-159 — Data Transfer Service (DTS) ⏳ · Est: 20h+ · Deps: —
Scope: separate API for scheduled transfers from various sources. **Stretch; may stay out of scope.** Acceptance: configured transfer runs on its schedule and writes rows.

---

## Notes for picking items up cold

- Read `plan.md` first if you haven't worked in this repo before. It's the source of truth for architecture and conventions.
- Every backlog item lists its deps. Don't start one whose deps aren't ✅.
- If you find an item underspecified for what you actually need to do, **update the item in this file** as part of the work, then proceed. Don't silently expand scope.
- If you split an item into smaller pieces, give the new items IDs (`BL-XXX.1`, `BL-XXX.2`) and update deps elsewhere.
- The "Working agreements" at the top apply to every item; they're not repeated per-item.

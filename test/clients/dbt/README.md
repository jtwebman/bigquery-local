# Running dbt against bigquery-local

`dbt-bigquery` has no profiles.yml option for a custom API endpoint or
anonymous credentials, so it can't be pointed at an emulator out of the box
(tracked upstream as [dbt-labs/dbt-bigquery#358](https://github.com/dbt-labs/dbt-bigquery/issues/358)).
Until that lands, a small monkeypatch makes it work. This directory is both the
recipe and the project's dbt conformance test.

## The recipe

1. Start the emulator:

   ```
   npx bigquery-local --port=9050
   ```

2. Copy [`sitecustomize.py`](./sitecustomize.py) somewhere on your `PYTHONPATH`.
   Python auto-imports it at startup; when `BIGQUERY_EMULATOR_HOST` is set it
   redirects every BigQuery client to the emulator with anonymous credentials.

3. Point dbt at the emulator and run:

   ```
   export BIGQUERY_EMULATOR_HOST=http://localhost:9050
   export BIGQUERY_EMULATOR_PROJECT=my-project        # matches your profile's project
   export PYTHONPATH=/path/to/sitecustomize/dir:$PYTHONPATH
   dbt run
   dbt test
   ```

Your `profiles.yml` uses the normal `method: oauth` (no real OAuth happens —
the shim swaps in anonymous credentials). See [`project/profiles.yml`](./project/profiles.yml).

## What works

`table`, `view`, and `incremental` (MERGE) materializations and `dbt test`
run against the emulator. The translator handles the BigQuery DDL dbt emits:
`OPTIONS(...)`, `PARTITION BY` / `CLUSTER BY`, fully-qualified
`` `project`.`dataset`.`table` `` names, and the incremental MERGE.

## What doesn't (yet)

- **Seeds** (`dbt seed`) — need the local-file upload endpoint (not implemented).
- **Grants** (`+grants`) — the emulator doesn't enforce access; run with grants off.
- **Python models** — need Dataproc/Spark; out of scope.
- **`OPTIONS(...)` content** (descriptions/labels) and `PARTITION BY`/`CLUSTER BY`
  are accepted but partition/cluster are metadata-only; descriptions are dropped.
- Functions in custom macros/packages that DuckDB lacks surface as
  `unsupportedFeature` errors.

This is a workaround, not a supported integration — revisit when #358 lands.

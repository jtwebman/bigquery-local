# Real-BigQuery replay suite

Fixture-driven comparison tests. Each fixture has:

- `bq-fixtures/NNN-name.sql` — the SQL we want both engines to run.
- `bq-fixtures/NNN-name.json` — the canonicalized response we captured
  from real BigQuery.

The `bq-replay.test.ts` harness runs the SQL through bigquery-local,
canonicalizes the response the same way, and diffs against the
fixture. CI runs the comparison; capture is **always manual** because
it costs real BigQuery query bytes and needs GCP credentials.

## Adding a fixture

1. Drop a `NNN-name.sql` file in `bq-fixtures/`.
2. Run the capture script (see below) to produce the sibling
   `NNN-name.json`.
3. Commit both files.

## Capturing against real BigQuery

The capture script reads the BQ project from `BQ_PROJECT_ID`,
defaulting to `stg-drops-1`. Authenticate via Application Default
Credentials once (`gcloud auth application-default login`), then:

```sh
# Default project (stg-drops-1):
npm run bq-replay:capture

# Or override:
BQ_PROJECT_ID=my-personal-project npm run bq-replay:capture
```

Re-running the capture overwrites every fixture's `.json`. Refresh
when BQ output shifts or when you add a field you want to verify.

## What gets canonicalized

The harness strips fields that legitimately differ between runs or
between engines:

- Timing: `creationTime`, `startTime`, `endTime`, `totalSlotMs`
- Identity: `jobReference.jobId`, `etag`, `id`, `kind`, `queryId`,
  `sessionInfo`, `cacheHit`
- Cost: `totalBytesProcessed` (we estimate, BQ measures)

What stays:

- Schema field names, types, modes, `rangeElementType`
- Row values, exact bit-for-bit (`f[].v` wire shape)

## Fixture metadata

Sidecar `bq-fixtures/NNN-name.meta.json`:

```json
{ "sortRowsBy": "id" }
```

`sortRowsBy` is a column name; the harness sorts both responses by it
before diffing so non-deterministic row order doesn't trip the test.
Omit it for queries with `ORDER BY`.

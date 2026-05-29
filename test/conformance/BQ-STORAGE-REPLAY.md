# Real-BigQuery gRPC Storage Read replay suite

Fixture-driven byte-for-byte comparison between bigquery-local's gRPC
Storage Read implementation and real BigQuery. Mirrors the HTTP-side
`bq-replay` suite — same idea, different protocol.

Each fixture has:

- `bq-storage-fixtures/NNN-name.fixture.json` — input: table schema,
  data (as `INSERT` SQL the harness runs locally and the capture
  script runs against real BQ), and `CreateReadSession` options.
- `bq-storage-fixtures/NNN-name.captured.json` — output: the
  canonicalized `CreateReadSession` response + `ReadRows` batches
  captured from real BigQuery.

The `bq-storage-replay.test.ts` harness materializes the fixture in
the local emulator, opens a real `@grpc/grpc-js` client against it,
collects the same RPC outputs, canonicalizes them the same way, and
diffs against the captured file. CI runs the comparison; capture is
**always manual** because it costs real BQ bytes and needs GCP
credentials.

## Adding a fixture

1. Drop a `NNN-name.fixture.json` file in `bq-storage-fixtures/`.
   Use `$TABLE` as a placeholder for the qualified table name — the
   harness substitutes the local table; the capture script substitutes
   the real-BQ table.
2. Run the capture script to produce the sibling `.captured.json`.
3. Commit both files.

## Capturing against real BigQuery

The capture script reads the BQ project from `BQ_PROJECT_ID`,
defaulting to `stg-drops-1`. Authenticate via Application Default
Credentials once (`gcloud auth application-default login`), then:

```sh
# Default project (stg-drops-1):
npm run bq-storage-replay:capture

# Or override:
BQ_PROJECT_ID=my-personal-project npm run bq-storage-replay:capture
```

The script materializes each fixture as a real BQ table in
`<project>.bq_storage_replay`, opens a `CreateReadSession` + reads
every stream to completion, then writes the canonicalized response.
Tables are reused across runs (re-created on each capture) so storage
cost stays trivial.

## What gets canonicalized

Things that legitimately differ between runs:

- Session names (`projects/.../sessions/<uuid>`) → `<SESSION_ID>`
- Stream names → `<STREAM_NAME_i>`
- `expireTime` (wall-clock derived) → dropped
- Project segment of the resource path → `<PROJECT>` (so the
  emulator's `projects/test/...` and real-BQ's
  `projects/stg-drops-1/...` compare equal)
- Avro schema JSON → re-emitted with stable key ordering

What stays — and must match byte-for-byte:

- Avro schema's `type` / `name` / `fields[].name` / `fields[].type`
- `dataFormat`
- `streamCount`
- `readOptions` echo (`selectedFields`, `rowRestriction`)
- `estimatedRowCount`
- `ReadRowsResponse.avroRows.serializedBinaryRows` (concatenated
  across all responses, then base64-compared — Avro binary is
  deterministic for value+schema, so identical inputs must produce
  identical bytes regardless of how the server chunked them)

## When a fixture diverges

A diff isn't necessarily a bug in the emulator — it can also be:

- A real BQ schema field we omit (e.g. namespace, doc strings)
- An ordering difference inside Avro records
- A logical-type encoding mismatch (NUMERIC scale, TIME unit, …)

Either way the diff is the test result. Fix the emulator, or — if
the field is intentionally not emulated — update the canonicalizer
to drop / normalize it and document why here.

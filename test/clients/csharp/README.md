# C# client tests

Runs the official `Google.Cloud.BigQuery.V2` (REST) + `Google.Cloud.BigQuery.Storage.V1` (gRPC) clients against the bigquery-local emulator.

## Prereqs

- .NET SDK 8.0+ (`brew install --cask dotnet-sdk` on macOS)
- `node` on PATH (the test harness spawns `node src/cli.ts` as the emulator)

## Run

```sh
cd test/clients/csharp
dotnet test
```

`dotnet test` will restore packages on first run.

## What's tested

- **`StorageReadTests`** — `BigQueryReadClient` against the gRPC port: `CreateReadSession` + `ReadRows` over Avro IPC. Insecure channel because the emulator listens plaintext HTTP/2.

Add `StorageWriteTests` (AppendRows / FlushRows / FinalizeWriteStream / BatchCommit) as a follow-up; the patterns mirror the Java test under `test/clients/java/.../StorageTest.java`.

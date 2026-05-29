using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Google.Api.Gax.Grpc;
using Google.Cloud.BigQuery.Storage.V1;
using Google.Cloud.BigQuery.V2;
using Grpc.Core;
using Grpc.Net.Client;
using Xunit;

namespace BigQueryLocal.Tests;

/// <summary>
/// Exercises the official `Google.Cloud.BigQuery.Storage.V1` Storage Read
/// client against the emulator. Uses an insecure gRPC channel since the
/// emulator listens plaintext HTTP/2.
/// </summary>
public class StorageReadTests
{
    [Fact]
    public async Task BigQueryReadClient_RoundTripsAvroRows()
    {
        var project = $"csharp-{Guid.NewGuid().ToString("N")[..8]}";

        // REST setup: create dataset + table, insert rows.
        var bq = new BigQueryClientBuilder
        {
            ProjectId = project,
            BaseUri = Emulator.HttpUrl,
        }.Build();
        var dataset = bq.CreateDataset("ds_storage");
        var schema = new TableSchemaBuilder
        {
            { "id", BigQueryDbType.Int64, BigQueryFieldMode.Required },
            { "name", BigQueryDbType.String },
        }.Build();
        var table = dataset.CreateTable("storage_target", schema);
        var rows = new[]
        {
            new BigQueryInsertRow { { "id", 1L }, { "name", "alice" } },
            new BigQueryInsertRow { { "id", 2L }, { "name", "bob" } },
        };
        table.InsertRows(rows);

        // gRPC Storage Read client pointed at the emulator's gRPC port
        // with insecure channel credentials (the emulator listens plaintext
        // HTTP/2). The builder rejects setting both `CallInvoker` and
        // credentials — let it construct the channel itself from the
        // endpoint + credentials.
        var readClient = await new BigQueryReadClientBuilder
        {
            Endpoint = Emulator.GrpcUrl,
            ChannelCredentials = ChannelCredentials.Insecure,
        }.BuildAsync();

        var session = await readClient.CreateReadSessionAsync(new CreateReadSessionRequest
        {
            Parent = $"projects/{project}",
            ReadSession = new ReadSession
            {
                Table = $"projects/{project}/datasets/ds_storage/tables/storage_target",
                DataFormat = DataFormat.Avro,
            },
        });

        Assert.NotEmpty(session.Streams);
        Assert.Contains("__root__", session.AvroSchema.Schema);
        Assert.Equal(2L, session.EstimatedRowCount);

        // Stream + count batches.
        var stream = readClient.ReadRows(new ReadRowsRequest
        {
            ReadStream = session.Streams[0].Name,
        });
        int batches = 0;
        await foreach (var resp in stream.GetResponseStream())
        {
            if (resp.AvroRows is not null && !resp.AvroRows.SerializedBinaryRows.IsEmpty)
            {
                batches++;
            }
        }
        Assert.True(batches >= 1, "expected at least one batch");
    }
}

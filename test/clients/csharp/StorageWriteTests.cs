using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Google.Cloud.BigQuery.Storage.V1;
using Google.Cloud.BigQuery.V2;
using Google.Protobuf;
using Google.Protobuf.Reflection;
using Grpc.Core;
using Xunit;

namespace BigQueryLocal.Tests;

/// <summary>
/// Exercises the official `Google.Cloud.BigQuery.Storage.V1` Storage Write
/// client against the emulator's `_default` stream. Builds a proto
/// descriptor matching the table schema at runtime and serializes rows
/// via `Google.Protobuf.WriteContext` so the test doesn't depend on a
/// precompiled .proto.
/// </summary>
public class StorageWriteTests
{
    [Fact]
    public async Task BigQueryWriteClient_AppendRows_DefaultStream()
    {
        var project = $"csharp-w-{Guid.NewGuid().ToString("N")[..8]}";

        // REST setup.
        var bq = new BigQueryClientBuilder
        {
            ProjectId = project,
            BaseUri = Emulator.HttpUrl,
        }.Build();
        var dataset = bq.CreateDataset("ds_write");
        var schema = new TableSchemaBuilder
        {
            { "id", BigQueryDbType.Int64, BigQueryFieldMode.Required },
            { "note", BigQueryDbType.String },
        }.Build();
        var table = dataset.CreateTable("write_target", schema);

        // Build a proto descriptor for the row.
        var descriptorProto = new DescriptorProto { Name = "Row" };
        descriptorProto.Field.Add(new FieldDescriptorProto
        {
            Name = "id",
            Number = 1,
            Type = FieldDescriptorProto.Types.Type.Int64,
            Label = FieldDescriptorProto.Types.Label.Optional,
        });
        descriptorProto.Field.Add(new FieldDescriptorProto
        {
            Name = "note",
            Number = 2,
            Type = FieldDescriptorProto.Types.Type.String,
            Label = FieldDescriptorProto.Types.Label.Optional,
        });

        // Build serialized rows by hand using the proto wire format —
        // simpler than building a runtime FileDescriptor + DynamicMessage
        // path in C#. Each field: tag = (number << 3) | wireType.
        // INT64 wire type = 0 (varint); STRING wire type = 2 (length-prefixed).
        static byte[] EncodeRow(long id, string note)
        {
            using var ms = new System.IO.MemoryStream();
            var output = new CodedOutputStream(ms);
            // Field 1 (id), varint.
            output.WriteTag(1, WireFormat.WireType.Varint);
            output.WriteInt64(id);
            // Field 2 (note), length-delimited string.
            output.WriteTag(2, WireFormat.WireType.LengthDelimited);
            output.WriteString(note);
            output.Flush();
            return ms.ToArray();
        }

        var writeClient = await new BigQueryWriteClientBuilder
        {
            Endpoint = Emulator.GrpcUrl,
            ChannelCredentials = ChannelCredentials.Insecure,
        }.BuildAsync();

        var defaultStream = $"projects/{project}/datasets/ds_write/tables/write_target/streams/_default";

        using var bidi = writeClient.AppendRows();
        var protoData = new AppendRowsRequest.Types.ProtoData
        {
            WriterSchema = new ProtoSchema { ProtoDescriptor = descriptorProto },
            Rows = new ProtoRows
            {
                SerializedRows =
                {
                    ByteString.CopyFrom(EncodeRow(1, "alpha")),
                    ByteString.CopyFrom(EncodeRow(2, "beta")),
                    ByteString.CopyFrom(EncodeRow(3, "gamma")),
                },
            },
        };
        await bidi.WriteAsync(new AppendRowsRequest
        {
            WriteStream = defaultStream,
            ProtoRows = protoData,
        });
        await bidi.WriteCompleteAsync();

        int responsesSeen = 0;
        await foreach (var response in bidi.GetResponseStream())
        {
            Assert.Equal(defaultStream, response.WriteStream);
            responsesSeen++;
        }
        Assert.Equal(1, responsesSeen);

        // Verify rows landed via REST.
        var rows = bq.ExecuteQuery(
            $"SELECT id, note FROM `{project}.ds_write.write_target` ORDER BY id",
            parameters: null);
        var seen = new List<(long id, string note)>();
        foreach (var row in rows)
        {
            seen.Add(((long)row["id"], (string)row["note"]));
        }
        Assert.Equal(
            new List<(long, string)>
            {
                (1, "alpha"),
                (2, "beta"),
                (3, "gamma"),
            },
            seen);
    }
}

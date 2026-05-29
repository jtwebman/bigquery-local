package local.bigquery;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.api.gax.core.NoCredentialsProvider;
import com.google.api.gax.grpc.GrpcTransportChannel;
import com.google.api.gax.rpc.FixedTransportChannelProvider;
import com.google.cloud.bigquery.BigQuery;
import com.google.cloud.bigquery.Field;
import com.google.cloud.bigquery.InsertAllRequest;
import com.google.cloud.bigquery.LegacySQLTypeName;
import com.google.cloud.bigquery.Schema;
import com.google.cloud.bigquery.StandardTableDefinition;
import com.google.cloud.bigquery.TableId;
import com.google.cloud.bigquery.TableInfo;
import com.google.cloud.bigquery.storage.v1.AppendRowsRequest;
import com.google.cloud.bigquery.storage.v1.AppendRowsResponse;
import com.google.cloud.bigquery.storage.v1.BigQueryReadClient;
import com.google.cloud.bigquery.storage.v1.BigQueryReadSettings;
import com.google.cloud.bigquery.storage.v1.CreateReadSessionRequest;
import com.google.cloud.bigquery.storage.v1.DataFormat;
import com.google.cloud.bigquery.storage.v1.ProtoRows;
import com.google.cloud.bigquery.storage.v1.ProtoSchema;
import com.google.cloud.bigquery.storage.v1.ReadRowsRequest;
import com.google.cloud.bigquery.storage.v1.ReadRowsResponse;
import com.google.cloud.bigquery.storage.v1.ReadSession;
import com.google.protobuf.ByteString;
import com.google.protobuf.DescriptorProtos;
import com.google.protobuf.DescriptorProtos.DescriptorProto;
import com.google.protobuf.DescriptorProtos.FieldDescriptorProto;
import com.google.protobuf.DescriptorProtos.FileDescriptorProto;
import com.google.protobuf.Descriptors.Descriptor;
import com.google.protobuf.Descriptors.FileDescriptor;
import com.google.protobuf.DynamicMessage;
import io.grpc.ManagedChannel;
import io.grpc.ManagedChannelBuilder;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Exercises the official Java Storage Read + Write clients against the
 * emulator. Uses an insecure gRPC channel so the TLS handshake doesn't fight
 * us (the emulator listens plaintext HTTP/2).
 */
public class StorageTest {
  private static String dataset() {
    return "ds_" + UUID.randomUUID().toString().substring(0, 8).replace('-', '_');
  }

  private static String tableName() {
    return "tbl_" + UUID.randomUUID().toString().substring(0, 8).replace('-', '_');
  }

  private static ManagedChannel insecureChannel() {
    String[] hp = Emu.grpcUrl().split(":");
    return ManagedChannelBuilder.forAddress(hp[0], Integer.parseInt(hp[1]))
        .usePlaintext()
        .build();
  }

  @Test
  void storageReadEndToEnd() throws Exception {
    // Set up a table with a few rows via the REST client.
    String project = "storage-test-" + UUID.randomUUID().toString().substring(0, 8);
    BigQuery bq = Emu.client(project);
    String ds = dataset();
    String tbl = tableName();
    bq.create(com.google.cloud.bigquery.DatasetInfo.newBuilder(ds).build());

    Schema schema =
        Schema.of(
            Field.newBuilder("id", LegacySQLTypeName.INTEGER)
                .setMode(Field.Mode.REQUIRED)
                .build(),
            Field.of("name", LegacySQLTypeName.STRING));
    bq.create(
        TableInfo.of(TableId.of(ds, tbl), StandardTableDefinition.of(schema)));

    Map<String, Object> r1 = new HashMap<>();
    r1.put("id", 1L);
    r1.put("name", "alice");
    Map<String, Object> r2 = new HashMap<>();
    r2.put("id", 2L);
    r2.put("name", "bob");
    bq.insertAll(
        InsertAllRequest.newBuilder(TableId.of(ds, tbl))
            .addRow(r1)
            .addRow(r2)
            .build());

    // Build a BigQueryReadClient with an insecure gRPC channel.
    ManagedChannel channel = insecureChannel();
    try {
      BigQueryReadSettings settings =
          BigQueryReadSettings.newBuilder()
              .setCredentialsProvider(NoCredentialsProvider.create())
              .setTransportChannelProvider(
                  FixedTransportChannelProvider.create(GrpcTransportChannel.create(channel)))
              .build();

      try (BigQueryReadClient client = BigQueryReadClient.create(settings)) {
        String tableRef =
            String.format("projects/%s/datasets/%s/tables/%s", project, ds, tbl);
        ReadSession session =
            client.createReadSession(
                CreateReadSessionRequest.newBuilder()
                    .setParent("projects/" + project)
                    .setReadSession(
                        ReadSession.newBuilder()
                            .setTable(tableRef)
                            .setDataFormat(DataFormat.AVRO)
                            .build())
                    .build());

        assertTrue(session.getStreamsCount() >= 1, "at least one stream");
        assertTrue(session.getAvroSchema().getSchema().contains("__root__"));
        assertEquals(2, session.getEstimatedRowCount());

        int batchesSeen = 0;
        for (ReadRowsResponse response :
            client.readRowsCallable().call(
                ReadRowsRequest.newBuilder()
                    .setReadStream(session.getStreams(0).getName())
                    .build())) {
          assertNotEquals(0, response.getAvroRows().getSerializedBinaryRows().size());
          batchesSeen++;
        }
        assertTrue(batchesSeen >= 1, "received at least one batch");
      }
    } finally {
      channel.shutdownNow();
    }
  }

  @Test
  void storageWriteAppendRowsOnDefaultStream() throws Exception {
    String project = "storage-test-" + UUID.randomUUID().toString().substring(0, 8);
    BigQuery bq = Emu.client(project);
    String ds = dataset();
    String tbl = tableName();
    bq.create(com.google.cloud.bigquery.DatasetInfo.newBuilder(ds).build());
    Schema schema =
        Schema.of(
            Field.newBuilder("id", LegacySQLTypeName.INTEGER)
                .setMode(Field.Mode.REQUIRED)
                .build(),
            Field.of("note", LegacySQLTypeName.STRING));
    bq.create(TableInfo.of(TableId.of(ds, tbl), StandardTableDefinition.of(schema)));

    // Build a proto descriptor matching the schema.
    DescriptorProto descriptorProto =
        DescriptorProto.newBuilder()
            .setName("Row")
            .addField(
                FieldDescriptorProto.newBuilder()
                    .setName("id")
                    .setNumber(1)
                    .setType(FieldDescriptorProto.Type.TYPE_INT64)
                    .setLabel(FieldDescriptorProto.Label.LABEL_OPTIONAL)
                    .build())
            .addField(
                FieldDescriptorProto.newBuilder()
                    .setName("note")
                    .setNumber(2)
                    .setType(FieldDescriptorProto.Type.TYPE_STRING)
                    .setLabel(FieldDescriptorProto.Label.LABEL_OPTIONAL)
                    .build())
            .build();
    FileDescriptorProto fileProto =
        FileDescriptorProto.newBuilder().setName("row.proto").addMessageType(descriptorProto).build();
    FileDescriptor file = FileDescriptor.buildFrom(fileProto, new FileDescriptor[0]);
    Descriptor descriptor = file.findMessageTypeByName("Row");

    DynamicMessage row1 =
        DynamicMessage.newBuilder(descriptor)
            .setField(descriptor.findFieldByName("id"), 1L)
            .setField(descriptor.findFieldByName("note"), "alpha")
            .build();
    DynamicMessage row2 =
        DynamicMessage.newBuilder(descriptor)
            .setField(descriptor.findFieldByName("id"), 2L)
            .setField(descriptor.findFieldByName("note"), "beta")
            .build();

    // Open an AppendRows bidi via the low-level gRPC channel.
    ManagedChannel channel = insecureChannel();
    try {
      com.google.cloud.bigquery.storage.v1.BigQueryWriteSettings settings =
          com.google.cloud.bigquery.storage.v1.BigQueryWriteSettings.newBuilder()
              .setCredentialsProvider(NoCredentialsProvider.create())
              .setTransportChannelProvider(
                  FixedTransportChannelProvider.create(GrpcTransportChannel.create(channel)))
              .build();

      try (com.google.cloud.bigquery.storage.v1.BigQueryWriteClient writeClient =
          com.google.cloud.bigquery.storage.v1.BigQueryWriteClient.create(settings)) {
        String defaultStream =
            String.format(
                "projects/%s/datasets/%s/tables/%s/streams/_default", project, ds, tbl);

        // Use the bidi callable to send one request with the writer
        // schema + serialized rows.
        com.google.api.gax.rpc.BidiStream<AppendRowsRequest, AppendRowsResponse> stream =
            writeClient.appendRowsCallable().call();
        stream.send(
            AppendRowsRequest.newBuilder()
                .setWriteStream(defaultStream)
                .setProtoRows(
                    AppendRowsRequest.ProtoData.newBuilder()
                        .setWriterSchema(
                            ProtoSchema.newBuilder().setProtoDescriptor(descriptorProto).build())
                        .setRows(
                            ProtoRows.newBuilder()
                                .addSerializedRows(row1.toByteString())
                                .addSerializedRows(row2.toByteString())
                                .build())
                        .build())
                .build());
        stream.closeSend();

        AppendRowsResponse response = stream.iterator().next();
        assertEquals(defaultStream, response.getWriteStream());
      }
    } finally {
      channel.shutdownNow();
    }

    // Verify rows landed by reading them back through the REST API.
    com.google.cloud.bigquery.TableResult result =
        bq.query(
            com.google.cloud.bigquery.QueryJobConfiguration.newBuilder(
                    "SELECT id, note FROM `" + project + "." + ds + "." + tbl + "` ORDER BY id")
                .build());
    long count = result.getTotalRows();
    assertEquals(2L, count);
  }
}

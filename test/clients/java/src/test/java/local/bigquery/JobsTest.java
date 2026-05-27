package local.bigquery;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.cloud.bigquery.BigQuery;
import com.google.cloud.bigquery.CopyJobConfiguration;
import com.google.cloud.bigquery.CsvOptions;
import com.google.cloud.bigquery.DatasetInfo;
import com.google.cloud.bigquery.ExtractJobConfiguration;
import com.google.cloud.bigquery.Field;
import com.google.cloud.bigquery.FieldValueList;
import com.google.cloud.bigquery.FormatOptions;
import com.google.cloud.bigquery.InsertAllRequest;
import com.google.cloud.bigquery.JobInfo;
import com.google.cloud.bigquery.LoadJobConfiguration;
import com.google.cloud.bigquery.Schema;
import com.google.cloud.bigquery.StandardSQLTypeName;
import com.google.cloud.bigquery.StandardTableDefinition;
import com.google.cloud.bigquery.TableId;
import com.google.cloud.bigquery.TableInfo;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Load / extract / copy jobs through the GCS stub — mirrors jobs_test.go. */
class JobsTest {
  private static String bucket(String prefix) {
    return prefix + "-" + UUID.randomUUID().toString().substring(0, 8);
  }

  private static void createTable(BigQuery bq, String table, Field... fields) {
    bq.create(TableInfo.of(TableId.of("ds", table), StandardTableDefinition.of(Schema.of(fields))));
  }

  @Test
  void loadCsvFromGcsWithAutodetect() throws Exception {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    bq.create(DatasetInfo.newBuilder("ds").build());
    String b = bucket("java-load");
    Emu.gcsPut(
        b,
        "orders.csv",
        ("order_id,customer,amount,delivered\n1,Alice,9.99,true\n2,Bob,12.50,false\n3,Charlie,7.00,true\n")
            .getBytes(StandardCharsets.UTF_8),
        "text/csv");

    bq.create(
            JobInfo.of(
                LoadJobConfiguration.newBuilder(
                        TableId.of("ds", "orders"), "gs://" + b + "/orders.csv", FormatOptions.csv())
                    .setAutodetect(true)
                    .build()))
        .waitFor();

    List<FieldValueList> rows = Emu.rows(bq, "SELECT count(*) AS n FROM `ds.orders`");
    assertEquals(3L, rows.get(0).get("n").getLongValue());
  }

  @Test
  void loadCsvWithExplicitSchema() throws Exception {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    bq.create(DatasetInfo.newBuilder("ds").build());
    String b = bucket("java-load");
    Emu.gcsPut(b, "notes.csv", "id,note\n1,first\n2,second\n".getBytes(StandardCharsets.UTF_8), "text/csv");

    Schema schema =
        Schema.of(
            Field.newBuilder("id", StandardSQLTypeName.STRING).setMode(Field.Mode.REQUIRED).build(),
            Field.of("note", StandardSQLTypeName.STRING));
    bq.create(
            JobInfo.of(
                LoadJobConfiguration.newBuilder(
                        TableId.of("ds", "notes"),
                        List.of("gs://" + b + "/notes.csv"),
                        CsvOptions.newBuilder().setSkipLeadingRows(1L).build())
                    .setSchema(schema)
                    .build()))
        .waitFor();

    List<FieldValueList> rows = Emu.rows(bq, "SELECT id, note FROM `ds.notes` ORDER BY id");
    assertEquals("1", rows.get(0).get("id").getStringValue());
    assertEquals("first", rows.get(0).get("note").getStringValue());
    assertEquals("2", rows.get(1).get("id").getStringValue());
    assertEquals("second", rows.get(1).get("note").getStringValue());
  }

  @Test
  void loadNdjsonFromGcsWithAutodetect() throws Exception {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    bq.create(DatasetInfo.newBuilder("ds").build());
    String b = bucket("java-load");
    Emu.gcsPut(
        b,
        "events.ndjson",
        "{\"id\":1,\"kind\":\"click\"}\n{\"id\":2,\"kind\":\"view\"}\n".getBytes(StandardCharsets.UTF_8),
        "application/x-ndjson");

    bq.create(
            JobInfo.of(
                LoadJobConfiguration.newBuilder(
                        TableId.of("ds", "events"),
                        "gs://" + b + "/events.ndjson",
                        FormatOptions.json())
                    .setAutodetect(true)
                    .build()))
        .waitFor();

    List<FieldValueList> rows = Emu.rows(bq, "SELECT id, kind FROM `ds.events` ORDER BY id");
    assertEquals(1L, rows.get(0).get("id").getLongValue());
    assertEquals("click", rows.get(0).get("kind").getStringValue());
    assertEquals(2L, rows.get(1).get("id").getLongValue());
    assertEquals("view", rows.get(1).get("kind").getStringValue());
  }

  @Test
  void loadParquetFromGcsRoundTrip() throws Exception {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    bq.create(DatasetInfo.newBuilder("ds").build());
    createTable(
        bq,
        "fixture",
        Field.of("id", StandardSQLTypeName.INT64),
        Field.of("label", StandardSQLTypeName.STRING));
    bq.insertAll(
        InsertAllRequest.newBuilder(TableId.of("ds", "fixture"))
            .addRow(Map.of("id", 1, "label", "alpha"))
            .addRow(Map.of("id", 2, "label", "beta"))
            .build());

    String b = bucket("java-load");
    bq.create(
            JobInfo.of(
                ExtractJobConfiguration.newBuilder(
                        TableId.of("ds", "fixture"), "gs://" + b + "/fixture.parquet")
                    .setFormat("PARQUET")
                    .build()))
        .waitFor();
    bq.create(
            JobInfo.of(
                LoadJobConfiguration.newBuilder(
                        TableId.of("ds", "from_parquet"),
                        "gs://" + b + "/fixture.parquet",
                        FormatOptions.parquet())
                    .setAutodetect(true)
                    .build()))
        .waitFor();

    List<FieldValueList> rows = Emu.rows(bq, "SELECT id, label FROM `ds.from_parquet` ORDER BY id");
    assertEquals(1L, rows.get(0).get("id").getLongValue());
    assertEquals("alpha", rows.get(0).get("label").getStringValue());
    assertEquals(2L, rows.get(1).get("id").getLongValue());
    assertEquals("beta", rows.get(1).get("label").getStringValue());
  }

  @Test
  void extractCsvWritesHeaderAndRows() throws Exception {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    bq.create(DatasetInfo.newBuilder("ds").build());
    createTable(
        bq,
        "users",
        Field.of("id", StandardSQLTypeName.INT64),
        Field.of("name", StandardSQLTypeName.STRING));
    bq.insertAll(
        InsertAllRequest.newBuilder(TableId.of("ds", "users"))
            .addRow(Map.of("id", 1, "name", "Alice"))
            .addRow(Map.of("id", 2, "name", "Bob"))
            .build());

    String b = bucket("java-extract");
    bq.create(
            JobInfo.of(
                ExtractJobConfiguration.newBuilder(
                        TableId.of("ds", "users"), "gs://" + b + "/users.csv")
                    .setFormat("CSV")
                    .build()))
        .waitFor();

    byte[] out = Emu.gcsGet(b, "users.csv");
    assertNotNull(out, "extracted object missing");
    List<String> lines = new ArrayList<>();
    for (String line : new String(out, StandardCharsets.UTF_8).split("\n")) {
      if (!line.isEmpty()) {
        lines.add(line);
      }
    }
    assertEquals("id,name", lines.get(0));
    List<String> rest = lines.subList(1, lines.size());
    rest.sort(null);
    assertEquals("1,Alice", rest.get(0));
    assertEquals("2,Bob", rest.get(1));
  }

  @Test
  void extractNdjsonRoundTrip() throws Exception {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    bq.create(DatasetInfo.newBuilder("ds").build());
    createTable(
        bq,
        "events",
        Field.of("id", StandardSQLTypeName.INT64),
        Field.of("kind", StandardSQLTypeName.STRING));
    bq.insertAll(
        InsertAllRequest.newBuilder(TableId.of("ds", "events"))
            .addRow(Map.of("id", 7, "kind", "click"))
            .build());

    String b = bucket("java-extract");
    bq.create(
            JobInfo.of(
                ExtractJobConfiguration.newBuilder(
                        TableId.of("ds", "events"), "gs://" + b + "/events.ndjson")
                    .setFormat("NEWLINE_DELIMITED_JSON")
                    .build()))
        .waitFor();

    byte[] out = Emu.gcsGet(b, "events.ndjson");
    assertNotNull(out, "extract output missing");
    List<String> lines =
        Arrays.stream(new String(out, StandardCharsets.UTF_8).split("\n"))
            .filter(s -> !s.isEmpty())
            .toList();
    assertEquals(1, lines.size());
    // BQ NDJSON extract emits INT64 as a string.
    assertTrue(lines.get(0).contains("\"id\":\"7\""), () -> "line: " + lines.get(0));
    assertTrue(lines.get(0).contains("\"kind\":\"click\""), () -> "line: " + lines.get(0));
  }

  @Test
  void copyTableRoundTrip() throws Exception {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    bq.create(DatasetInfo.newBuilder("ds").build());
    createTable(
        bq,
        "source",
        Field.of("id", StandardSQLTypeName.INT64),
        Field.of("label", StandardSQLTypeName.STRING));
    bq.insertAll(
        InsertAllRequest.newBuilder(TableId.of("ds", "source"))
            .addRow(Map.of("id", 1, "label", "one"))
            .addRow(Map.of("id", 2, "label", "two"))
            .build());

    bq.create(
            JobInfo.of(
                CopyJobConfiguration.of(TableId.of("ds", "dest"), TableId.of("ds", "source"))))
        .waitFor();

    List<FieldValueList> rows = Emu.rows(bq, "SELECT id, label FROM `ds.dest` ORDER BY id");
    assertEquals("one", rows.get(0).get("label").getStringValue());
    assertEquals("two", rows.get(1).get("label").getStringValue());
  }

  @Test
  void copyWithWriteTruncateOverwritesDestination() throws Exception {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    bq.create(DatasetInfo.newBuilder("ds").build());
    createTable(bq, "src", Field.of("v", StandardSQLTypeName.INT64));
    createTable(bq, "dst", Field.of("v", StandardSQLTypeName.INT64));
    bq.insertAll(
        InsertAllRequest.newBuilder(TableId.of("ds", "src"))
            .addRow(Map.of("v", 1))
            .addRow(Map.of("v", 2))
            .addRow(Map.of("v", 3))
            .build());
    bq.insertAll(
        InsertAllRequest.newBuilder(TableId.of("ds", "dst")).addRow(Map.of("v", 999)).build());

    bq.create(
            JobInfo.of(
                CopyJobConfiguration.newBuilder(TableId.of("ds", "dst"), TableId.of("ds", "src"))
                    .setWriteDisposition(JobInfo.WriteDisposition.WRITE_TRUNCATE)
                    .build()))
        .waitFor();

    List<FieldValueList> rows = Emu.rows(bq, "SELECT v FROM `ds.dst` ORDER BY v");
    assertEquals(3, rows.size());
    assertEquals(1L, rows.get(0).get("v").getLongValue());
    assertEquals(3L, rows.get(2).get("v").getLongValue());
  }
}

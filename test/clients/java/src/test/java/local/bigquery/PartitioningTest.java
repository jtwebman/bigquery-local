package local.bigquery;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.cloud.bigquery.BigQuery;
import com.google.cloud.bigquery.Clustering;
import com.google.cloud.bigquery.DatasetInfo;
import com.google.cloud.bigquery.Field;
import com.google.cloud.bigquery.FieldValueList;
import com.google.cloud.bigquery.InsertAllRequest;
import com.google.cloud.bigquery.Schema;
import com.google.cloud.bigquery.StandardSQLTypeName;
import com.google.cloud.bigquery.StandardTableDefinition;
import com.google.cloud.bigquery.Table;
import com.google.cloud.bigquery.TableId;
import com.google.cloud.bigquery.TableInfo;
import com.google.cloud.bigquery.TimePartitioning;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Partitioning + clustering — mirrors partitioning_test.go. */
class PartitioningTest {
  @Test
  void ingestionTimePartitioning() throws Exception {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    bq.create(DatasetInfo.newBuilder("ds").build());
    TableId tableId = TableId.of("ds", "events");
    bq.create(
        TableInfo.of(
            tableId,
            StandardTableDefinition.newBuilder()
                .setSchema(Schema.of(Field.of("kind", StandardSQLTypeName.STRING)))
                .setTimePartitioning(TimePartitioning.of(TimePartitioning.Type.DAY))
                .build()));
    bq.insertAll(
        InsertAllRequest.newBuilder(tableId)
            .addRow(Map.of("kind", "click"))
            .addRow(Map.of("kind", "view"))
            .build());

    List<FieldValueList> rows =
        Emu.rows(
            bq,
            "SELECT kind, _PARTITIONTIME IS NOT NULL AS has_ts FROM `ds.events` ORDER BY kind");
    for (FieldValueList r : rows) {
      assertTrue(r.get("has_ts").getBooleanValue(), () -> "_PARTITIONTIME missing");
    }
  }

  @Test
  void partitionDateFilterToday() throws Exception {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    bq.create(DatasetInfo.newBuilder("ds").build());
    TableId tableId = TableId.of("ds", "events");
    bq.create(
        TableInfo.of(
            tableId,
            StandardTableDefinition.newBuilder()
                .setSchema(Schema.of(Field.of("kind", StandardSQLTypeName.STRING)))
                .setTimePartitioning(TimePartitioning.of(TimePartitioning.Type.DAY))
                .build()));
    bq.insertAll(
        InsertAllRequest.newBuilder(tableId)
            .addRow(Map.of("kind", "a"))
            .addRow(Map.of("kind", "b"))
            .build());

    List<FieldValueList> rows =
        Emu.rows(
            bq,
            "SELECT count(*) AS n FROM `ds.events` WHERE _PARTITIONDATE = CURRENT_DATE()");
    assertEquals(2L, rows.get(0).get("n").getLongValue());
  }

  @Test
  void columnPartitioningRoundTrip() {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    bq.create(DatasetInfo.newBuilder("ds").build());
    TableId tableId = TableId.of("ds", "orders");
    bq.create(
        TableInfo.of(
            tableId,
            StandardTableDefinition.newBuilder()
                .setSchema(
                    Schema.of(
                        Field.of("id", StandardSQLTypeName.INT64),
                        Field.of("order_date", StandardSQLTypeName.DATE),
                        Field.of("amount", StandardSQLTypeName.FLOAT64)))
                .setTimePartitioning(
                    TimePartitioning.newBuilder(TimePartitioning.Type.DAY)
                        .setField("order_date")
                        .build())
                .build()));

    StandardTableDefinition def = bq.getTable(tableId).getDefinition();
    assertNotNull(def.getTimePartitioning());
    assertEquals(TimePartitioning.Type.DAY, def.getTimePartitioning().getType());
    assertEquals("order_date", def.getTimePartitioning().getField());
  }

  @Test
  void clusteringMetadataRoundTrip() {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    bq.create(DatasetInfo.newBuilder("ds").build());
    TableId tableId = TableId.of("ds", "sessions");
    bq.create(
        TableInfo.of(
            tableId,
            StandardTableDefinition.newBuilder()
                .setSchema(
                    Schema.of(
                        Field.of("user_id", StandardSQLTypeName.STRING),
                        Field.of("session_id", StandardSQLTypeName.STRING),
                        Field.of("started_at", StandardSQLTypeName.TIMESTAMP)))
                .setClustering(
                    Clustering.newBuilder().setFields(List.of("user_id", "session_id")).build())
                .build()));

    StandardTableDefinition def = bq.getTable(tableId).getDefinition();
    assertNotNull(def.getClustering());
    assertEquals(List.of("user_id", "session_id"), def.getClustering().getFields());
  }

  @Test
  void isPartitioningColumnViaInformationSchema() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    bq.create(DatasetInfo.newBuilder("ds").build());
    bq.create(
        TableInfo.of(
            TableId.of("ds", "orders"),
            StandardTableDefinition.newBuilder()
                .setSchema(
                    Schema.of(
                        Field.of("id", StandardSQLTypeName.INT64),
                        Field.of("order_date", StandardSQLTypeName.DATE)))
                .setTimePartitioning(
                    TimePartitioning.newBuilder(TimePartitioning.Type.DAY)
                        .setField("order_date")
                        .build())
                .build()));

    List<FieldValueList> rows =
        Emu.rows(
            bq,
            "SELECT column_name, is_partitioning_column FROM `"
                + project
                + ".ds`.INFORMATION_SCHEMA.COLUMNS WHERE table_name = 'orders' ORDER BY ordinal_position");
    Map<String, String> byName = new HashMap<>();
    for (FieldValueList r : rows) {
      byName.put(r.get("column_name").getStringValue(), r.get("is_partitioning_column").getStringValue());
    }
    assertEquals("NO", byName.get("id"));
    assertEquals("YES", byName.get("order_date"));
  }
}

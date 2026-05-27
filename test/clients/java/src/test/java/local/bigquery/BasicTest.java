package local.bigquery;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.cloud.bigquery.BigQuery;
import com.google.cloud.bigquery.BigQueryException;
import com.google.cloud.bigquery.Dataset;
import com.google.cloud.bigquery.DatasetId;
import com.google.cloud.bigquery.DatasetInfo;
import com.google.cloud.bigquery.Field;
import com.google.cloud.bigquery.FieldValueList;
import com.google.cloud.bigquery.InsertAllRequest;
import com.google.cloud.bigquery.InsertAllResponse;
import com.google.cloud.bigquery.QueryJobConfiguration;
import com.google.cloud.bigquery.Schema;
import com.google.cloud.bigquery.StandardSQLTypeName;
import com.google.cloud.bigquery.StandardTableDefinition;
import com.google.cloud.bigquery.TableId;
import com.google.cloud.bigquery.TableInfo;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Connectivity, dataset/table CRUD, and basic query — mirrors basic_test.go. */
class BasicTest {
  @Test
  void listProjects() throws Exception {
    assertEquals(200, Emu.httpGetStatus("/projects"));
  }

  @Test
  void serviceAccount() throws Exception {
    assertEquals(200, Emu.httpGetStatus("/projects/" + Emu.uniqueProject() + "/serviceAccount"));
  }

  @Test
  void datasetCrud() {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    Dataset created =
        bq.create(
            DatasetInfo.newBuilder("ds")
                .setDescription("java-test")
                .setLabels(Map.of("team", "java", "env", "test"))
                .build());
    assertEquals("java-test", created.getDescription());
    assertEquals("java", created.getLabels().get("team"));

    Dataset got = bq.getDataset("ds");
    assertNotNull(got);
    assertEquals("java-test", got.getDescription());

    List<String> names = new ArrayList<>();
    bq.listDatasets(project).iterateAll().forEach(d -> names.add(d.getDatasetId().getDataset()));
    assertEquals(List.of("ds"), names);

    assertTrue(
        bq.delete(DatasetId.of(project, "ds"), BigQuery.DatasetDeleteOption.deleteContents()));
  }

  @Test
  void tableCreateAndInsert() throws Exception {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    bq.create(DatasetInfo.newBuilder("ds").build());

    TableId tableId = TableId.of("ds", "users");
    Schema schema =
        Schema.of(
            Field.newBuilder("id", StandardSQLTypeName.INT64).setMode(Field.Mode.REQUIRED).build(),
            Field.of("name", StandardSQLTypeName.STRING),
            Field.of("active", StandardSQLTypeName.BOOL));
    bq.create(TableInfo.of(tableId, StandardTableDefinition.of(schema)));

    InsertAllResponse resp =
        bq.insertAll(
            InsertAllRequest.newBuilder(tableId)
                .addRow(Map.of("id", 1, "name", "Alice", "active", true))
                .addRow(Map.of("id", 2, "name", "Bob", "active", false))
                .build());
    assertFalse(resp.hasErrors(), () -> "insert errors: " + resp.getInsertErrors());

    List<FieldValueList> rows =
        Emu.rows(bq, "SELECT id, name, active FROM `ds.users` ORDER BY id");
    assertEquals(2, rows.size());
    assertEquals(1L, rows.get(0).get("id").getLongValue());
    assertEquals("Alice", rows.get(0).get("name").getStringValue());
    assertTrue(rows.get(0).get("active").getBooleanValue());
    assertEquals("Bob", rows.get(1).get("name").getStringValue());
    assertFalse(rows.get(1).get("active").getBooleanValue());
  }

  @Test
  void simpleQuery() throws Exception {
    List<FieldValueList> rows =
        Emu.rows(Emu.client(Emu.uniqueProject()), "SELECT 1 AS one, 'hi' AS greeting");
    assertEquals(1L, rows.get(0).get("one").getLongValue());
    assertEquals("hi", rows.get(0).get("greeting").getStringValue());
  }

  @Test
  void queryAgainstMissingTableErrors() {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    bq.create(DatasetInfo.newBuilder("ds").build());
    BigQueryException ex =
        assertThrows(
            BigQueryException.class,
            () ->
                bq.query(
                    QueryJobConfiguration.newBuilder("SELECT * FROM `ds.nope`")
                        .setUseLegacySql(false)
                        .build()));
    assertEquals(400, ex.getCode());
  }
}

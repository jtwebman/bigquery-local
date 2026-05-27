package local.bigquery;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.cloud.bigquery.BigQuery;
import com.google.cloud.bigquery.DatasetInfo;
import com.google.cloud.bigquery.Field;
import com.google.cloud.bigquery.FieldValueList;
import com.google.cloud.bigquery.Schema;
import com.google.cloud.bigquery.StandardSQLTypeName;
import com.google.cloud.bigquery.StandardTableDefinition;
import com.google.cloud.bigquery.TableId;
import com.google.cloud.bigquery.TableInfo;
import java.util.List;
import org.junit.jupiter.api.Test;

/** INFORMATION_SCHEMA introspection — mirrors info_schema_test.go. */
class InfoSchemaTest {
  private static void seed(BigQuery bq) {
    bq.create(DatasetInfo.newBuilder("ds").build());
    bq.create(
        TableInfo.of(
            TableId.of("ds", "users"),
            StandardTableDefinition.of(
                Schema.of(
                    Field.newBuilder("id", StandardSQLTypeName.INT64)
                        .setMode(Field.Mode.REQUIRED)
                        .build(),
                    Field.of("name", StandardSQLTypeName.STRING),
                    Field.newBuilder("tags", StandardSQLTypeName.STRING)
                        .setMode(Field.Mode.REPEATED)
                        .build()))));
    bq.create(
        TableInfo.of(
            TableId.of("ds", "orders"),
            StandardTableDefinition.of(
                Schema.of(
                    Field.of("order_id", StandardSQLTypeName.STRING),
                    Field.of("amount", StandardSQLTypeName.FLOAT64)))));
  }

  @Test
  void schemataListsDataset() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    seed(bq);
    List<FieldValueList> rows =
        Emu.rows(
            bq,
            "SELECT catalog_name, schema_name, location FROM `region-us`.INFORMATION_SCHEMA.SCHEMATA");
    assertEquals(1, rows.size());
    assertEquals(project, rows.get(0).get("catalog_name").getStringValue());
    assertEquals("ds", rows.get(0).get("schema_name").getStringValue());
  }

  @Test
  void tablesDatasetScoped() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    seed(bq);
    List<FieldValueList> rows =
        Emu.rows(
            bq,
            "SELECT table_name, table_type FROM `"
                + project
                + ".ds`.INFORMATION_SCHEMA.TABLES ORDER BY table_name");
    assertEquals("orders", rows.get(0).get("table_name").getStringValue());
    assertEquals("BASE TABLE", rows.get(0).get("table_type").getStringValue());
    assertEquals("users", rows.get(1).get("table_name").getStringValue());
    assertEquals("BASE TABLE", rows.get(1).get("table_type").getStringValue());
  }

  @Test
  void columnsStructAndRepeated() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    seed(bq);
    List<FieldValueList> rows =
        Emu.rows(
            bq,
            "SELECT column_name, data_type, is_nullable FROM `"
                + project
                + ".ds`.INFORMATION_SCHEMA.COLUMNS WHERE table_name = 'users' ORDER BY ordinal_position");
    String[][] want = {
      {"id", "INT64", "NO"},
      {"name", "STRING", "YES"},
      {"tags", "ARRAY<STRING>", "YES"},
    };
    for (int i = 0; i < want.length; i++) {
      assertEquals(want[i][0], rows.get(i).get("column_name").getStringValue());
      assertEquals(want[i][1], rows.get(i).get("data_type").getStringValue());
      assertEquals(want[i][2], rows.get(i).get("is_nullable").getStringValue());
    }
  }

  @Test
  void views() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    seed(bq);
    Emu.rows(
        bq,
        "CREATE VIEW `"
            + project
            + ".ds.recent_users` AS SELECT id, name FROM `"
            + project
            + ".ds.users`");
    List<FieldValueList> rows =
        Emu.rows(
            bq,
            "SELECT table_name, use_standard_sql FROM `"
                + project
                + ".ds`.INFORMATION_SCHEMA.VIEWS ORDER BY table_name");
    assertEquals("recent_users", rows.get(0).get("table_name").getStringValue());
    assertEquals("YES", rows.get(0).get("use_standard_sql").getStringValue());
  }

  @Test
  void routinesAfterCreateFunction() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    seed(bq);
    Emu.rows(
        bq, "CREATE FUNCTION `" + project + ".ds.double_amount`(x INT64) RETURNS INT64 AS (x * 2)");
    List<FieldValueList> rows =
        Emu.rows(
            bq,
            "SELECT routine_name, routine_type, data_type FROM `"
                + project
                + ".ds`.INFORMATION_SCHEMA.ROUTINES");
    assertEquals(1, rows.size());
    assertEquals("double_amount", rows.get(0).get("routine_name").getStringValue());
    assertEquals("FUNCTION", rows.get(0).get("routine_type").getStringValue());
    assertEquals("INT64", rows.get(0).get("data_type").getStringValue());
  }

  @Test
  void parameters() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    seed(bq);
    Emu.rows(
        bq,
        "CREATE FUNCTION `" + project + ".ds.add_two`(a INT64, b INT64) RETURNS INT64 AS (a + b)");
    List<FieldValueList> rows =
        Emu.rows(
            bq,
            "SELECT parameter_name, parameter_mode, data_type FROM `"
                + project
                + ".ds`.INFORMATION_SCHEMA.PARAMETERS WHERE specific_name = 'add_two' ORDER BY ordinal_position");
    String[][] want = {
      {"a", "IN", "INT64"},
      {"b", "IN", "INT64"},
    };
    for (int i = 0; i < want.length; i++) {
      assertEquals(want[i][0], rows.get(i).get("parameter_name").getStringValue());
      assertEquals(want[i][1], rows.get(i).get("parameter_mode").getStringValue());
      assertEquals(want[i][2], rows.get(i).get("data_type").getStringValue());
    }
  }

  @Test
  void jobsAfterQuery() throws Exception {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    seed(bq);
    for (int i = 0; i < 3; i++) {
      Emu.rows(bq, "SELECT 1");
    }
    List<FieldValueList> rows =
        Emu.rows(
            bq,
            "SELECT COUNT(*) AS n FROM `region-us`.INFORMATION_SCHEMA.JOBS WHERE state = 'DONE'");
    assertTrue(rows.get(0).get("n").getLongValue() >= 3);
  }
}

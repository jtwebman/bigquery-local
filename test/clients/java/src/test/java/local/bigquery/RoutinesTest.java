package local.bigquery;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.google.cloud.bigquery.BigQuery;
import com.google.cloud.bigquery.DatasetId;
import com.google.cloud.bigquery.DatasetInfo;
import com.google.cloud.bigquery.Field;
import com.google.cloud.bigquery.FieldValueList;
import com.google.cloud.bigquery.InsertAllRequest;
import com.google.cloud.bigquery.Routine;
import com.google.cloud.bigquery.RoutineId;
import com.google.cloud.bigquery.Schema;
import com.google.cloud.bigquery.StandardSQLTypeName;
import com.google.cloud.bigquery.StandardTableDefinition;
import com.google.cloud.bigquery.TableId;
import com.google.cloud.bigquery.TableInfo;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** SQL UDFs, procedures, views, materialized views — mirrors routines_test.go. */
class RoutinesTest {
  @Test
  void sqlUdfRoundTrip() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    bq.create(DatasetInfo.newBuilder("ds").build());
    Emu.rows(bq, "CREATE FUNCTION `" + project + ".ds.double`(x INT64) RETURNS INT64 AS (x * 2)");
    List<FieldValueList> rows = Emu.rows(bq, "SELECT `" + project + ".ds.double`(21) AS n");
    assertEquals(42L, rows.get(0).get("n").getLongValue());
  }

  @Test
  void procedureWithInParamInInsertBody() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    bq.create(DatasetInfo.newBuilder("ds").build());
    bq.create(
        TableInfo.of(
            TableId.of("ds", "audit"),
            StandardTableDefinition.of(
                Schema.of(
                    Field.of("name", StandardSQLTypeName.STRING),
                    Field.of("ts", StandardSQLTypeName.TIMESTAMP)))));
    Emu.rows(
        bq,
        "CREATE PROCEDURE `"
            + project
            + ".ds.record_visit`(IN name STRING) BEGIN "
            + "INSERT INTO `"
            + project
            + ".ds.audit` (name, ts) VALUES (name, CURRENT_TIMESTAMP()); END;");
    for (String n : List.of("alice", "bob")) {
      Emu.rows(bq, "CALL `" + project + ".ds.record_visit`('" + n + "')");
    }
    List<FieldValueList> rows =
        Emu.rows(bq, "SELECT name FROM `" + project + ".ds.audit` ORDER BY name");
    assertEquals(2, rows.size());
    assertEquals("alice", rows.get(0).get("name").getStringValue());
    assertEquals("bob", rows.get(1).get("name").getStringValue());
  }

  @Test
  void procedureReturningSelectSurfacesRows() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    bq.create(DatasetInfo.newBuilder("ds").build());
    Emu.rows(
        bq,
        "CREATE PROCEDURE `"
            + project
            + ".ds.greet`(IN who STRING) BEGIN SELECT CONCAT('hi ', who) AS message; END;");
    List<FieldValueList> rows = Emu.rows(bq, "CALL `" + project + ".ds.greet`('alice')");
    assertEquals("hi alice", rows.get(0).get("message").getStringValue());
  }

  @Test
  void viewLifecycle() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    bq.create(DatasetInfo.newBuilder("ds").build());
    TableId orders = TableId.of("ds", "orders");
    bq.create(
        TableInfo.of(
            orders,
            StandardTableDefinition.of(
                Schema.of(
                    Field.of("region", StandardSQLTypeName.STRING),
                    Field.of("amount", StandardSQLTypeName.INT64)))));
    bq.insertAll(
        InsertAllRequest.newBuilder(orders)
            .addRow(Map.of("region", "east", "amount", 10))
            .addRow(Map.of("region", "east", "amount", 20))
            .addRow(Map.of("region", "west", "amount", 30))
            .build());
    Emu.rows(
        bq,
        "CREATE VIEW `"
            + project
            + ".ds.east_orders` AS SELECT region, amount FROM `"
            + project
            + ".ds.orders` WHERE region = 'east'");
    List<FieldValueList> rows =
        Emu.rows(bq, "SELECT count(*) AS n FROM `" + project + ".ds.east_orders`");
    assertEquals(2L, rows.get(0).get("n").getLongValue());
  }

  @Test
  void materializedViewCreateAndRefresh() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    bq.create(DatasetInfo.newBuilder("ds").build());
    TableId orders = TableId.of("ds", "orders");
    bq.create(
        TableInfo.of(
            orders,
            StandardTableDefinition.of(
                Schema.of(
                    Field.of("region", StandardSQLTypeName.STRING),
                    Field.of("amount", StandardSQLTypeName.INT64)))));
    bq.insertAll(
        InsertAllRequest.newBuilder(orders)
            .addRow(Map.of("region", "east", "amount", 1))
            .addRow(Map.of("region", "east", "amount", 2))
            .build());
    Emu.rows(
        bq,
        "CREATE MATERIALIZED VIEW `"
            + project
            + ".ds.east_total` AS SELECT SUM(amount) AS total FROM `"
            + project
            + ".ds.orders` WHERE region = 'east'");

    assertEquals(
        3L,
        Emu.rows(bq, "SELECT total FROM `" + project + ".ds.east_total`")
            .get(0)
            .get("total")
            .getLongValue());

    bq.insertAll(
        InsertAllRequest.newBuilder(orders).addRow(Map.of("region", "east", "amount", 10)).build());
    assertEquals(
        3L,
        Emu.rows(bq, "SELECT total FROM `" + project + ".ds.east_total`")
            .get(0)
            .get("total")
            .getLongValue());

    Emu.rows(bq, "CALL BQ.REFRESH_MATERIALIZED_VIEW('" + project + ".ds.east_total')");
    assertEquals(
        13L,
        Emu.rows(bq, "SELECT total FROM `" + project + ".ds.east_total`")
            .get(0)
            .get("total")
            .getLongValue());
  }

  @Test
  void routinesRestGetAndList() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    bq.create(DatasetInfo.newBuilder("ds").build());
    Emu.rows(bq, "CREATE FUNCTION `" + project + ".ds.tripler`(x INT64) RETURNS INT64 AS (x * 3)");

    List<String> names = new ArrayList<>();
    bq.listRoutines(DatasetId.of(project, "ds"))
        .iterateAll()
        .forEach(r -> names.add(r.getRoutineId().getRoutine()));
    assertEquals(List.of("tripler"), names);

    Routine fetched = bq.getRoutine(RoutineId.of(project, "ds", "tripler"));
    assertEquals("x * 3", fetched.getBody());
  }
}

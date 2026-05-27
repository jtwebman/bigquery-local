package local.bigquery;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.cloud.bigquery.BigQuery;
import com.google.cloud.bigquery.DatasetInfo;
import com.google.cloud.bigquery.Field;
import com.google.cloud.bigquery.FieldElementType;
import com.google.cloud.bigquery.FieldValue;
import com.google.cloud.bigquery.FieldValueList;
import com.google.cloud.bigquery.InsertAllRequest;
import com.google.cloud.bigquery.Job;
import com.google.cloud.bigquery.JobInfo;
import com.google.cloud.bigquery.JobStatistics.QueryStatistics;
import com.google.cloud.bigquery.QueryJobConfiguration;
import com.google.cloud.bigquery.QueryParameterValue;
import com.google.cloud.bigquery.Schema;
import com.google.cloud.bigquery.StandardSQLTypeName;
import com.google.cloud.bigquery.StandardTableDefinition;
import com.google.cloud.bigquery.TableId;
import com.google.cloud.bigquery.TableInfo;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** SQL feature coverage (params, DML, MERGE/QUALIFY/PIVOT, scripts, …) — mirrors sql_features_test.go. */
class SqlFeaturesTest {
  private static String seedOrders(BigQuery bq, String project) {
    bq.create(DatasetInfo.newBuilder("ds").build());
    TableId orders = TableId.of("ds", "orders");
    bq.create(
        TableInfo.of(
            orders,
            StandardTableDefinition.of(
                Schema.of(
                    Field.of("region", StandardSQLTypeName.STRING),
                    Field.of("product", StandardSQLTypeName.STRING),
                    Field.of("amount", StandardSQLTypeName.INT64)))));
    bq.insertAll(
        InsertAllRequest.newBuilder(orders)
            .addRow(Map.of("region", "east", "product", "a", "amount", 10))
            .addRow(Map.of("region", "east", "product", "b", "amount", 20))
            .addRow(Map.of("region", "east", "product", "c", "amount", 5))
            .addRow(Map.of("region", "west", "product", "a", "amount", 30))
            .addRow(Map.of("region", "west", "product", "b", "amount", 40))
            .build());
    return project + ".ds.orders";
  }

  private static QueryJobConfiguration.Builder query(String sql) {
    return QueryJobConfiguration.newBuilder(sql).setUseLegacySql(false);
  }

  @Test
  void namedScalarIntParameter() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    String fqn = seedOrders(bq, project);
    List<FieldValueList> rows =
        Emu.rows(
            bq,
            query("SELECT count(*) AS n FROM `" + fqn + "` WHERE amount >= @threshold")
                .addNamedParameter("threshold", QueryParameterValue.int64(20L))
                .build());
    assertEquals(3L, rows.get(0).get("n").getLongValue());
  }

  @Test
  void namedScalarStringParameter() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    String fqn = seedOrders(bq, project);
    List<FieldValueList> rows =
        Emu.rows(
            bq,
            query("SELECT count(*) AS n FROM `" + fqn + "` WHERE region = @r")
                .addNamedParameter("r", QueryParameterValue.string("east"))
                .build());
    assertEquals(3L, rows.get(0).get("n").getLongValue());
  }

  @Test
  void arrayParameterUnnest() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    String fqn = seedOrders(bq, project);
    List<FieldValueList> rows =
        Emu.rows(
            bq,
            query("SELECT amount FROM `" + fqn + "` WHERE amount IN UNNEST(@targets) ORDER BY amount")
                .addNamedParameter(
                    "targets", QueryParameterValue.array(new Long[] {10L, 30L}, Long.class))
                .build());
    assertEquals(10L, rows.get(0).get("amount").getLongValue());
    assertEquals(30L, rows.get(1).get("amount").getLongValue());
  }

  @Test
  void mergeInsertsAndUpdates() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    String fqn = seedOrders(bq, project);
    Emu.rows(
        bq,
        "MERGE INTO `"
            + fqn
            + "` AS target USING (SELECT 'east' AS region, 'a' AS product, 999 AS amount) AS src "
            + "ON target.region = src.region AND target.product = src.product "
            + "WHEN MATCHED THEN UPDATE SET amount = src.amount "
            + "WHEN NOT MATCHED THEN INSERT (region, product, amount) VALUES (src.region, src.product, src.amount)");
    List<FieldValueList> rows =
        Emu.rows(bq, "SELECT amount FROM `" + fqn + "` WHERE region = 'east' AND product = 'a'");
    assertEquals(999L, rows.get(0).get("amount").getLongValue());
  }

  @Test
  void qualifyRowNumberPerPartition() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    String fqn = seedOrders(bq, project);
    List<FieldValueList> rows =
        Emu.rows(
            bq,
            "SELECT region, product, amount FROM `"
                + fqn
                + "` QUALIFY ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC) = 1 ORDER BY region");
    assertEquals("east", rows.get(0).get("region").getStringValue());
    assertEquals("b", rows.get(0).get("product").getStringValue());
    assertEquals("west", rows.get(1).get("region").getStringValue());
    assertEquals("b", rows.get(1).get("product").getStringValue());
  }

  @Test
  void pivot() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    String fqn = seedOrders(bq, project);
    List<FieldValueList> rows =
        Emu.rows(
            bq,
            "SELECT * FROM (SELECT region, product, amount FROM `"
                + fqn
                + "`) PIVOT (SUM(amount) FOR product IN ('a', 'b', 'c')) ORDER BY region");
    assertEquals(2, rows.size());
    FieldValueList east = rows.get(0);
    assertEquals("east", east.get(0).getStringValue());
    assertEquals(10L, east.get(1).getLongValue());
    assertEquals(20L, east.get(2).getLongValue());
    assertEquals(5L, east.get(3).getLongValue());
  }

  @Test
  void cteAndWindow() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    String fqn = seedOrders(bq, project);
    List<FieldValueList> rows =
        Emu.rows(
            bq,
            "WITH ranked AS (SELECT region, product, amount, "
                + "RANK() OVER (PARTITION BY region ORDER BY amount DESC) AS r FROM `"
                + fqn
                + "`) SELECT region, product FROM ranked WHERE r = 1 ORDER BY region");
    for (FieldValueList r : rows) {
      assertEquals("b", r.get("product").getStringValue());
    }
  }

  @Test
  void approxCountDistinct() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    String fqn = seedOrders(bq, project);
    List<FieldValueList> rows =
        Emu.rows(bq, "SELECT APPROX_COUNT_DISTINCT(product) AS n FROM `" + fqn + "`");
    assertEquals(3L, rows.get(0).get("n").getLongValue());
  }

  @Test
  void arrayAggAndUnnest() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    String fqn = seedOrders(bq, project);
    List<FieldValueList> rows =
        Emu.rows(
            bq,
            "SELECT region, ARRAY_AGG(product ORDER BY product) AS products FROM `"
                + fqn
                + "` GROUP BY region ORDER BY region");
    List<FieldValue> east = rows.get(0).get("products").getRepeatedValue();
    assertEquals(3, east.size());
    assertEquals("a", east.get(0).getStringValue());
    assertEquals("b", east.get(1).getStringValue());
    assertEquals("c", east.get(2).getStringValue());
  }

  @Test
  void jsonValue() throws Exception {
    List<FieldValueList> rows =
        Emu.rows(
            Emu.client(Emu.uniqueProject()),
            "SELECT JSON_VALUE('{\"a\":{\"b\":\"hello\"}}', '$.a.b') AS v");
    assertEquals("hello", rows.get(0).get("v").getStringValue());
  }

  @Test
  void geographyStoreAndIntersects() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    bq.create(DatasetInfo.newBuilder("ds").build());
    TableId places = TableId.of("ds", "places");
    bq.create(
        TableInfo.of(
            places,
            StandardTableDefinition.of(
                Schema.of(
                    Field.of("id", StandardSQLTypeName.INT64),
                    Field.of("loc", StandardSQLTypeName.GEOGRAPHY)))));
    bq.insertAll(
        InsertAllRequest.newBuilder(places)
            .addRow(Map.of("id", 1, "loc", "POINT(5 5)"))
            .addRow(Map.of("id", 2, "loc", "POINT(100 100)"))
            .build());
    List<FieldValueList> rows =
        Emu.rows(
            bq,
            "SELECT id FROM `ds.places` WHERE ST_INTERSECTS(loc, "
                + "ST_GEOGFROMTEXT('POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))')) ORDER BY id");
    assertEquals(1, rows.size());
    assertEquals(1L, rows.get(0).get("id").getLongValue());
  }

  @Test
  void rangeColumnRoundTrip() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    bq.create(DatasetInfo.newBuilder("ds").build());
    TableId subs = TableId.of("ds", "subs");
    bq.create(
        TableInfo.of(
            subs,
            StandardTableDefinition.of(
                Schema.of(
                    Field.of("id", StandardSQLTypeName.INT64),
                    Field.newBuilder("validity", StandardSQLTypeName.RANGE)
                        .setRangeElementType(FieldElementType.newBuilder().setType("DATE").build())
                        .build()))));
    bq.insertAll(
        InsertAllRequest.newBuilder(subs)
            .addRow(Map.of("id", 1, "validity", "[2025-01-01, 2026-01-01)"))
            .addRow(Map.of("id", 2, "validity", "[2025-06-01, UNBOUNDED)"))
            .build());
    List<FieldValueList> rows = Emu.rows(bq, "SELECT id FROM `ds.subs` ORDER BY id");
    assertEquals(2, rows.size());
  }

  @Test
  void intervalRoundTrip() throws Exception {
    List<FieldValueList> rows =
        Emu.rows(
            Emu.client(Emu.uniqueProject()),
            query("SELECT @i AS got")
                .addNamedParameter("i", QueryParameterValue.interval("1-2 3 4:5:6"))
                .build());
    assertNotNull(rows.get(0).get("got").getValue());
  }

  @Test
  void timestampArithmetic() throws Exception {
    List<FieldValueList> rows =
        Emu.rows(
            Emu.client(Emu.uniqueProject()),
            "SELECT TIMESTAMP_DIFF(TIMESTAMP '2026-05-25T00:00:00Z', "
                + "TIMESTAMP '2026-05-24T00:00:00Z', HOUR) AS hours");
    assertEquals(24L, rows.get(0).get("hours").getLongValue());
  }

  @Test
  void insertUpdateDelete() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    String fqn = seedOrders(bq, project);
    Emu.rows(bq, "INSERT INTO `" + fqn + "` (region, product, amount) VALUES ('south', 'z', 7)");
    Emu.rows(bq, "UPDATE `" + fqn + "` SET amount = 8 WHERE region = 'south'");
    Emu.rows(bq, "DELETE FROM `" + fqn + "` WHERE region = 'south'");
    List<FieldValueList> rows =
        Emu.rows(bq, "SELECT count(*) AS n FROM `" + fqn + "` WHERE region = 'south'");
    assertEquals(0L, rows.get(0).get("n").getLongValue());
  }

  @Test
  void truncateTablePreservesSchema() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    String fqn = seedOrders(bq, project);
    Emu.rows(bq, "TRUNCATE TABLE `" + fqn + "`");
    assertEquals(
        0L, Emu.rows(bq, "SELECT count(*) AS n FROM `" + fqn + "`").get(0).get("n").getLongValue());
    List<FieldValueList> cols =
        Emu.rows(
            bq,
            "SELECT column_name FROM `"
                + project
                + ".ds`.INFORMATION_SCHEMA.COLUMNS WHERE table_name = 'orders' ORDER BY ordinal_position");
    assertEquals("region", cols.get(0).get("column_name").getStringValue());
    assertEquals("product", cols.get(1).get("column_name").getStringValue());
    assertEquals("amount", cols.get(2).get("column_name").getStringValue());
  }

  @Test
  void multiStatementScript() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    String fqn = seedOrders(bq, project);
    Emu.rows(
        bq,
        "BEGIN DECLARE total INT64 DEFAULT 0; "
            + "SET total = (SELECT SUM(amount) FROM `"
            + fqn
            + "`); "
            + "INSERT INTO `"
            + fqn
            + "` (region, product, amount) VALUES ('total', 'sum', total); END;");
    List<FieldValueList> rows =
        Emu.rows(bq, "SELECT amount FROM `" + fqn + "` WHERE region = 'total'");
    assertEquals(105L, rows.get(0).get("amount").getLongValue());
  }

  @Test
  void transactionCommit() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    String fqn = seedOrders(bq, project);
    Emu.rows(
        bq,
        "BEGIN TRANSACTION; INSERT INTO `"
            + fqn
            + "` (region, product, amount) VALUES ('north', 'x', 1); COMMIT;");
    List<FieldValueList> rows =
        Emu.rows(bq, "SELECT count(*) AS n FROM `" + fqn + "` WHERE region = 'north'");
    assertEquals(1L, rows.get(0).get("n").getLongValue());
  }

  @Test
  void dryRunReportsBytes() {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    String fqn = seedOrders(bq, project);
    QueryJobConfiguration cfg =
        query("SELECT * FROM `" + fqn + "`").setDryRun(true).setUseQueryCache(false).build();
    Job job = bq.create(JobInfo.of(cfg));
    QueryStatistics stats = job.getStatistics();
    assertTrue(stats.getTotalBytesProcessed() > 0);
  }

  @Test
  void wildcardTables() throws Exception {
    String project = Emu.uniqueProject();
    BigQuery bq = Emu.client(project);
    bq.create(DatasetInfo.newBuilder("ds").build());
    String[] suffixes = {"20260101", "20260102", "20260103"};
    for (int i = 0; i < suffixes.length; i++) {
      TableId t = TableId.of("ds", "events_" + suffixes[i]);
      bq.create(
          TableInfo.of(
              t, StandardTableDefinition.of(Schema.of(Field.of("id", StandardSQLTypeName.INT64)))));
      bq.insertAll(InsertAllRequest.newBuilder(t).addRow(Map.of("id", i + 1)).build());
    }
    List<FieldValueList> rows =
        Emu.rows(
            bq,
            "SELECT _TABLE_SUFFIX AS suf, id FROM `" + project + ".ds.events_*` ORDER BY suf");
    assertEquals(3, rows.size());
    assertEquals("20260101", rows.get(0).get("suf").getStringValue());
    assertEquals(1L, rows.get(0).get("id").getLongValue());
    assertEquals("20260103", rows.get(2).get("suf").getStringValue());
    assertEquals(3L, rows.get(2).get("id").getLongValue());
  }
}

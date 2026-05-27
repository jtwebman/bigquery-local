package local.bigquery;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.cloud.NoCredentials;
import com.google.cloud.bigquery.BigQuery;
import com.google.cloud.bigquery.BigQueryException;
import com.google.cloud.bigquery.BigQueryOptions;
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
import com.google.cloud.bigquery.TableResult;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Runs the official google-cloud-bigquery Java client against the
 * bigquery-local emulator. Spawns `node src/cli.ts` once, points the client at
 * the printed URL with NoCredentials, and tears the process down at the end.
 */
class BigQueryClientTest {
  private static Process emulator;
  private static String emulatorUrl;

  @BeforeAll
  static void startEmulator() throws Exception {
    // surefire runs with cwd = this module (test/clients/java); repo root is 3 up.
    Path repoRoot = Paths.get("").toAbsolutePath().getParent().getParent().getParent();
    ProcessBuilder pb =
        new ProcessBuilder(
            "node", "--conditions=src", "src/cli.ts", "--port=0", "--grpc-port=0",
            "--database=:memory:");
    pb.directory(repoRoot.toFile());
    pb.redirectErrorStream(true);
    emulator = pb.start();

    BufferedReader reader =
        new BufferedReader(new InputStreamReader(emulator.getInputStream(), StandardCharsets.UTF_8));
    Pattern listening = Pattern.compile("listening on (\\S+)");
    long deadline = System.currentTimeMillis() + 30_000;
    while (System.currentTimeMillis() < deadline) {
      String line = reader.readLine();
      if (line == null) {
        if (!emulator.isAlive()) {
          throw new IllegalStateException("emulator exited before listening");
        }
        continue;
      }
      Matcher m = listening.matcher(line);
      if (m.find()) {
        emulatorUrl = m.group(1);
        // Keep draining stdout so the pipe never fills and blocks the process.
        Thread drain =
            new Thread(
                () -> {
                  try {
                    while (reader.readLine() != null) {
                      // discard
                    }
                  } catch (Exception ignored) {
                    // process exiting
                  }
                });
        drain.setDaemon(true);
        drain.start();
        break;
      }
    }
    if (emulatorUrl == null) {
      throw new IllegalStateException("emulator did not print a listening URL within timeout");
    }
  }

  @AfterAll
  static void stopEmulator() {
    if (emulator != null) {
      emulator.destroyForcibly();
    }
  }

  private static BigQuery client(String project) {
    return BigQueryOptions.newBuilder()
        .setProjectId(project)
        .setHost(emulatorUrl)
        .setCredentials(NoCredentials.getInstance())
        .build()
        .getService();
  }

  private static String uniqueProject() {
    return "java-" + UUID.randomUUID().toString().substring(0, 8);
  }

  @Test
  void simpleQuery() throws Exception {
    BigQuery bq = client(uniqueProject());
    TableResult result =
        bq.query(
            QueryJobConfiguration.newBuilder("SELECT 1 AS one, 'hi' AS greeting")
                .setUseLegacySql(false)
                .build());
    FieldValueList row = result.iterateAll().iterator().next();
    assertEquals(1L, row.get("one").getLongValue());
    assertEquals("hi", row.get("greeting").getStringValue());
  }

  @Test
  void datasetCrud() {
    String project = uniqueProject();
    BigQuery bq = client(project);
    Dataset created =
        bq.create(DatasetInfo.newBuilder("ds").setDescription("java-test").build());
    assertEquals("java-test", created.getDescription());

    Dataset got = bq.getDataset("ds");
    assertNotNull(got);
    assertEquals("java-test", got.getDescription());

    boolean deleted =
        bq.delete(DatasetId.of(project, "ds"), BigQuery.DatasetDeleteOption.deleteContents());
    assertTrue(deleted);
  }

  @Test
  void tableCreateInsertQuery() throws Exception {
    String project = uniqueProject();
    BigQuery bq = client(project);
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

    TableResult result =
        bq.query(
            QueryJobConfiguration.newBuilder(
                    "SELECT id, name, active FROM `ds.users` ORDER BY id")
                .setUseLegacySql(false)
                .build());
    List<FieldValueList> rows = new ArrayList<>();
    result.iterateAll().forEach(rows::add);

    assertEquals(2, rows.size());
    assertEquals(1L, rows.get(0).get("id").getLongValue());
    assertEquals("Alice", rows.get(0).get("name").getStringValue());
    assertTrue(rows.get(0).get("active").getBooleanValue());
    assertEquals(2L, rows.get(1).get("id").getLongValue());
    assertEquals("Bob", rows.get(1).get("name").getStringValue());
    assertFalse(rows.get(1).get("active").getBooleanValue());
  }

  @Test
  void missingTableErrors() {
    BigQuery bq = client(uniqueProject());
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

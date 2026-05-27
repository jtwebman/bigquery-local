package local.bigquery;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import com.google.cloud.bigquery.BigQuery;
import com.google.cloud.bigquery.Dataset;
import com.google.cloud.bigquery.DatasetInfo;
import com.google.cloud.bigquery.Field;
import com.google.cloud.bigquery.Job;
import com.google.cloud.bigquery.JobInfo;
import com.google.cloud.bigquery.JobStatistics.QueryStatistics;
import com.google.cloud.bigquery.QueryJobConfiguration;
import com.google.cloud.bigquery.Schema;
import com.google.cloud.bigquery.StandardSQLTypeName;
import com.google.cloud.bigquery.StandardTableDefinition;
import com.google.cloud.bigquery.Table;
import com.google.cloud.bigquery.TableId;
import com.google.cloud.bigquery.TableInfo;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Labels, dataset locations, query cache, multi-project — mirrors advanced_test.go. */
class AdvancedTest {
  @Test
  void tableLabelsRoundTripViaCreateAndPatch() {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    bq.create(DatasetInfo.newBuilder("ds").build());
    TableId tableId = TableId.of("ds", "t");
    bq.create(
        TableInfo.newBuilder(
                tableId,
                StandardTableDefinition.of(Schema.of(Field.of("id", StandardSQLTypeName.INT64))))
            .setLabels(Map.of("team", "platform", "env", "test"))
            .build());

    Table tbl = bq.getTable(tableId);
    assertEquals("platform", tbl.getLabels().get("team"));
    assertEquals("test", tbl.getLabels().get("env"));

    // PATCH replaces labels: keep team (changed), drop env.
    bq.update(tbl.toBuilder().setLabels(Map.of("team", "data")).build());
    Table after = bq.getTable(tableId);
    assertEquals("data", after.getLabels().get("team"));
    assertFalse(after.getLabels().containsKey("env"));
  }

  @Test
  void jobLabelsRoundTrip() throws Exception {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    QueryJobConfiguration cfg =
        QueryJobConfiguration.newBuilder("SELECT 1 AS one")
            .setUseLegacySql(false)
            .setLabels(Map.of("owner", "java-test", "priority", "low"))
            .build();
    Job job = bq.create(JobInfo.of(cfg)).waitFor();
    Job fetched = bq.getJob(job.getJobId());
    QueryJobConfiguration fc = fetched.getConfiguration();
    assertEquals("java-test", fc.getLabels().get("owner"));
    assertEquals("low", fc.getLabels().get("priority"));
  }

  @Test
  void datasetLocationRoundTrip() {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    bq.create(DatasetInfo.newBuilder("eu_ds").setLocation("EU").build());
    Dataset md = bq.getDataset("eu_ds");
    assertEquals("EU", md.getLocation());
  }

  @Test
  void useQueryCacheDefaultHitsOnSecondRun() throws Exception {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    String sql = "SELECT 'java-cache' AS marker, 1 AS one";
    Job first = bq.create(JobInfo.of(query(sql))).waitFor();
    QueryStatistics s1 = first.getStatistics();
    assertNotEquals(Boolean.TRUE, s1.getCacheHit());

    Job second = bq.create(JobInfo.of(query(sql))).waitFor();
    QueryStatistics s2 = second.getStatistics();
    assertEquals(Boolean.TRUE, s2.getCacheHit());
  }

  @Test
  void useQueryCacheFalseBypasses() throws Exception {
    BigQuery bq = Emu.client(Emu.uniqueProject());
    String sql = "SELECT 'java-cache-bypass' AS marker";
    bq.create(JobInfo.of(query(sql))).waitFor();

    QueryJobConfiguration bypass =
        QueryJobConfiguration.newBuilder(sql).setUseLegacySql(false).setUseQueryCache(false).build();
    Job job = bq.create(JobInfo.of(bypass)).waitFor();
    QueryStatistics stats = job.getStatistics();
    assertNotEquals(Boolean.TRUE, stats.getCacheHit());
  }

  @Test
  void twoProjectsCanHaveSameDatasetId() {
    String base = Emu.uniqueProject();
    BigQuery a = Emu.client(base + "a");
    BigQuery b = Emu.client(base + "b");
    a.create(DatasetInfo.newBuilder("ds").build());
    b.create(DatasetInfo.newBuilder("ds").build());
    assertEquals(List.of("ds"), datasetIds(a, base + "a"));
    assertEquals(List.of("ds"), datasetIds(b, base + "b"));
  }

  private static QueryJobConfiguration query(String sql) {
    return QueryJobConfiguration.newBuilder(sql).setUseLegacySql(false).build();
  }

  private static List<String> datasetIds(BigQuery bq, String project) {
    List<String> names = new ArrayList<>();
    bq.listDatasets(project).iterateAll().forEach(d -> names.add(d.getDatasetId().getDataset()));
    return names;
  }
}

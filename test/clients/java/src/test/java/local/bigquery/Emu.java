package local.bigquery;

import com.google.cloud.NoCredentials;
import com.google.cloud.bigquery.BigQuery;
import com.google.cloud.bigquery.BigQueryOptions;
import com.google.cloud.bigquery.FieldValueList;
import com.google.cloud.bigquery.QueryJobConfiguration;
import com.google.cloud.bigquery.TableResult;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Shared emulator harness for the Java client tests. One emulator is spawned
 * lazily on first use and torn down by a JVM shutdown hook, so every test
 * class shares it (mirrors the Go TestMain / Python session fixture). Each
 * test uses a unique project id for isolation.
 */
final class Emu {
  private static String url;
  private static Process process;

  private Emu() {}

  static synchronized String url() {
    if (url == null) {
      start();
    }
    return url;
  }

  private static void start() {
    try {
      // surefire cwd = this module (test/clients/java); repo root is 3 up.
      Path repoRoot = Paths.get("").toAbsolutePath().getParent().getParent().getParent();
      ProcessBuilder pb =
          new ProcessBuilder(
              "node", "--conditions=src", "src/cli.ts", "--port=0", "--grpc-port=0",
              "--database=:memory:");
      pb.directory(repoRoot.toFile());
      pb.redirectErrorStream(true);
      process = pb.start();

      BufferedReader reader =
          new BufferedReader(
              new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
      Pattern listening = Pattern.compile("listening on (\\S+)");
      long deadline = System.currentTimeMillis() + 30_000;
      while (System.currentTimeMillis() < deadline) {
        String line = reader.readLine();
        if (line == null) {
          if (!process.isAlive()) {
            throw new IllegalStateException("emulator exited before listening");
          }
          continue;
        }
        Matcher m = listening.matcher(line);
        if (m.find()) {
          url = m.group(1);
          break;
        }
      }
      if (url == null) {
        throw new IllegalStateException("emulator did not print a listening URL within timeout");
      }
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
      Runtime.getRuntime().addShutdownHook(new Thread(() -> process.destroyForcibly()));
    } catch (Exception e) {
      throw new IllegalStateException("failed to start emulator", e);
    }
  }

  static BigQuery client(String project) {
    return BigQueryOptions.newBuilder()
        .setProjectId(project)
        .setHost(url())
        .setCredentials(NoCredentials.getInstance())
        .build()
        .getService();
  }

  static String uniqueProject() {
    return "java-" + UUID.randomUUID().toString().substring(0, 8);
  }

  /** Run a query (or statement) and collect the result rows. */
  static List<FieldValueList> rows(BigQuery bq, String sql) throws Exception {
    TableResult result =
        bq.query(QueryJobConfiguration.newBuilder(sql).setUseLegacySql(false).build());
    List<FieldValueList> out = new ArrayList<>();
    result.iterateAll().forEach(out::add);
    return out;
  }

  /** Raw GET against the emulator REST surface; returns the HTTP status. */
  static int httpGetStatus(String path) throws Exception {
    HttpResponse<String> resp =
        HttpClient.newHttpClient()
            .send(
                HttpRequest.newBuilder(URI.create(url() + path)).GET().build(),
                HttpResponse.BodyHandlers.ofString());
    return resp.statusCode();
  }
}
